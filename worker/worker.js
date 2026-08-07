/**
 * 投递清单 → Telegram 的中继 Worker。
 *
 * 页面（index.html）和油猴脚本都不持有 Bot Token，只把正文 POST 给这个 Worker。
 * Token 作为 Cloudflare Secret 保存，永远不会下发到浏览器。
 *
 *   浏览器 ──POST text──▶ Worker ──sendMessage(token)──▶ Telegram
 *
 * 除了立即发送，还支持「定时发送」：
 *   浏览器 ──action=schedule──▶ KV 队列 ──Cron 每 5 分钟扫描──▶ 到点发出
 * 静态页面自己做不到定时（关掉标签页就没人执行了），所以定时必须落在 Worker 上。
 *
 * 反方向还有一条：Telegram 群 / 频道里的消息回流到看板（channel.html）。
 *   Telegram ──webhook──▶ Worker ──▶ Durable Object（存档 + WebSocket 广播）
 *                                        ▲
 *                    channel.html ───────┘  WS 实时推送，断线时退回轮询
 *
 * 受理条件（收紧后，即使 Worker URL 泄漏也发不出任意内容）：
 *   - 只接受 POST（WebSocket 升级除外）
 *   - Origin 必须在 ALLOWED_ORIGINS 里
 *   - 正文必须以 "#SGJOB" 开头
 *   - 正文不超过 4096 字
 *   - 设置了 APP_KEY 时，X-App-Key 头必须一致（可选，建议开）
 *   - webhook 走单独的路径 + Telegram 的 secret_token 头，不看 Origin
 */

const TG_API = 'https://api.telegram.org';
const HEADER_PREFIX = '#SGJOB';
const MAX_LEN = 4096;
const MAX_QUEUE = 200;                 // 队列上限，防止被灌爆
const MAX_AHEAD_MS = 180 * 86400000;   // 最多排到 180 天后

const WEBHOOK_PATH = '/tg/webhook';    // Telegram 往这里 POST
const WS_PATH = '/channel/ws';         // channel.html 从这里连 WebSocket
const INBOX_MAX = 500;                 // 收件箱最多留这么多条
const INBOX_ROOM = 'main';             // 只有一个房间，DO 用固定名字

function corsHeaders(origin, allowed) {
  const permitted = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': permitted ? (origin || 'null') : 'https://example.invalid',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers)
  });
}

async function readBody(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    return await request.json().catch(() => ({}));
  }
  const form = await request.formData().catch(() => null);
  if (!form) return {};
  const out = {};
  for (const [k, v] of form.entries()) out[k] = String(v);
  return out;
}

async function tgSend(env, text) {
  const res = await fetch(`${TG_API}/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT, text: text, disable_web_page_preview: true })
  });
  return await res.json().catch(() => ({ ok: false, description: 'invalid response from Telegram' }));
}

/* ==========================================================================
 * 当日新情况的速报
 *   每天 JST 21:30 自动发一次；页面上的按钮也能提前手动发。
 *   两边都会往 KV 写一个当日标记，所以一天只会发出去一条。
 * ========================================================================== */

const REPORT_HOUR = 21;
const REPORT_MIN = 30;
const REPORT_TITLE = '当日新情况的速报';
// 这两种不算「新情况」：状态还停在「默认状态」（投完在等，没实质进展）的，
// 和当天刚投还没动过的。
// 状态名在油猴脚本里可以改，所以「默认状态是哪条」要看数据里推上来的
// statusDefs（role === 'default'）；没有定义时才退回这个内置名字。
const REPORT_SKIP_FALLBACK = '已投递等联络';

/** 这一批要跳过的状态名集合 */
function reportSkipSet(data) {
  const defs = (data && data.statusDefs) || [];
  const hit = defs.filter((d) => d && d.role === 'default').map((d) => d.name);
  const out = Object.create(null);
  (hit.length ? hit : [REPORT_SKIP_FALLBACK]).forEach((n) => { out[n] = 1; });
  return out;
}

// 内置的状态顺位，和油猴脚本 / build.py 里的 STATUSES 一致。
// 数据源里带了 statusOrder 就以它为准（用户可能拖动调整过）。
const DEFAULT_STATUS_ORDER = [
  '等己方处理(XR ball)',
  '等己方处理(己 ball)',
  '已安排面试、面试准备中',
  '対方来联络了',
  '四次面试通过、等对方安排下一轮',
  '三次面试通过、等对方安排下一轮',
  '二次面试通过、等对方安排下一轮',
  '一次面试通过、等対方安排下一轮',
  '一次人事面谈结束、等对方联络',
  '内定',
  '人事 Offer Call',
  '已投递等联络',
  '面试落了',
  '书类落了',
  '对方招到人了',
  '无消息疑似书类落了'
];

/** JST 的今天，形如 2026-08-06 */
function jstDate(now) {
  return new Date((now || Date.now()) + 9 * 3600000).toISOString().slice(0, 10);
}

/** JST 当天 0 点对应的 UTC 毫秒 */
function jstDayStart(now) {
  const d = jstDate(now);
  return Date.parse(d + 'T00:00:00+09:00');
}

/**
 * 前一天 JST 21:30 对应的 UTC 毫秒（= 当天 JST 零点往前推 2.5 小时）。
 *
 * 定时发送在 21:30，窗口若按自然日算（00:00–24:00），那么 21:30 到零点之间
 * 发生的变化今天的速报赶不上、明天的窗口又不包含，就永远漏掉了。
 * 所以窗口的默认起点是「前一日 21:30」，正好接上上一批。
 */
function prevReportBoundary(now) {
  return jstDayStart(now) - 86400000 + (REPORT_HOUR * 60 + REPORT_MIN) * 60000;
}

function reportKey(now) { return 'report:' + jstDate(now); }
const REPORT_CURSOR_KEY = 'report:cursor';   // 上一批速报统计到哪个时刻为止
// 「今天没有新情况」的节流标记，和「已发过」分开存：
// 否则一旦定时那一轮扫到空，当天就再也发不出手动速报了。
function reportEmptyKey(now) { return 'reportempty:' + jstDate(now); }

async function reportSent(env, now) {
  if (!env.SCHEDULE) return null;
  return await env.SCHEDULE.get(reportKey(now));
}

async function markReportSent(env, now, by) {
  if (!env.SCHEDULE) return;
  // 留 3 天足够了，KV 到期自动清
  await env.SCHEDULE.put(reportKey(now), JSON.stringify({ at: Date.now(), by: by || 'auto' }),
    { expirationTtl: 3 * 86400 });
}

/**
 * 这一批的统计起点。
 * 上一批发到哪个时刻就从哪儿接着算，接不上（首次运行 / 游标过期 / 明显不合理）
 * 才退回「前一日 21:30」。这样手动提前发过之后，那天剩下的变化也不会被漏掉。
 */
async function reportWindowStart(env, now) {
  const fallback = prevReportBoundary(now);
  if (!env.SCHEDULE) return fallback;
  const raw = await env.SCHEDULE.get(REPORT_CURSOR_KEY);
  if (!raw) return fallback;
  let at = 0;
  try { at = Number(JSON.parse(raw).at) || 0; } catch (e) { at = 0; }
  // 游标太旧（超过 7 天没发过）就别把一大堆陈年变化翻出来
  if (!at || at > now || at < now - 7 * 86400000) return fallback;
  return at;
}

/** 记下这一批统计到哪儿为止，下一批从这里接着算 */
async function saveReportCursor(env, end) {
  if (!env.SCHEDULE) return;
  await env.SCHEDULE.put(REPORT_CURSOR_KEY, JSON.stringify({ at: end }),
    { expirationTtl: 30 * 86400 });
}

/** 拉取看板数据源（油猴脚本推上去的那份 records.json） */
async function fetchRecords(env) {
  const url = env.RECORDS_URL;
  if (!url) return null;
  const res = await fetch(url, { headers: { 'User-Agent': 'sgjob-worker' } });
  if (!res.ok) return null;
  const blob = await res.json().catch(() => null);
  if (!blob) return null;
  if (Array.isArray(blob)) return { records: blob, statusOrder: DEFAULT_STATUS_ORDER, statusDefs: [] };
  const defs = Array.isArray(blob.statusDefs) ? blob.statusDefs : [];
  // 顺位优先用 statusDefs（它才是权威），退而求其次用 statusOrder，最后才是内置顺序
  let order = defs.length ? defs.map((d) => d && d.name).filter(Boolean) : [];
  if (!order.length) {
    order = Array.isArray(blob.statusOrder) && blob.statusOrder.length
      ? blob.statusOrder : DEFAULT_STATUS_ORDER;
  }
  return { records: blob.records || [], statusOrder: order, statusDefs: defs };
}

/**
 * 清单里的显示顺位：重要度最优先，其次状态顺位，最后更新时间从新到旧。
 * 和 index.html / 油猴清单里看到的顺序一致。
 */
function listOrderComparator(statusOrder) {
  const rank = new Map();
  (statusOrder || DEFAULT_STATUS_ORDER).forEach((s, i) => rank.set(s, i));
  const rankOf = (s) => (rank.has(s) ? rank.get(s) : rank.size);
  return (a, b) => {
    const p = (Number(b.priority) || 0) - (Number(a.priority) || 0);
    if (p !== 0) return p;
    const d = rankOf(a.status) - rankOf(b.status);
    if (d !== 0) return d;
    return (b.updatedAt || b.ts || 0) - (a.updatedAt || a.ts || 0);
  };
}

/**
 * 把这一批窗口内有状态变化的记录整理成一条简报。
 * 没有变化就返回 null —— 没消息就不发，别每天定时打扰。
 */
function buildReport(data, now, boardUrl, start) {
  const records = (data && data.records) || [];
  const end = now || Date.now();
  const skip = reportSkipSet(data);
  const hits = records.filter((r) => {
    if (!r || !r.updatedAt) return false;                 // 没改过（含当天新投的）
    if (r.updatedAt < start || r.updatedAt > end) return false;
    return !skip[r.status];
  });
  if (!hits.length) return null;

  // 按状态归类；组的先后与组内顺序都照清单里的显示顺位来。
  // statusDefs 才是权威顺位，没有才退到 statusOrder，再没有就用内置顺序。
  const defOrder = ((data && data.statusDefs) || []).map((d) => d && d.name).filter(Boolean);
  const cmp = listOrderComparator(defOrder.length ? defOrder : (data && data.statusOrder));
  const groups = new Map();
  hits.sort(cmp).forEach((r) => {
    if (!groups.has(r.status)) groups.set(r.status, []);
    groups.get(r.status).push(r);
  });

  const fmt = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  const lines = [
    HEADER_PREFIX + ' ' + REPORT_TITLE,
    jstDate(now) + '（JST）　共 ' + hits.length + ' 家有新情况',
    '统计范围：' + fmt(start) + ' ～ ' + fmt(end) + '（JST）'
  ];
  for (const [status, list] of groups) {
    lines.push('', '▸ ' + status + '（' + list.length + '）');
    list.forEach((r) => {
      const star = (Number(r.priority) || 0) ? ('  ' + '✨'.repeat(Number(r.priority))) : '';
      lines.push('  · ' + (r.company || '—') + ' / ' + (r.title || '—') + star);
      // 项目名下面直接附职位链接，省得再去看板上找
      if (r.jobUrl) lines.push('    ' + r.jobUrl);
      // 窗口内写的 MEMO 里挑最新的一条，截短了当作变化要点
      const memo = latestMemoOfDay(r, start, end);
      if (memo) lines.push('    ' + memo.slice(0, 120) + (memo.length > 120 ? '…' : ''));
    });
  }
  if (boardUrl) lines.push('', '看板：' + boardUrl);

  let text = lines.join('\n');
  if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN - 12) + '\n…（已截断）';
  return text;
}

function latestMemoOfDay(r, start, end) {
  const blocks = Array.isArray(r.memos) ? r.memos : [];
  const today = blocks
    .filter((b) => b && b.text && b.ts >= start && b.ts < end)
    .sort((a, b) => b.ts - a.ts);
  return today.length ? String(today[0].text).replace(/\s+/g, ' ').trim() : '';
}

/* ==========================================================================
 * Telegram 群 / 频道的消息 → 看板（channel.html）
 *
 * Bot API 的两个硬限制，先写在这里免得日后困惑：
 *   1. 拿不到 bot 加入之前的历史消息，只能从接上 webhook 那一刻起往后攒。
 *   2. 群里要收到普通消息，必须在 BotFather 里 /setprivacy → Disable
 *      （或者把 bot 设成管理员）；频道则必须把 bot 设成管理员。
 * ========================================================================== */

/** 把一条 update 压成看板要显示的样子；不关心的类型返回 null */
function parseUpdate(u) {
  if (!u || typeof u !== 'object') return null;
  const edited = u.edited_channel_post || u.edited_message;
  const m = u.channel_post || u.message || edited;
  if (!m || !m.chat) return null;

  const text = String(m.text || m.caption || '');
  // 纯媒体没有文字时，至少标出来是什么，别让消息凭空消失
  let kind = '';
  if (m.photo) kind = '🖼 图片';
  else if (m.video) kind = '🎬 视频';
  else if (m.animation) kind = '🎞 动图';
  else if (m.voice) kind = '🎤 语音';
  else if (m.audio) kind = '🎵 音频';
  else if (m.sticker) kind = '🩹 贴纸 ' + (m.sticker.emoji || '');
  else if (m.document) kind = '📎 文件 ' + (m.document.file_name || '');
  else if (m.poll) kind = '📊 投票 ' + (m.poll.question || '');
  else if (m.location) kind = '📍 位置';
  else if (m.new_chat_members) kind = '👋 有人加入';
  else if (m.left_chat_member) kind = '🚪 有人离开';
  else if (m.pinned_message) kind = '📌 置顶了一条消息';
  if (!text && !kind) return null;

  const from = m.from || {};
  const author = m.author_signature
    || [from.first_name, from.last_name].filter(Boolean).join(' ')
    || (from.username ? '@' + from.username : '')
    || (m.sender_chat && m.sender_chat.title) || '';

  const reply = m.reply_to_message;
  return {
    // 同一条消息被编辑时 uid 不变，前端按 uid 覆盖即可
    uid: String(m.chat.id) + ':' + m.message_id,
    chatId: String(m.chat.id),
    chatTitle: String(m.chat.title || m.chat.username || m.chat.first_name || ''),
    msgId: m.message_id,
    ts: (Number(m.date) || Math.floor(Date.now() / 1000)) * 1000,
    editedTs: edited ? Date.now() : 0,
    author: String(author).slice(0, 60),
    bot: !!from.is_bot,
    kind: kind.trim().slice(0, 60),
    text: text.slice(0, 4000),
    replyText: reply ? String(reply.text || reply.caption || '').slice(0, 120) : '',
  };
}

/** 收件箱的存储 key：零填充时间戳打头，list 出来就是时间序 */
function inboxKey(msg) {
  return 'in:' + String(msg.ts).padStart(13, '0') + ':' + msg.uid;
}

/** 拿到那个唯一的收件箱 DO；没绑定 DO 时返回 null（退回 KV） */
function inboxStub(env) {
  if (!env.INBOX) return null;
  return env.INBOX.get(env.INBOX.idFromName(INBOX_ROOM));
}

/* ---- KV 兜底实现 ----------------------------------------------------------
 * 没配 Durable Object（或迁移还没跑）时也要能用，只是新消息最多可能晚 60 秒
 * 才看得到 —— KV 是最终一致的，这是它的固有延迟，不是 bug。
 * -------------------------------------------------------------------------- */
async function kvInboxAppend(env, msg) {
  if (!env.SCHEDULE) return;
  await env.SCHEDULE.put(inboxKey(msg), JSON.stringify(msg),
    { expirationTtl: 180 * 86400 });
}

async function kvInboxList(env, since) {
  if (!env.SCHEDULE) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.SCHEDULE.list({ prefix: 'in:', limit: 1000, cursor: cursor });
    for (const k of page.keys) {
      const raw = await env.SCHEDULE.get(k.name);
      if (!raw) continue;
      try {
        const m = JSON.parse(raw);
        if (!since || (m.editedTs || m.ts) > since) out.push(m);
      } catch (e) { /* 坏数据跳过 */ }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-INBOX_MAX);
}

/**
 * 收件箱 Durable Object。
 * 单实例、强一致，写进来立刻就能读到；同时把新消息推给所有连着的页面，
 * 所以 channel.html 不用轮询也能秒级（实际是毫秒级）更新。
 */
export class ChannelInbox {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async append(msg) {
    await this.state.storage.put(inboxKey(msg), msg);
    // 超出上限就把最老的删掉，别让存储无限长
    const all = await this.state.storage.list({ prefix: 'in:' });
    if (all.size > INBOX_MAX) {
      const keys = [...all.keys()].slice(0, all.size - INBOX_MAX);
      await this.state.storage.delete(keys);
    }
    const payload = JSON.stringify({ type: 'msg', items: [msg] });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(payload); } catch (e) { /* 断了就断了，close 事件会清掉 */ }
    }
  }

  async list(since) {
    const all = await this.state.storage.list({ prefix: 'in:' });
    const out = [];
    for (const m of all.values()) {
      if (!since || (m.editedTs || m.ts) > since) out.push(m);
    }
    out.sort((a, b) => a.ts - b.ts);
    return out.slice(-INBOX_MAX);
  }

  async fetch(request) {
    // WebSocket 升级：外层是把**原样的** Request 转发进来的（Cloudflare 的标准做法），
    // 所以这里认 Upgrade 头，不认路径 —— 路径是浏览器那边的 /channel/ws。
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      // 用 hibernation API：没消息时 DO 可以被回收，不按连接时长计费
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const url = new URL(request.url);
    if (url.pathname === '/push') {
      const msg = await request.json().catch(() => null);
      if (!msg) return new Response('bad', { status: 400 });
      await this.append(msg);
      return new Response('ok');
    }

    // /list?since=<ms>
    const since = Number(url.searchParams.get('since') || 0);
    const items = await this.list(since);
    return new Response(JSON.stringify({ items: items }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  // hibernation 下的三个回调。前端只会发心跳，收到就原样回一个 pong。
  async webSocketMessage(ws, data) {
    if (String(data) === 'ping') { try { ws.send('pong'); } catch (e) {} }
  }
  async webSocketClose(ws, code, reason, wasClean) { try { ws.close(code, reason); } catch (e) {} }
  async webSocketError(ws) { /* 交给 close 处理 */ }
}

/** 一条 update 落库（DO 优先，没有就用 KV） */
async function inboxAppend(env, msg) {
  const stub = inboxStub(env);
  if (!stub) return await kvInboxAppend(env, msg);
  await stub.fetch('https://do/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg)
  });
}

async function inboxList(env, since) {
  const stub = inboxStub(env);
  if (!stub) return { items: await kvInboxList(env, since), live: false };
  const res = await stub.fetch('https://do/list?since=' + encodeURIComponent(since || 0));
  const data = await res.json().catch(() => ({ items: [] }));
  return { items: data.items || [], live: true };
}

/** 队列 key 用零填充的时间戳打头，KV 按字典序 list 出来就是按时间先后 */
function queueKey(at, id) {
  return 'sch:' + String(at).padStart(13, '0') + ':' + id;
}

async function listQueue(env, limit) {
  if (!env.SCHEDULE) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.SCHEDULE.list({ prefix: 'sch:', limit: 1000, cursor: cursor });
    for (const k of page.keys) {
      const raw = await env.SCHEDULE.get(k.name);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        item.key = k.name;
        out.push(item);
      } catch (e) { /* 坏数据直接跳过 */ }
      if (limit && out.length >= limit) return out;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

export default {
  async fetch(request, env) {
    const allowed = String(env.ALLOWED_ORIGINS || '*')
      .split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || 'null';
    const headers = corsHeaders(origin, allowed);
    const url = new URL(request.url);

    /* ---- Telegram webhook ------------------------------------------------
     * Telegram 不会带 Origin，也不会带 X-App-Key，所以这条路必须在下面那几道
     * 浏览器用的检查之前。身份靠两样东西：独立路径 + setWebhook 时设的
     * secret_token（Telegram 会放在 X-Telegram-Bot-Api-Secret-Token 头里）。
     * -------------------------------------------------------------------- */
    if (url.pathname === WEBHOOK_PATH) {
      if (request.method !== 'POST') return new Response('POST only', { status: 405 });
      if (!env.WEBHOOK_SECRET
          || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json().catch(() => null);
      const msg = parseUpdate(update);
      // 认不出来的 update 也回 200：回错误码 Telegram 会一直重投
      if (msg) {
        // 只收我们那个群 / 频道的，别人把 bot 拉进别的群也灌不进来
        if (!env.TG_CHAT || String(msg.chatId) === String(env.TG_CHAT)) {
          await inboxAppend(env, msg);
        }
      }
      return new Response('ok');
    }

    /* ---- channel.html 的 WebSocket ---- */
    if (url.pathname === WS_PATH) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({ ok: false, description: 'expected websocket upgrade' }, 426, headers);
      }
      if (!(allowed.includes('*') || allowed.includes(origin))) {
        return json({ ok: false, description: 'origin not allowed: ' + origin }, 403, headers);
      }
      const stub = inboxStub(env);
      if (!stub) return json({ ok: false, description: 'Durable Object 未绑定，请用轮询' }, 501, headers);
      return await stub.fetch(request);      // 原样转发，Upgrade 头必须留着
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: headers });
    }
    if (request.method !== 'POST') {
      return json({ ok: false, description: 'POST only' }, 405, headers);
    }
    if (!(allowed.includes('*') || allowed.includes(origin))) {
      return json({ ok: false, description: 'origin not allowed: ' + origin }, 403, headers);
    }
    if (env.APP_KEY && request.headers.get('X-App-Key') !== env.APP_KEY) {
      return json({ ok: false, description: 'bad app key' }, 403, headers);
    }

    const body = await readBody(request);
    const action = String(body.action || 'send');

    // ---- Claude 中继（判定公司的 EP 行业用）----
    // 这条路不需要 TG_TOKEN，所以放在下面那道检查之前。
    // API Key 存在 Worker 的 Secret 里，浏览器全程不接触密钥。
    if (action === 'ai') {
      if (!env.ANTHROPIC_API_KEY) {
        return json({ ok: false, description: 'ANTHROPIC_API_KEY 未配置在 Worker 上' }, 501, headers);
      }
      const payload = body.payload;
      if (!payload || typeof payload !== 'object') {
        return json({ ok: false, description: 'missing payload' }, 400, headers);
      }
      // 只放行分类这一种用法：限制模型和输出长度，避免 Worker 被人当免费 API 用
      payload.max_tokens = Math.min(Number(payload.max_tokens) || 1024, 4000);

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
        return json({ ok: false, description: msg }, res.status, headers);
      }
      return json({ ok: true, result: data }, 200, headers);
    }

    /* ---- 收件箱：channel.html 拉消息 ----
     * 这条不需要 TG_TOKEN（只读已经收下来的），所以放在下面那道检查之前。
     * since 传上一次拿到的最新时间戳，只回增量，轮询时几乎是空响应。 */
    if (action === 'inbox') {
      const since = Number(body.since || 0);
      const data = await inboxList(env, since);
      return json({
        ok: true,
        items: data.items,
        live: data.live,                       // true = 走 DO，可以开 WebSocket
        wsPath: data.live ? WS_PATH : '',
        hooked: !!env.WEBHOOK_SECRET,          // false = webhook 还没配，页面会提示
        now: Date.now()
      }, 200, headers);
    }

    // ---- 当日速报：状态 / 预览 / 发送 ----
    if (action === 'report_status' || action === 'report_preview' || action === 'report_send') {
      const sentRaw = await reportSent(env, Date.now());
      let sent = null;
      if (sentRaw) { try { sent = JSON.parse(sentRaw); } catch (e) { sent = { at: 0 }; } }

      if (action === 'report_status') {
        return json({ ok: true, date: jstDate(), sent: !!sent, sentAt: sent ? sent.at : 0 }, 200, headers);
      }

      const now = Date.now();
      const data = await fetchRecords(env);
      if (!data) {
        return json({ ok: false, description: 'RECORDS_URL 未配置或拉取失败' }, 501, headers);
      }
      const start = await reportWindowStart(env, now);
      const text = buildReport(data, now, env.BOARD_URL || '', start);

      if (action === 'report_preview') {
        return json({ ok: true, date: jstDate(), sent: !!sent, from: start, to: now, text: text || '' }, 200, headers);
      }
      // ---- report_send ----
      if (sent) {
        return json({ ok: false, description: '今天已经发过了（' + jstDate() + '）' }, 409, headers);
      }
      if (!text) {
        return json({ ok: false, description: '这一批没有新情况，不发' }, 200, headers);
      }
      if (!env.TG_TOKEN) {
        return json({ ok: false, description: 'TG_TOKEN is not configured on the worker' }, 500, headers);
      }
      const sendRes = await tgSend(env, text);
      if (sendRes.ok) {
        await markReportSent(env, now, 'manual');
        await saveReportCursor(env, now);   // 下一批从这里接着算，中间不留缝
      }
      return json(sendRes, sendRes.ok ? 200 : 502, headers);
    }

    // ---- 看板上勾选若干项目后发的「选中项目速报」----
    // 正文由页面组装（它手里就有完整清单），Worker 只负责转发；
    // 校验沿用下面那条通用路径的前缀 + 长度限制。

    if (!env.TG_TOKEN) {
      return json({ ok: false, description: 'TG_TOKEN is not configured on the worker' }, 500, headers);
    }

    // ---- 查询待发队列 ----
    if (action === 'list') {
      if (!env.SCHEDULE) return json({ ok: false, description: 'KV 未绑定，定时功能不可用' }, 501, headers);
      const items = await listQueue(env, MAX_QUEUE);
      items.sort((a, b) => a.at - b.at);
      return json({ ok: true, items: items.map(i => ({ id: i.id, at: i.at, text: i.text, meta: i.meta || {} })) }, 200, headers);
    }

    // ---- 取消 / 立刻发送 ----
    if (action === 'cancel' || action === 'sendnow') {
      if (!env.SCHEDULE) return json({ ok: false, description: 'KV 未绑定，定时功能不可用' }, 501, headers);
      const id = String(body.id || '');
      if (!id) return json({ ok: false, description: 'missing id' }, 400, headers);

      // KV 的 list 有最多 60 秒延迟，刚入队的条目扫不到。
      // 客户端手上有 at，就能直接拼出 key 精确读取，不必依赖 list。
      const at = Number(body.at || 0);
      let key = null, item = null;
      if (at) {
        key = queueKey(at, id);
        const raw = await env.SCHEDULE.get(key);
        if (raw) { try { item = JSON.parse(raw); } catch (e) { item = null; } }
      }
      if (!item) {                       // 回退：扫一遍队列
        const items = await listQueue(env, MAX_QUEUE);
        const hit = items.find(i => i.id === id);
        if (hit) { item = hit; key = hit.key; }
      }
      if (!item || !key) return json({ ok: false, description: 'not found' }, 404, headers);

      if (action === 'sendnow') {
        const data = await tgSend(env, item.text);
        if (!data.ok) return json(data, 502, headers);
      }
      await env.SCHEDULE.delete(key);
      return json({ ok: true }, 200, headers);
    }

    // ---- 以下两种都要带正文 ----
    const text = String(body.text || '');
    if (!text.startsWith(HEADER_PREFIX)) {
      return json({ ok: false, description: 'unexpected payload' }, 400, headers);
    }
    if (text.length > MAX_LEN) {
      return json({ ok: false, description: 'text too long' }, 413, headers);
    }

    // ---- 定时入队 ----
    if (action === 'schedule') {
      if (!env.SCHEDULE) return json({ ok: false, description: 'KV 未绑定，定时功能不可用' }, 501, headers);
      const at = Number(body.at);
      if (!at || !isFinite(at)) return json({ ok: false, description: 'missing at' }, 400, headers);
      if (at > Date.now() + MAX_AHEAD_MS) {
        return json({ ok: false, description: '排得太远了（最多 180 天）' }, 400, headers);
      }
      const existing = await listQueue(env, MAX_QUEUE + 1);
      if (existing.length >= MAX_QUEUE) {
        return json({ ok: false, description: '队列已满（上限 ' + MAX_QUEUE + ' 条）' }, 429, headers);
      }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      let meta = {};
      try { meta = body.meta ? JSON.parse(body.meta) : {}; } catch (e) { meta = {}; }
      const item = { id: id, at: at, text: text, createdAt: Date.now(), meta: meta };
      // 到点后再留 7 天过期，避免 Cron 万一漏掉就永久堆积
      await env.SCHEDULE.put(queueKey(at, id), JSON.stringify(item),
        { expirationTtl: Math.max(120, Math.floor((at - Date.now()) / 1000) + 7 * 86400) });
      return json({ ok: true, id: id, at: at }, 200, headers);
    }

    // ---- 立即发送 ----
    const data = await tgSend(env, text);
    return json(data, data.ok ? 200 : 502, headers);
  },

  /** Cron 触发：把到点的消息发出去，顺带看看该不该发当日速报 */
  async scheduled(event, env, ctx) {
    if (!env.SCHEDULE || !env.TG_TOKEN) return;
    const now = Date.now();

    // ---- 当日速报（JST 21:30 之后的第一次 cron）----
    const jstNow = new Date(now + 9 * 3600000);
    const mins = jstNow.getUTCHours() * 60 + jstNow.getUTCMinutes();
    if (mins >= REPORT_HOUR * 60 + REPORT_MIN && !(await reportSent(env, now))
        && !(await env.SCHEDULE.get(reportEmptyKey(now)))) {
      const data = await fetchRecords(env);
      const start = await reportWindowStart(env, now);
      const text = data ? buildReport(data, now, env.BOARD_URL || '', start) : null;
      if (text) {
        const r = await tgSend(env, text);
        if (r.ok) {
          await markReportSent(env, now, 'auto');
          await saveReportCursor(env, now);
        }
      } else if (data) {
        // 这一批没有任何符合条件的状态变化 → 当天不自动发。
        // 只打一个「空」标记做节流，不占用「已发过」——
        // 之后手动点「当日速报」照样能发。
        await env.SCHEDULE.put(reportEmptyKey(now),
          JSON.stringify({ at: now }), { expirationTtl: 3 * 86400 });
      }
    }

    const items = await listQueue(env, MAX_QUEUE);
    for (const item of items) {
      if (item.at > now) continue;              // key 按时间排序，但保险起见逐条判断
      const data = await tgSend(env, item.text);
      // 发送失败就留着，下一轮再试；Telegram 明确拒绝（4xx）的才丢弃
      if (data.ok || (data.error_code && data.error_code >= 400 && data.error_code < 500)) {
        await env.SCHEDULE.delete(item.key);
      }
    }
  }
};
