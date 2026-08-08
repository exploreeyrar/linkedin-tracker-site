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
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Key, X-Ingest-Key, X-Write-Key',
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

/**
 * 发一条到 Telegram，顺手把它也记进收件箱。
 *
 * 为什么要顺手记：**bot 收不到自己发的消息**，所以经 sendMessage 发出去的东西
 * 永远不会从 webhook 回来，channel.html 上就看不到「请求更新状态」「当日速报」
 * 这些自己发的内容（msgId 缺号 #30-31 / #35 / #37 / #39-40… 全是它们）。
 *
 * 这里是所有发送路径的唯一出口 —— 立即发、定时队列、Cron 的当日速报、
 * sendnow、iMessage 桥的那份副本，全都走这条函数，所以补在这一处就够。
 *
 * uid 用 Telegram 回给我们的真实 message_id 拼，和 webhook 那边算出来的一模一样：
 * 万一以后 Telegram 真的开始投递 bot 自己的消息，同一个 key 覆盖掉即可，不会重复。
 */
async function tgSend(env, text) {
  const res = await fetch(`${TG_API}/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT, text: text, disable_web_page_preview: true })
  });
  const data = await res.json().catch(() => ({ ok: false, description: 'invalid response from Telegram' }));
  if (data && data.ok) {
    try { await recordOwnMessage(env, data.result, text); }
    catch (e) { /* 记不进收件箱不该让「已发送」变成失败 */ }
  }
  return data;
}

/** 把 bot 自己发出去的那条写进收件箱，让 channel.html 也看得到 */
async function recordOwnMessage(env, result, text) {
  if (!result || !result.chat) return;
  const from = result.from || {};
  await inboxAppend(env, {
    uid: String(result.chat.id) + ':' + result.message_id,
    chatId: String(result.chat.id),
    chatTitle: String(result.chat.title || result.chat.username || ''),
    msgId: result.message_id,          // 真实 msgId，缺号统计也就跟着准了
    ts: (Number(result.date) || Math.floor(Date.now() / 1000)) * 1000,
    editedTs: 0,
    author: String(from.first_name || from.username || 'Bot').slice(0, 60),
    bot: true,
    kind: '',
    text: redactText(env, String(text || '')).slice(0, 4000),
    replyText: '',
    media: null,
  });
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
  '等己方处理(胖 ball)',
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

// 速报的三个标记都存在 BoardStore 里（原来在 KV）。
// 「今天没有新情况」和「已发过」分开存：否则一旦定时那一轮扫到空，
// 当天就再也发不出手动速报了。
function reportKey(now) { return 'sent:' + jstDate(now); }
function reportEmptyKey(now) { return 'empty:' + jstDate(now); }
const REPORT_CURSOR_KEY = 'cursor';          // 上一批速报统计到哪个时刻为止

async function reportSent(env, now) {
  try { return (await board(env, '/rep/get', { key: reportKey(now) })).val; }
  catch (e) { return null; }
}

async function markReportSent(env, now, by) {
  await board(env, '/rep/put', { key: reportKey(now), val: { at: Date.now(), by: by || 'auto' } });
}

/**
 * 这一批的统计起点。
 * 上一批发到哪个时刻就从哪儿接着算，接不上（首次运行 / 游标过期 / 明显不合理）
 * 才退回「前一日 21:30」。这样手动提前发过之后，那天剩下的变化也不会被漏掉。
 */
async function reportWindowStart(env, now) {
  const fallback = prevReportBoundary(now);
  let val = null;
  try { val = (await board(env, '/rep/get', { key: REPORT_CURSOR_KEY })).val; }
  catch (e) { return fallback; }
  const at = Number(val && val.at) || 0;
  // 游标太旧（超过 7 天没发过）就别把一大堆陈年变化翻出来
  if (!at || at > now || at < now - 7 * 86400000) return fallback;
  return at;
}

/** 记下这一批统计到哪儿为止，下一批从这里接着算 */
async function saveReportCursor(env, end) {
  await board(env, '/rep/put', { key: REPORT_CURSOR_KEY, val: { at: end } });
}

/**
 * 拉取看板数据源。
 * 以前是去 GitHub raw 拉 records.json，现在真相源就在 DO 里，直接问它 ——
 * 少一次 subrequest，也不会再读到 CDN 上的旧值。
 */
async function fetchRecords(env) {
  let blob = null;
  try { blob = await board(env, '/doc'); } catch (e) { return null; }
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
 * 把这一批窗口内**状态**变过的记录整理成一条简报。
 * 没有变化就返回 null —— 没消息就不发，别每天定时打扰。
 *
 * 判据是 statusAt（状态最后一次改变的时刻），不是 updatedAt。
 * updatedAt 会被写 MEMO、设截止时间、改跟进提醒这些动作一起顶上来，
 * 拿它当判据会让速报里塞满「其实状态没动」的项目。statusAt 由
 * mergeIntoRepo 在状态真的变了的时候盖章，所以不依赖某台机器的脚本版本。
 * 没有 statusAt 的老记录一律不算 —— 我们确实不知道它的状态是哪天变的。
 */
function buildReport(data, now, boardUrl, start) {
  const records = (data && data.records) || [];
  const end = now || Date.now();
  const skip = reportSkipSet(data);
  const hits = records.filter((r) => {
    if (!r || !r.statusAt) return false;                  // 状态没变过（或还没盖过章）
    if (r.statusAt < start || r.statusAt > end) return false;
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
    jstDate(now) + '（JST）　共 ' + hits.length + ' 家状态有变',
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

// 在 Telegram 里把某条消息编辑成这个内容 → 看板上删掉它。
// Bot API 不发「消息被删除」的事件（见 README），这是唯一能从手机上遥控删除的办法。
const DEL_MARKS = ['/del', '/delete', '删除'];

/** Bot API 7.0 起 thumb 改名 thumbnail，两个都认 */
function thumbOf(x) { return x && (x.thumbnail || x.thumb); }

/** 这条消息里有没有能当图片显示的东西 */
function mediaOf(m) {
  if (m.photo && m.photo.length) {
    const best = m.photo[m.photo.length - 1];      // 最后一个是最大尺寸
    return { kind: 'photo', fileId: best.file_id, w: best.width || 0, h: best.height || 0 };
  }
  if (m.sticker) {
    const t = thumbOf(m.sticker);
    // 动态贴纸（tgs/webm）浏览器放不出来，退回缩略图
    const use = (m.sticker.is_animated || m.sticker.is_video) ? t : m.sticker;
    if (use) return { kind: 'photo', fileId: use.file_id, w: use.width || 0, h: use.height || 0 };
  }
  if (m.document && /^image\//i.test(m.document.mime_type || '')) {
    return { kind: 'photo', fileId: m.document.file_id, w: 0, h: 0 };
  }
  // 视频 / 动图 / 非图片文件：能拿到缩略图就显示缩略图
  const t = thumbOf(m.video) || thumbOf(m.animation) || thumbOf(m.document) || thumbOf(m.audio);
  if (t) return { kind: 'thumb', fileId: t.file_id, w: t.width || 0, h: t.height || 0 };
  return null;
}

/**
 * 把一条 update 压成看板要显示的样子。
 * 除了纯粹的「非消息」update（比如 poll_answer），一律要有产出 ——
 * 早先这里对不认识的类型直接返回 null，结果消息在看板上凭空消失、数量对不上。
 */
function parseUpdate(u) {
  if (!u || typeof u !== 'object') return null;
  const edited = u.edited_channel_post || u.edited_message;
  const m = u.channel_post || u.message || edited;
  if (!m || !m.chat) return null;

  const text = String(m.text || m.caption || '');
  let kind = '';
  if (m.photo) kind = '🖼 图片';
  else if (m.video) kind = '🎬 视频';
  else if (m.animation) kind = '🎞 动图';
  else if (m.voice) kind = '🎤 语音';
  else if (m.audio) kind = '🎵 音频';
  else if (m.video_note) kind = '📹 视频留言';
  else if (m.sticker) kind = '🩹 贴纸 ' + (m.sticker.emoji || '');
  else if (m.document) kind = '📎 文件 ' + (m.document.file_name || '');
  else if (m.poll) kind = '📊 投票 ' + (m.poll.question || '');
  else if (m.location || m.venue) kind = '📍 位置';
  else if (m.contact) kind = '👤 联系人 ' + (m.contact.first_name || '');
  else if (m.new_chat_members) kind = '👋 有人加入';
  else if (m.left_chat_member) kind = '🚪 有人离开';
  else if (m.pinned_message) kind = '📌 置顶了一条消息';
  else if (m.new_chat_title) kind = '✏️ 改名为 ' + m.new_chat_title;
  else if (!text) kind = '❓ 这个类型还没适配';    // 兜底：宁可显示得难看，也不能凭空少一条

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
    media: mediaOf(m),
    // 编辑成 /del 就是要把它从看板上撤掉
    del: !!edited && DEL_MARKS.indexOf(text.trim().toLowerCase()) !== -1,
  };
}

/**
 * 一条收件箱消息的脱敏。
 *
 * ⚠️ 之前漏了这一层：从 Telegram webhook 进来的消息**完全没过替换**，
 * 于是手写在群里的真名照原样进了收件箱，而收件箱是任何 Origin 都能读的。
 * 所有写进收件箱的路径（webhook / recordOwnMessage / inbox_push）都必须过这里。
 */
function redactMsg(env, m) {
  if (!m) return m;
  if (!redactPairs(env).length) return m;
  return Object.assign({}, m, {
    text: redactText(env, m.text),
    author: redactText(env, m.author),
    chatTitle: redactText(env, m.chatTitle),
    replyText: redactText(env, m.replyText),
    kind: redactText(env, m.kind),
  });
}

/** msgId 是每个会话里连续递增的，缺号就是没收到的那些 */
function msgIdGaps(items) {
  const ids = items.map((m) => Number(m.msgId)).filter((n) => n > 0).sort((a, b) => a - b);
  if (ids.length < 2) return [];
  const gaps = [];
  for (let i = 1; i < ids.length; i++) {
    const from = ids[i - 1] + 1, to = ids[i] - 1;
    if (to >= from) gaps.push([from, to]);
  }
  return gaps.slice(0, 40);
}

/** 收件箱的存储 key：零填充时间戳打头，list 出来就是时间序 */
function inboxKey(msg) {
  return 'in:' + String(msg.ts).padStart(13, '0') + ':' + msg.uid;
}

/** 拿到那个唯一的收件箱 DO */
function inboxStub(env) {
  if (!env.INBOX) return null;
  return env.INBOX.get(env.INBOX.idFromName(INBOX_ROOM));
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

  broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(payload); } catch (e) { /* 断了就断了，close 事件会清掉 */ }
    }
  }

  async append(msg) {
    await this.state.storage.put(inboxKey(msg), msg);
    if (msg.media && msg.media.fileId) {
      // 图片代理只放行确实出现在收件箱里的 file_id
      await this.state.storage.put('fid:' + msg.media.fileId, 1);
    }
    // 超出上限就把最老的删掉，别让存储无限长
    const all = await this.state.storage.list({ prefix: 'in:' });
    if (all.size > INBOX_MAX) {
      const keys = [...all.keys()].slice(0, all.size - INBOX_MAX);
      await this.state.storage.delete(keys);
    }
    this.broadcast({ type: 'msg', items: [msg] });
  }

  /** 按 uid 删除。返回真正删掉的 uid，好让页面知道该抹掉哪几条 */
  async remove(uids) {
    const all = await this.state.storage.list({ prefix: 'in:' });
    const hit = [], keys = [];
    for (const [k, m] of all) {
      if (!m || uids.indexOf(m.uid) === -1) continue;
      hit.push(m.uid);
      keys.push(k);
      // 连带把图片的通行证收回：消息都删了，那张图不该还能下载
      if (m.media && m.media.fileId) keys.push('fid:' + m.media.fileId);
    }
    if (keys.length) await this.state.storage.delete(keys);
    if (hit.length) this.broadcast({ type: 'del', uids: hit });
    return hit;
  }

  /**
   * archive / 取回。存在服务端而不是各自的浏览器里 ——
   * 这样谁 archive 的，所有人看到的都一样，且立刻广播出去。
   */
  async setArchived(uids, on) {
    const all = await this.state.storage.list({ prefix: 'in:' });
    const hit = [];
    for (const [k, m] of all) {
      if (!m || uids.indexOf(m.uid) === -1) continue;
      m.archivedAt = on ? Date.now() : 0;
      await this.state.storage.put(k, m);
      hit.push(m.uid);
    }
    if (hit.length) this.broadcast({ type: 'arch', uids: hit, on: !!on, at: Date.now() });
    return hit;
  }

  async clear() {
    const all = await this.state.storage.list({ prefix: 'in:' });
    const uids = [...all.values()].map((m) => m && m.uid).filter(Boolean);
    await this.state.storage.deleteAll();
    this.broadcast({ type: 'del', uids: uids });
    return uids.length;
  }

  async fileAllowed(fileId) {
    return !!(await this.state.storage.get('fid:' + fileId));
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
    if (url.pathname === '/archive') {
      const body = await request.json().catch(() => null);
      const uids = (body && Array.isArray(body.uids)) ? body.uids : [];
      const hit = await this.setArchived(uids, !!(body && body.on));
      return new Response(JSON.stringify({ changed: hit }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/delete') {
      const body = await request.json().catch(() => null);
      const uids = (body && Array.isArray(body.uids)) ? body.uids : [];
      const hit = await this.remove(uids);
      return new Response(JSON.stringify({ removed: hit }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/clear') {
      const n = await this.clear();
      return new Response(JSON.stringify({ removed: n }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/fileok') {
      const ok = await this.fileAllowed(url.searchParams.get('id') || '');
      return new Response(JSON.stringify({ ok: ok }), { headers: { 'Content-Type': 'application/json' } });
    }

    // /list?since=<ms>
    const since = Number(url.searchParams.get('since') || 0);
    const items = await this.list(since);
    // 缺号要按全量算，所以这里单独再取一次完整列表
    const full = since ? await this.list(0) : items;
    return new Response(JSON.stringify({ items: items, total: full.length, gaps: msgIdGaps(full) }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  // hibernation 下的三个回调。前端只会发心跳，收到就原样回一个 pong。
  async webSocketMessage(ws, data) {
    if (String(data) === 'ping') { try { ws.send('pong'); } catch (e) {} }
  }
  async webSocketClose(ws, code, reason, wasClean) { try { ws.close(code, reason); } catch (e) {} }
  async webSocketError(ws) { /* 交给 close 处理 */ }
}

/* ==========================================================================
 * BoardStore —— 看板数据的真相源
 *
 * 以前投递记录是 build.py 烤进 dist/index.html 的：数据跟着构建产物走，
 * 谁打开 GitHub Pages 谁就看得到全文。现在整份搬进这个单实例 DO，
 * 页面运行时带着 WRITE_KEY 找 Worker 要 —— 构建产物里只剩一个空壳。
 *
 * 顺带解决了三件老问题：
 *   · 合并在 DO 内部串行执行，不再有「读 GitHub → 合并 → PUT 撞 409 → 重来」
 *     那个循环，也不会两台机器互相抹掉。
 *   · 预约队列和速报标记一起搬进来，KV 整个 namespace 可以退役
 *     （免费额度的 list 桶本来就是被 5 分钟一次的队列扫描吃掉的）。
 *   · 改动通过 WebSocket 直接推给看板，不用再等 GitHub Actions 部署完
 *     ——「同步成功 ≠ 页面更新」那段几十秒的空窗没了。
 *
 * 存储分四个前缀：
 *   rec:<id>            一条投递记录
 *   msg:<id>            一条留言
 *   sch:<padAt>:<id>    一条预约（key 按时间排序，alarm 只看头一条）
 *   rep:*               速报的「已发过 / 当天为空 / 统计游标」标记
 *   meta:doc            statusDefs / statusOrder / updatedAt / rev
 * ========================================================================== */

const BOARD_ROOM = 'main';             // 只有一份看板，DO 用固定名字
const BOARD_WS_PATH = '/board/ws';

function schKey(at, id) {
  return 'sch:' + String(at).padStart(13, '0') + ':' + id;
}

export class BoardStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(payload); } catch (e) { /* 断了就断了，close 事件会清掉 */ }
    }
  }

  /* ---- 读 ---------------------------------------------------------------- */

  async meta() {
    return (await this.state.storage.get('meta:doc')) || { statusDefs: [], statusOrder: [], updatedAt: '', rev: 0 };
  }

  /** 把分散的 key 重新拼成 build.py / mergeIntoRepo 一直在用的那个文档形状 */
  async doc() {
    const recs = await this.state.storage.list({ prefix: 'rec:' });
    const msgs = await this.state.storage.list({ prefix: 'msg:' });
    const m = await this.meta();
    return {
      records: [...recs.values()],
      messages: [...msgs.values()],
      statusDefs: m.statusDefs || [],
      statusOrder: m.statusOrder || [],
      updatedAt: m.updatedAt || '',
      rev: m.rev || 0,
    };
  }

  /**
   * 整份写回。记录条数是百这个量级，storage.put 一次最多 128 对，
   * 所以分批；消失的 id 要显式删掉，不然会像幽灵一样留在库里。
   */
  async putDoc(doc) {
    const want = new Map();
    (doc.records || []).forEach((r) => { if (r && r.id) want.set('rec:' + r.id, r); });
    (doc.messages || []).forEach((x) => { if (x && x.id) want.set('msg:' + x.id, x); });

    const had = [
      ...(await this.state.storage.list({ prefix: 'rec:' })).keys(),
      ...(await this.state.storage.list({ prefix: 'msg:' })).keys(),
    ];
    const gone = had.filter((k) => !want.has(k));
    if (gone.length) {
      for (let i = 0; i < gone.length; i += 128) {
        await this.state.storage.delete(gone.slice(i, i + 128));
      }
    }

    const entries = [...want.entries()];
    for (let i = 0; i < entries.length; i += 128) {
      await this.state.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    }

    const m = await this.meta();
    const rev = (m.rev || 0) + 1;
    await this.state.storage.put('meta:doc', {
      statusDefs: doc.statusDefs || m.statusDefs || [],
      statusOrder: doc.statusOrder || m.statusOrder || [],
      updatedAt: doc.updatedAt || new Date().toISOString(),
      rev: rev,
    });
    // 看板收到就自己再拉一次；推的是「变了」而不是整份数据，省带宽
    this.broadcast({ type: 'rev', rev: rev, updatedAt: doc.updatedAt || '' });
    return rev;
  }

  /* ---- 写 ---------------------------------------------------------------- */

  /** 油猴脚本的整份同步。合并语义原样沿用 mergeIntoRepo，只是换了个存储 */
  async merge(incoming) {
    const doc = await this.doc();
    const stat = mergeIntoRepo(this.env, doc, incoming);
    doc.updatedAt = new Date().toISOString();
    const rev = await this.putDoc(doc);
    return { stat: stat, rev: rev, counts: { records: doc.records.length, messages: doc.messages.length } };
  }

  /** 看板上的零散改动（memo / followUp / deadline） */
  async ops(list) {
    const doc = await this.doc();
    const res = applyBoardOps(this.env, doc, list);
    if (!res.applied.length) return { applied: res.applied, skipped: res.skipped, rev: (await this.meta()).rev || 0 };
    doc.updatedAt = new Date().toISOString();
    const rev = await this.putDoc(doc);
    return { applied: res.applied, skipped: res.skipped, rev: rev };
  }

  /** 首次启动时从 GitHub 把现有数据搬进来，只会成功一次 */
  async seed(doc) {
    if (await this.state.storage.get('meta:seeded')) return { seeded: false, why: '已经导入过了' };
    const rev = await this.putDoc(doc);
    await this.state.storage.put('meta:seeded', { at: Date.now() });
    return { seeded: true, rev: rev, records: (doc.records || []).length, messages: (doc.messages || []).length };
  }

  /* ---- 预约队列（原来在 KV，现在靠 alarm 精确到秒）------------------------ */

  async schList() {
    const all = await this.state.storage.list({ prefix: 'sch:' });
    return [...all.values()];              // key 零填充过，list 出来就是时间序
  }

  async schAdd(item) {
    await this.state.storage.put(schKey(item.at, item.id), item);
    await this.arm();
    return item;
  }

  /** 按 id 删除，返回删掉的那条（取消 / 立刻发送都走这里） */
  async schRemove(id) {
    const all = await this.state.storage.list({ prefix: 'sch:' });
    for (const [k, v] of all) {
      if (v && v.id === id) {
        await this.state.storage.delete(k);
        await this.arm();
        return v;
      }
    }
    return null;
  }

  /** 闹钟对准队列里最早的那条 */
  async arm() {
    const all = await this.state.storage.list({ prefix: 'sch:', limit: 1 });
    const first = [...all.values()][0];
    if (!first) { await this.state.storage.deleteAlarm(); return; }
    // 已经过点的立刻响；DO 保证 alarm 至少触发一次，失败会自动重试
    await this.state.storage.setAlarm(Math.max(Number(first.at) || 0, Date.now() + 1000));
  }

  async alarm() {
    const now = Date.now();
    const all = await this.state.storage.list({ prefix: 'sch:' });
    for (const [k, item] of all) {
      if (!item || Number(item.at) > now) break;        // 时间序，后面的更没到点
      const data = await tgSend(this.env, item.text);
      // 发送失败就留着，下一轮再试；Telegram 明确拒绝（4xx）的才丢弃
      if (data.ok || (data.error_code && data.error_code >= 400 && data.error_code < 500)) {
        await this.state.storage.delete(k);
      } else {
        // 这一条卡住了，5 分钟后整体重试，别把后面的堵死在同一次 alarm 里
        await this.state.storage.setAlarm(Date.now() + 5 * 60000);
        return;
      }
    }
    await this.arm();
  }

  /* ---- 速报标记 ---------------------------------------------------------- */

  async repGet(key) { return (await this.state.storage.get('rep:' + key)) || null; }
  async repPut(key, val) { await this.state.storage.put('rep:' + key, val); }

  /* ---- HTTP 入口 --------------------------------------------------------- */

  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const url = new URL(request.url);
    const p = url.pathname;
    const body = (request.method === 'POST') ? await request.json().catch(() => ({})) : {};
    const reply = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });

    if (p === '/doc')       return reply(await this.doc());
    if (p === '/meta')      return reply(await this.meta());
    if (p === '/merge')     return reply(await this.merge(body.incoming || {}));
    if (p === '/ops')       return reply(await this.ops(body.ops || []));
    if (p === '/seed')      return reply(await this.seed(body.doc || {}));

    if (p === '/sch/list')  return reply({ items: await this.schList() });
    if (p === '/sch/add')   return reply({ item: await this.schAdd(body.item) });
    if (p === '/sch/del')   return reply({ item: await this.schRemove(String(body.id || '')) });

    if (p === '/rep/get')   return reply({ val: await this.repGet(String(body.key || '')) });
    if (p === '/rep/put')   { await this.repPut(String(body.key || ''), body.val); return reply({ ok: true }); }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws, data) {
    if (String(data) === 'ping') { try { ws.send('pong'); } catch (e) {} }
  }
  async webSocketClose(ws, code, reason, wasClean) { try { ws.close(code, reason); } catch (e) {} }
  async webSocketError(ws) { /* 交给 close 处理 */ }
}

/** 拿到那个唯一的看板 DO */
function boardStub(env) {
  if (!env.BOARD) return null;
  return env.BOARD.get(env.BOARD.idFromName(BOARD_ROOM));
}

/** 对 BoardStore 发一次内部调用 */
async function board(env, path, payload) {
  const stub = boardStub(env);
  if (!stub) throw new Error('BOARD Durable Object 未绑定');
  const init = payload === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  const res = await stub.fetch('https://do' + path, init);
  if (!res.ok) throw new Error('BoardStore ' + path + ' → HTTP ' + res.status);
  return await res.json();
}

/**
 * 看板数据第一次用之前，把 GitHub 上那份搬进 DO。
 * seed 自己是幂等的（DO 里有 meta:seeded 挡着），所以这里可以放心多调。
 */
async function seedBoardFromGitHub(env) {
  if (!env.GH_TOKEN || !env.GH_REPO) throw new Error('Worker 上还没配 GH_TOKEN / GH_REPO，没法导入');
  const read = await ghReadRecords(env);
  return await board(env, '/seed', { doc: read.data });
}

/* ==========================================================================
 * 出库清洗 —— build.py 里 normalize() / canon_status() 那一套的 JS 版
 *
 * 以前这一步在构建时做（Python），所以页面拿到的一直是清洗过的形状：状态名
 * 归一过、老记录的整段 memo 拆成了 memos 时间轴、时间戳统一成毫秒、脏链接
 * 被挡掉、长文本按显示需要截断。数据搬进 DO 之后构建产物里没有数据了，
 * 这一步就得挪到出库的时候来做 —— 否则页面会突然收到未清洗的原始记录，
 * 那是行为变化，不是搬家。
 *
 * 刻意只在**读**的时候清洗：存储里始终留全文。截断是为了页面好看，
 * 把它写回真相源等于永久丢字。
 * ========================================================================== */

const NEW_RECORD_STATUS = '已投递等联络';   // 新记录的初始状态，不等于顺位第一
const STATUS_ALIAS = {
  '对方来联络了': '対方来联络了',
  '已安排面试': '已安排面试、面试准备中',
  '等己方处理': '等己方处理(胖 ball)',
  // XR → 胖 的改名（含之前手改出来的带空格写法）
  '等己方处理(XR ball)': '等己方处理(胖 ball)',
  '等己方 处理(XR ball)': '等己方处理(胖 ball)',
};
// 只允许指向招聘站本身的链接出门，避免脏数据把页面变成任意跳转
const SAFE_URL = /^https:\/\/([a-z0-9-]+\.)*(linkedin\.com|jobstreet\.com(\.[a-z]{2})?|jora\.com)\//i;
const SITES = ['linkedin', 'jobstreet', 'jora'];

/**
 * 按**码点**截断。
 * build.py 那边是 Python 的 str[:n]，一个 emoji 算一格；JS 的 slice 按 UTF-16
 * 码元算，🎉 这种星平面字符要占两格。MEMO 里就有 emoji，直接用 slice 会比
 * 构建时代少截几个字 —— 对不上就说明这次搬家改了行为。
 */
function cut(t, limit) {
  const cps = Array.from(t);
  return cps.length <= limit ? t : cps.slice(0, limit).join('');
}

/** 去掉控制字符、限长 */
function nstr(v, limit) {
  if (v == null) return '';
  let t = String(v).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.split('').filter((ch) => ch === '\n' || ch >= ' ').join('');
  return cut(t.trim(), limit || 400);
}

function nurl(v) {
  const t = nstr(v, 500);
  return SAFE_URL.test(t) ? t : '';
}

// datetime.fromisoformat 只吃 ISO-8601，"−5"、"嗯？" 这种一律 ValueError → 0。
// Date.parse 宽松得多（"-5" 都能给出一个日期），所以先用这个把门关上。
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** 时间戳统一成毫秒整数。接受数字或 ISO 字符串 */
function nms(v) {
  if (typeof v === 'number' && v > 0) {
    const n = Math.trunc(v);
    return n < 10000000000 ? n * 1000 : n;          // 秒 → 毫秒
  }
  const t = nstr(v, 40);
  if (!t || !ISO_RE.test(t)) return 0;
  // 不带时区的当 UTC 算。build.py 那边走的是 .timestamp()，也就是构建机的本地
  // 时区（Actions 上是 UTC）—— 实际数据里的 ISO 全都带 Z，这条分支碰不到。
  const p = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : (t.replace(' ', 'T') + 'Z'));
  return isFinite(p) && p > 0 ? p : 0;
}

function nclamp(v, lo, hi) {
  const n = Number(v);
  if (!isFinite(n)) return lo;                       // 脏数据不该让出库失败
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

// 逐字匹配之外再做一次「去标点 + 対/对 统一」的模糊匹配，老数据不会落到未知状态
function looseStatus(s) {
  return String(s || '').replace(/[，,、･·・ \t]/g, '').replace(/対/g, '对');
}

function canonStatus(value, activeNames, activeDefault) {
  if (!value) return activeDefault;
  if (activeNames.indexOf(value) !== -1) return value;
  // 内置别名只在目标名字确实还在用时才生效（用户可能已经把它改名或删掉了）
  const alias = STATUS_ALIAS[value];
  if (alias && activeNames.indexOf(alias) !== -1) return alias;
  const loose = new Map(activeNames.map((n) => [looseStatus(n), n]));
  return loose.get(looseStatus(value)) || value;
}

function builtinDefs() {
  const closed = ['面试落了', '书类落了', '对方招到人了', '无消息疑似书类落了'];
  const rejected = ['面试落了', '书类落了'];
  const advanced = ['已安排面试、面试准备中', '一次面试通过、等対方安排下一轮',
    '二次面试通过、等对方安排下一轮', '三次面试通过、等对方安排下一轮',
    '四次面试通过、等对方安排下一轮', '人事 Offer Call', '内定'];
  const waiting = ['已投递等联络', '等己方处理(胖 ball)', '等己方处理(己 ball)',
    '一次人事面谈结束、等对方联络'];
  const roles = { '已投递等联络': 'default', '无消息疑似书类落了': 'nonews' };
  return DEFAULT_STATUS_ORDER.map((n, i) => ({
    id: 'b' + i, name: n,
    closed: closed.indexOf(n) !== -1, rejected: rejected.indexOf(n) !== -1,
    advanced: advanced.indexOf(n) !== -1, waiting: waiting.indexOf(n) !== -1,
    role: roles[n] || '',
  }));
}

/**
 * 状态定义。脚本里状态可以改名 / 新增 / 删除，所以这里**不做名字白名单** ——
 * 推上来的就是权威，否则用户自定义的状态会被整条丢掉。
 */
function normalizeDefs(rawDefs, order) {
  const out = [];
  const seen = new Set();

  // 推上来的完整定义就是权威，连顺序都以它为准（statusOrder 只在没有定义时才看）
  (Array.isArray(rawDefs) ? rawDefs : []).forEach((d, i) => {
    if (!d || typeof d !== 'object') return;
    const name = nstr(d.name, 40);
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({
      id: nstr(d.id, 40) || ('s' + i),
      name: name,
      closed: !!d.closed, rejected: !!d.rejected,
      advanced: !!d.advanced, waiting: !!d.waiting,
      role: nstr(d.role, 20),
    });
  });
  if (out.length) return out;

  // 老版本只推了 statusOrder（纯名字数组）：按它排，属性从内置定义里认领
  const byName = new Map(builtinDefs().map((d) => [d.name, d]));
  const names = (Array.isArray(order) ? order : []).filter((x) => typeof x === 'string' && x);
  if (!names.length) return builtinDefs();
  names.forEach((n, i) => {
    if (seen.has(n)) return;
    seen.add(n);
    out.push(byName.get(n) || {
      id: 'o' + i, name: n, closed: false, rejected: false,
      advanced: false, waiting: false, role: '',
    });
  });
  return out;
}

/** 有 site 字段就信它，没有（早期记录）就看链接域名，最后一律当 LinkedIn */
function siteOf(raw, jobUrl) {
  const site = nstr(raw.site, 20).toLowerCase();
  if (SITES.indexOf(site) !== -1) return site;
  const u = String(jobUrl || '').toLowerCase();
  if (u.includes('jobstreet.')) return 'jobstreet';
  if (u.includes('jora.')) return 'jora';
  return 'linkedin';
}

/**
 * MEMO 的时间轴。新脚本推上来的是 memos 数组（一次一条，带时间）；
 * 老记录只有一整段 memo，就当成一条，时间取最后改动时间。最多留 50 条。
 */
function memoBlocks(raw) {
  const out = [];
  for (const b of (Array.isArray(raw.memos) ? raw.memos : []).slice(0, 50)) {
    if (!b || typeof b !== 'object') continue;
    const text = nstr(b.text, 2000);
    const ts = nms(b.ts);
    if (text && ts) out.push({ ts: ts, text: text });
  }
  if (out.length) { out.sort((a, b) => b.ts - a.ts); return out; }
  const memo = nstr(raw.memo, 2000);
  if (!memo) return [];
  const ts = nms(raw.updatedAt) || nms(raw.ts);
  return ts ? [{ ts: ts, text: memo }] : [];
}

/** 清洗单条记录；返回 null 表示丢弃 */
function normalizeRecord(raw, activeNames, activeDefault) {
  if (!raw || typeof raw !== 'object') return null;
  const ts = nms(raw.ts) || nms(raw.timestamp);
  if (!ts) return null;

  const hirers = [];
  for (const h of (Array.isArray(raw.hirers) ? raw.hirers : []).slice(0, 6)) {
    if (!h || typeof h !== 'object') continue;
    const name = nstr(h.name, 80), link = nurl(h.url);
    if (!name && !link) continue;
    hirers.push({ name: name || '(未知)', url: link, role: nstr(h.role, 160) });
  }

  const jobUrl = nurl(raw.jobUrl);
  return {
    // id 页面用不上（build.py 也没输出），但 DO 里按它建 key，留着方便对账
    ts: ts,
    site: siteOf(raw, jobUrl),
    // LinkedIn / Jobstreet 是纯数字，Jora 是 32 位十六进制，所以只能按
    // 「字母数字」清洗，不能把非数字统统删掉（那会把 Jora 的 ID 毁掉）
    jobId: nstr(raw.jobId, 48).replace(/[^0-9A-Za-z]/g, '').slice(0, 48),
    updatedAt: nms(raw.updatedAt),
    statusAt: nms(raw.statusAt),
    company: nstr(raw.company, 120),
    title: nstr(raw.title, 200),
    jobUrl: jobUrl,
    hirers: hirers,
    employees: nstr(raw.employees, 20),
    years: nstr(raw.years, 40),
    jobMatch: nstr(raw.jobMatch, 40),
    tenure: nstr(raw.tenure, 30),
    status: canonStatus(nstr(raw.status, 40), activeNames, activeDefault),
    priority: nclamp(raw.priority, 0, 3),
    followUpAt: nms(raw.followUpAt),
    followUpNote: nstr(raw.followUpNote, 300),
    deadlineAt: nms(raw.deadlineAt),
    deadlineDone: !!raw.deadlineDone,
    memo: nstr(raw.memo, 1000),
    memos: memoBlocks(raw),
    scout: !!raw.scout,
    sector: nstr(raw.sector, 120),
    epMonthly: Math.max(0, Math.trunc(Number(raw.epMonthly) || 0)),
    epAnnual: Math.max(0, Math.trunc(Number(raw.epAnnual) || 0)),
  };
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = nstr(raw.text, 4000);
  if (!text) return null;
  const created = nms(raw.createdAt) || nms(raw.ts);
  if (!created) return null;
  const edited = nms(raw.editedAt);
  return {
    id: nstr(raw.id, 40) || ('m' + created),
    text: text,
    createdAt: created,
    editedAt: (edited && edited !== created) ? edited : 0,
    author: nstr(raw.author, 40),
  };
}

/** 把 DO 里那份原始文档整理成页面一直在用的形状（等价于 build.py 的 load()） */
function normalizeDoc(doc) {
  const defs = normalizeDefs(doc.statusDefs, doc.statusOrder);
  const statuses = defs.map((d) => d.name);
  const defaultName = (defs.find((d) => d.role === 'default') || defs[0] || {}).name || NEW_RECORD_STATUS;

  const records = (doc.records || [])
    .map((r) => normalizeRecord(r, statuses, defaultName))
    .filter(Boolean);
  // 重要度最优先（★ 多的排最上面，无视状态与时间），
  // 其次状态顺位，同状态再按投递时间从新到旧
  const rank = new Map(statuses.map((n, i) => [n, i]));
  records.sort((a, b) =>
    (b.priority - a.priority)
    || ((rank.has(a.status) ? rank.get(a.status) : statuses.length)
        - (rank.has(b.status) ? rank.get(b.status) : statuses.length))
    || (b.ts - a.ts));

  const messages = (doc.messages || []).map(normalizeMessage).filter(Boolean);
  messages.sort((a, b) => b.createdAt - a.createdAt);

  let updated = nstr(doc.updatedAt, 40);
  if (!updated && records.length) {
    updated = new Date(Math.max(...records.map((r) => r.ts))).toISOString();
  }
  return { records, messages, statusDefs: defs, statuses, updatedAt: updated };
}

/* ---- 收件箱：全部走 DO ----------------------------------------------------
 * 以前每个函数都带一条 KV 兜底分支，那是 Durable Object 还没接上时的过渡。
 * 现在 KV namespace 已经整个退役，兜底分支跟着删掉 —— 留着只会让人以为
 * 还有第二条路可走。DO 没绑定就直接报错，比默默写进一个不存在的地方好。
 * -------------------------------------------------------------------------- */

async function inboxAppend(env, msg) {
  const stub = inboxStub(env);
  if (!stub) return;
  await stub.fetch('https://do/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg)
  });
}

async function inboxList(env, since) {
  const stub = inboxStub(env);
  if (!stub) return { items: [], total: 0, gaps: [], live: false };
  const res = await stub.fetch('https://do/list?since=' + encodeURIComponent(since || 0));
  const data = await res.json().catch(() => ({ items: [] }));
  return { items: data.items || [], total: data.total || 0, gaps: data.gaps || [], live: true };
}

async function inboxArchive(env, uids, on) {
  const stub = inboxStub(env);
  if (!stub) return [];
  const res = await stub.fetch('https://do/archive', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uids: uids, on: !!on })
  });
  const d = await res.json().catch(() => ({ changed: [] }));
  return d.changed || [];
}

async function inboxDelete(env, uids) {
  const stub = inboxStub(env);
  if (!stub) return [];
  const res = await stub.fetch('https://do/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uids: uids })
  });
  const d = await res.json().catch(() => ({ removed: [] }));
  return d.removed || [];
}

async function inboxClear(env) {
  const stub = inboxStub(env);
  if (!stub) return 0;
  const res = await stub.fetch('https://do/clear', { method: 'POST' });
  const d = await res.json().catch(() => ({ removed: 0 }));
  return d.removed || 0;
}

async function inboxFileAllowed(env, fileId) {
  const stub = inboxStub(env);
  if (!stub) return false;
  const res = await stub.fetch('https://do/fileok?id=' + encodeURIComponent(fileId));
  const d = await res.json().catch(() => ({ ok: false }));
  return !!d.ok;
}

/* ==========================================================================
 * Worker 代写 records.json
 *
 * 看板是 GitHub Pages 上的静态页，手里不能放 PAT（页面是公开的），所以原来
 * 只能把改动排进 localStorage 队列，等油猴脚本来取。那意味着：
 *   · 没装油猴脚本的电脑，写的 MEMO 永远传不上去
 *   · 装了但本机没有那条记录的电脑，操作会被静默丢弃
 *
 * 这里把 PAT 收进 Worker 的 Secret，由 Worker 读-改-写 records.json：
 *   页面 ──ops──▶ Worker ──Contents API──▶ GitHub
 * 用的是和 localStorage 队列**同一套 op 词汇**（memo / memoEdit / memoDelete /
 * followUp / deadline），所以页面那边不用另造一套东西。
 *
 * 鉴权不能靠 Origin（curl 想写什么 Origin 都行），也不能把密钥放进页面
 * （页面是公开的）。所以用一个 WRITE_KEY：用户在每台电脑的设置里手输一次，
 * 存在那台机器的 localStorage 里，不进构建产物。没配 WRITE_KEY 就整个关掉。
 * ========================================================================== */

const GH_API = 'https://api.github.com';

function ghHeaders(env) {
  return {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Authorization': 'Bearer ' + env.GH_TOKEN,
    'User-Agent': 'sgjob-worker',
  };
}

function ghContentsUrl(env) {
  const repo = String(env.GH_REPO || '').trim().replace(/^\/+|\/+$/g, '');
  const path = String(env.GH_PATH || 'data/records.json').trim().replace(/^\/+/, '');
  return GH_API + '/repos/' + repo + '/contents/'
       + path.split('/').map(encodeURIComponent).join('/');
}

/** UTF-8 字符串 → base64（btoa 只吃 latin1） */
function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function ghReadRecords(env) {
  const branch = env.GH_BRANCH || 'main';
  // Contents API 的 GET 走 CDN，刚写完再读常拿到旧值 —— 必须穿透缓存，否则下一次 PUT 必然 409
  const url = ghContentsUrl(env) + '?ref=' + encodeURIComponent(branch) + '&_=' + Date.now();
  const res = await fetch(url, {
    headers: Object.assign(ghHeaders(env), { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('读取 records.json 失败：HTTP ' + res.status + ' ' + t.slice(0, 160));
  }
  const meta = await res.json();
  const clean = String(meta.content || '').replace(/\s/g, '');
  const bin = atob(clean);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return { data: JSON.parse(new TextDecoder().decode(bytes)), sha: meta.sha };
}

async function ghWriteRecords(env, data, sha, message) {
  return await fetch(ghContentsUrl(env), {
    method: 'PUT',
    headers: Object.assign(ghHeaders(env), { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      message: message,
      content: b64utf8(JSON.stringify(data, null, 1)),
      branch: env.GH_BRANCH || 'main',
      sha: sha,
    }),
  });
}

/**
 * 把 DO 里那份镜像回 GitHub 当备份。
 *
 * DO 才是真相源，所以这里是**整份覆盖**，不合并 —— 也就不需要原来那个
 * 「读 → 合并 → PUT 撞 409 → 重来」的三次循环，只在 sha 过期时重取一次。
 * 调用方都用 ctx.waitUntil 把它扔到后台：备份失败不该让写入本身失败。
 */
async function mirrorToGitHub(env, message) {
  if (!env.GH_TOKEN || !env.GH_REPO) return { ok: false, why: 'GH_TOKEN / GH_REPO 未配置' };
  let doc;
  try { doc = await board(env, '/doc'); }
  catch (e) { return { ok: false, why: String(e.message || e) }; }

  const payload = {
    updatedAt: doc.updatedAt,
    records: doc.records || [],
    messages: doc.messages || [],
    statusDefs: doc.statusDefs || [],
    statusOrder: doc.statusOrder || [],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let sha;
    try { sha = (await ghReadRecords(env)).sha; }
    catch (e) { return { ok: false, why: String(e.message || e) }; }
    const put = await ghWriteRecords(env, payload, sha, message);
    if (put.ok) return { ok: true };
    if (put.status !== 409) {
      const detail = await put.text().catch(() => '');
      return { ok: false, why: 'HTTP ' + put.status + ' ' + detail.slice(0, 160) };
    }
  }
  return { ok: false, why: '409 冲突没能解决' };
}

/* ---- 脱敏 ----------------------------------------------------------------
 * 规则放在 REDACT_RULES Secret 里（JSON: [["OKUMA","O"],…]）——
 * 规则本身就含真名，写进仓库等于白做，所以只能当 Secret。
 * 没配就不替换：页面上手写的 MEMO 通常是自己知道会公开的短句。
 * ------------------------------------------------------------------------ */
function redactPairs(env) {
  try {
    const v = JSON.parse(env.REDACT_RULES || '[]');
    if (!Array.isArray(v)) return [];
    return v.filter((r) => Array.isArray(r) && r[0])
            .sort((a, b) => String(b[0]).length - String(a[0]).length);
  } catch (e) { return []; }
}

function redactText(env, v) {
  let t = String(v == null ? '' : v);
  if (!t) return t;
  for (const [from, to] of redactPairs(env)) {
    const re = new RegExp(String(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const rep = (to == null) ? '' : String(to);
    t = t.replace(re, () => rep);
  }
  return t;
}

/* ---- MEMO 的读写，语义和油猴脚本的 memoBlocks / setMemoBlocks 保持一致 ---- */

// 时间戳前缀按 JST 算 —— Worker 跑在 UTC，没有「本地时区」可用
function memoStamp(ts) {
  return '[' + new Date(ts + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + '] ';
}

function getMemos(rec) {
  if (Array.isArray(rec.memos) && rec.memos.length) {
    return rec.memos.filter((b) => b && b.text).slice().sort((a, b) => b.ts - a.ts);
  }
  if (rec.memo) return [{ ts: rec.updatedAt || rec.ts, text: rec.memo }];
  return [];
}

function setMemos(rec, blocks) {
  const list = (blocks || [])
    .map((b) => ({ ts: Number(b.ts) || Date.now(), text: String(b.text || '').trim() }))
    .filter((b) => b.text)
    .sort((a, b) => b.ts - a.ts);
  rec.memos = list;
  // 扁平那份继续维护：CSV / Telegram / 老看板还在用
  rec.memo = list.map((b) => memoStamp(b.ts) + b.text).join('\n\n');
}

/**
 * 把一批 op 套用到 records.json 上。返回哪些成功、哪些跳过。
 *
 * 定位 MEMO **只按 blockTs**，不比 oldText：页面上显示的那份可能是 build.py
 * 截断过的（memo 1000 / memos[].text 2000），拿它去和仓库里的全文比永远比不中。
 * blockTs 是写入时的 Date.now()，一条记录内实际唯一。
 */
function applyBoardOps(env, data, ops) {
  const recs = data.records || [];
  const applied = [], skipped = [];
  for (const op of ops) {
    if (!op || !op.op || !op.jobId) { skipped.push({ opId: op && op.opId, why: '操作不完整' }); continue; }
    const rec = recs.find((r) => String(r.jobId) === String(op.jobId)
      && (!op.site || (r.site || 'linkedin') === op.site));
    if (!rec) { skipped.push({ opId: op.opId, why: '仓库里没有这条记录' }); continue; }
    const now = Number(op.ts) || Date.now();

    if (op.op === 'memo') {
      const text = redactText(env, op.text).trim();
      const at = Number(op.ts) || Date.now();
      const blocks = getMemos(rec);
      if (!text) { skipped.push({ opId: op.opId, why: '内容为空' }); continue; }
      if (blocks.some((b) => b.ts === at && b.text === text)) {
        applied.push(op.opId);                 // 已经写进去了，算成功，别再重试
        continue;
      }
      setMemos(rec, blocks.concat([{ ts: at, text: text }]));
      rec.updatedAt = Math.max(rec.updatedAt || 0, at);
      applied.push(op.opId);

    } else if (op.op === 'memoEdit' || op.op === 'memoDelete') {
      const bts = Number(op.blockTs) || 0;
      const blocks = getMemos(rec);
      const hit = blocks.filter((b) => b.ts === bts);
      if (!hit.length) {
        applied.push(op.opId);                 // 已经不在了（可能上一轮就删掉了）
        continue;
      }
      const t = (op.op === 'memoEdit') ? redactText(env, op.text).trim() : '';
      const next = t
        ? blocks.map((b) => (hit.indexOf(b) === -1 ? b : { ts: b.ts, text: t }))
        : blocks.filter((b) => hit.indexOf(b) === -1);
      setMemos(rec, next);
      rec.updatedAt = Math.max(rec.updatedAt || 0, now);
      applied.push(op.opId);

    } else if (op.op === 'followUp') {
      rec.followUpAt = Number(op.at) || 0;
      rec.followUpNote = redactText(env, op.note);
      rec.updatedAt = Math.max(rec.updatedAt || 0, now);
      applied.push(op.opId);

    } else if (op.op === 'deadline') {
      if (String(op.done) === 'true' || op.done === true) rec.deadlineDone = true;
      else { rec.deadlineAt = Number(op.at) || 0; rec.deadlineDone = false; }
      rec.updatedAt = Math.max(rec.updatedAt || 0, now);
      applied.push(op.opId);

    } else {
      skipped.push({ opId: op.opId, why: '不认识的操作：' + op.op });
    }
  }
  return { applied, skipped };
}

/* ==========================================================================
 * 把某台机器的整份清单**合并**进仓库（油猴脚本的同步走这条）
 *
 * 原来脚本是整文件 PUT —— 两台电脑都开自动同步就会互相抹掉（A 推 97 条，
 * B 本机只有 50 条，一推仓库就变 50 条）。改成在 Worker 侧按 id 合并之后，
 * Worker 成为唯一写入方，谁先谁后都不会丢别人的记录。
 *
 * 合并语义**照搬脚本本地那套 mergeStored()**（它本来就是为多标签页写的），
 * 这样两边行为一致、好推理：
 *   · 按 id 配对；两边都有就取 recStamp = max(updatedAt, ts) 更大的那条
 *   · 只有一边有 → 收进来
 *   · 出现在 deleted 墓碑里的 → 删掉，且不许被别处的旧快照复活
 *
 * 刻意**不做**字段级 / MEMO 级合并：两台机器同时改同一条记录时，晚同步的那份
 * 整条胜出。这比原来「整个文件被覆盖」好了一个数量级，而且和脚本本地的语义
 * 完全一致；真要更细的粒度就得引入 per-field 版本号，那是另一回事了。
 * ========================================================================== */

function recStamp(r) {
  return Math.max(Number(r && r.updatedAt) || 0, Number(r && r.ts) || 0);
}
function msgStamp2(m) {
  return Math.max(Number(m && m.editedAt) || 0, Number(m && m.createdAt) || 0);
}

/** 一条记录出门前的脱敏。刻意不碰 jobUrl / jobId / site / id —— 换了链接就废了 */
function redactRecord(env, r) {
  if (!redactPairs(env).length) return r;
  const out = Object.assign({}, r);
  ['memo', 'followUpNote', 'company', 'title', 'sector', 'status'].forEach((k) => {
    if (typeof out[k] === 'string') out[k] = redactText(env, out[k]);
  });
  if (Array.isArray(out.memos)) {
    out.memos = out.memos.map((b) => ({ ts: b.ts, text: redactText(env, b.text) }));
  }
  if (Array.isArray(out.hirers)) {
    out.hirers = out.hirers.map((h) => Object.assign({}, h, {
      name: redactText(env, h.name), role: redactText(env, h.role),
    }));
  }
  return out;
}

/**
 * 给记录盖上「状态是什么时候变的」这个章 —— 当日速报只认它。
 * 推上来的整条记录里没有这个字段（脚本不一定是新版），所以在这里判：
 * 状态和仓库里的不一样 → 现在就是变的时刻；一样 → 把旧章原样带过去，
 * 别被一次写 MEMO 的同步顺手抹掉。
 */
function stampStatus(next, prev) {
  if (!prev) {
    // 新记录：投递那一刻就是它当前状态的起点
    return next.statusAt ? next : Object.assign({}, next, { statusAt: next.ts || next.updatedAt || Date.now() });
  }
  if (String(next.status || '') !== String(prev.status || '')) {
    return Object.assign({}, next, { statusAt: next.updatedAt || Date.now() });
  }
  const keep = next.statusAt || prev.statusAt;
  return keep ? Object.assign({}, next, { statusAt: keep }) : next;
}

function mergeIntoRepo(env, repo, incoming) {
  const dead = (incoming.deleted && typeof incoming.deleted === 'object') ? incoming.deleted : {};
  const stat = { recAdded: 0, recUpdated: 0, recRemoved: 0, msgAdded: 0, msgUpdated: 0, msgRemoved: 0 };

  /* ---- 记录 ---- */
  const byId = new Map();
  (repo.records || []).forEach((r) => { if (r && r.id) byId.set(r.id, r); });
  (incoming.records || []).forEach((r) => {
    if (!r || !r.id) return;
    if (dead[r.id]) return;                       // 这台机器删过，别又推回来
    const red = redactRecord(env, r);
    const cur = byId.get(r.id);
    if (!cur) { byId.set(r.id, stampStatus(red, null)); stat.recAdded++; return; }
    if (recStamp(red) >= recStamp(cur)) { byId.set(r.id, stampStatus(red, cur)); stat.recUpdated++; }
  });
  Object.keys(dead).forEach((id) => { if (byId.delete(id)) stat.recRemoved++; });
  repo.records = Array.from(byId.values());

  /* ---- 通知板留言 ---- */
  const mById = new Map();
  (repo.messages || []).forEach((m) => { if (m && m.id) mById.set(m.id, m); });
  (incoming.messages || []).forEach((m) => {
    if (!m || !m.id) return;
    if (dead[m.id]) return;
    const red = Object.assign({}, m, {
      text: redactText(env, m.text), author: redactText(env, m.author),
    });
    const cur = mById.get(m.id);
    if (!cur) { mById.set(m.id, red); stat.msgAdded++; return; }
    if (msgStamp2(red) >= msgStamp2(cur)) { mById.set(m.id, red); stat.msgUpdated++; }
  });
  Object.keys(dead).forEach((id) => { if (mById.delete(id)) stat.msgRemoved++; });
  repo.messages = Array.from(mById.values());

  /* ---- 状态定义 ----
   * 这一份是整体语义（顺序、改名、closed/advanced 这些标记），拆不成增量，
   * 而且很小、基本只有一台机器在维护，所以推上来就以它为准。 */
  if (Array.isArray(incoming.statusDefs) && incoming.statusDefs.length) {
    repo.statusDefs = incoming.statusDefs.map((d) => Object.assign({}, d, {
      name: redactText(env, d && d.name),
    }));
  }
  if (Array.isArray(incoming.statusOrder) && incoming.statusOrder.length) {
    repo.statusOrder = incoming.statusOrder.map((n) => redactText(env, n));
  }
  return stat;
}

/* ---- 预约队列 ------------------------------------------------------------
 * 队列本体在 BoardStore 里（storage 前缀 sch:），到点靠 DO 的 alarm() 触发，
 * 精度到秒。以前是 KV + 每 5 分钟一次 Cron 扫描：那条路每天要烧掉 288 次 list
 * （免费额度的 28.8%），而且最快也只能 5 分钟粒度。
 * -------------------------------------------------------------------------- */

async function listQueue(env) {
  try { return (await board(env, '/sch/list')).items || []; }
  catch (e) { return []; }
}


export default {
  async fetch(request, env, ctx) {
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
      const msg = redactMsg(env, parseUpdate(update));
      // 认不出来的 update 也回 200：回错误码 Telegram 会一直重投
      if (msg) {
        // 只收我们那个群 / 频道的，别人把 bot 拉进别的群也灌不进来
        if (!env.TG_CHAT || String(msg.chatId) === String(env.TG_CHAT)) {
          // 在 Telegram 里把消息编辑成 /del → 从看板上撤掉它
          if (msg.del) await inboxDelete(env, [msg.uid]);
          else await inboxAppend(env, msg);
        }
      }
      return new Response('ok');
    }

    /* ---- 图片代理 ----
     * Telegram 的文件下载地址里带着 Bot Token，绝不能下发到浏览器。
     * 所以由 Worker 拿 file_id 去换真实地址再把字节流回来，token 全程留在服务端。
     * <img> 请求不带 Origin、也不受 CORS 管，所以这里的门槛是
     * 「这个 file_id 必须确实出现在收件箱里」—— file_id 猜不出来，也就没法当白嫖代理用。 */
    if (url.pathname === '/tg/file') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('GET only', { status: 405 });
      }
      const fileId = url.searchParams.get('id') || '';
      if (!fileId || !env.TG_TOKEN) return new Response('not found', { status: 404 });
      if (!(await inboxFileAllowed(env, fileId))) return new Response('not found', { status: 404 });

      const meta = await fetch(`${TG_API}/bot${env.TG_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`)
        .then((r) => r.json()).catch(() => null);
      // getFile 只支持 20MB 以内；更大的文件拿不到 file_path
      if (!meta || !meta.ok || !meta.result || !meta.result.file_path) {
        return new Response('file unavailable', { status: 404 });
      }
      const upstream = await fetch(`${TG_API}/file/bot${env.TG_TOKEN}/${meta.result.file_path}`);
      if (!upstream.ok) return new Response('upstream ' + upstream.status, { status: 502 });

      const out = new Response(upstream.body, upstream);
      // file_path 一小时就失效，但我们每次都重新换，所以浏览器这边可以放心长缓存
      out.headers.set('Cache-Control', 'public, max-age=604800, immutable');
      out.headers.set('Access-Control-Allow-Origin', '*');
      out.headers.delete('Set-Cookie');
      return out;
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

    /* ---- 看板的 WebSocket ----
     * 数据一变就推一个 rev 过去，页面自己再拉一次。这条路取代了原来
     * 「等 GitHub Actions 部署完 index.html」的几十秒空窗。
     *
     * 这里不查 WRITE_KEY：WebSocket 握手带不上自定义头，而推过去的只有一个
     * 递增的 rev 数字，本身不含任何数据 —— 真要取内容还是得走 records_read。*/
    if (url.pathname === BOARD_WS_PATH) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({ ok: false, description: 'expected websocket upgrade' }, 426, headers);
      }
      if (!(allowed.includes('*') || allowed.includes(origin))) {
        return json({ ok: false, description: 'origin not allowed: ' + origin }, 403, headers);
      }
      const stub = boardStub(env);
      if (!stub) return json({ ok: false, description: 'BoardStore 未绑定，请用轮询' }, 501, headers);
      return await stub.fetch(request);
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
        total: data.total,
        gaps: data.gaps,                       // 没收到的 msgId 区间，页面据此提示怎么补
        live: data.live,                       // true = 走 DO，可以开 WebSocket
        wsPath: data.live ? WS_PATH : '',
        filePath: '/tg/file',                  // 图片代理
        hooked: !!env.WEBHOOK_SECRET,          // false = webhook 还没配，页面会提示
        now: Date.now()
      }, 200, headers);
    }

    /* ---- archive / 取回 ----
     * 存在服务端，不是各人的浏览器里：谁 archive 的，所有人看到的都一样。
     * 消息本身留着，只是从主视图里收起来。 */
    if (action === 'inbox_archive') {
      let uids = [];
      try { uids = JSON.parse(body.uids || '[]'); } catch (e) { uids = []; }
      if (!Array.isArray(uids) || !uids.length) {
        return json({ ok: false, description: 'missing uids' }, 400, headers);
      }
      const on = String(body.on == null ? '1' : body.on) !== '0';
      return json({ ok: true, changed: await inboxArchive(env, uids.slice(0, 500), on) }, 200, headers);
    }

    // ---- 从收件箱里彻底删掉某几条 / 全部清空（不碰 Telegram 里的原消息）----
    if (action === 'inbox_delete') {
      let uids = [];
      try { uids = JSON.parse(body.uids || '[]'); } catch (e) { uids = []; }
      if (!Array.isArray(uids) || !uids.length) {
        return json({ ok: false, description: 'missing uids' }, 400, headers);
      }
      return json({ ok: true, removed: await inboxDelete(env, uids.slice(0, 200)) }, 200, headers);
    }
    if (action === 'inbox_clear') {
      return json({ ok: true, removed: await inboxClear(env) }, 200, headers);
    }

    /* ---- 一次性：把收件箱里**现存**的消息按当前规则重新脱敏一遍 ----
     * webhook 那条路以前没过替换，所以历史消息里留着真名。修完代码只管新消息，
     * 旧的得跑这个。幂等，可以重复跑。 */
    if (action === 'inbox_redact') {
      if (!env.WRITE_KEY) {
        return json({ ok: false, description: 'WRITE_KEY 未配置，这个入口默认关闭' }, 501, headers);
      }
      if (request.headers.get('X-Write-Key') !== env.WRITE_KEY) {
        return json({ ok: false, description: '写入密钥不对' }, 403, headers);
      }
      if (!redactPairs(env).length) {
        return json({ ok: false, description: 'REDACT_RULES 没配，没有规则可用' }, 501, headers);
      }
      const all = await inboxList(env, 0);
      let changed = 0;
      for (const m of (all.items || [])) {
        const red = redactMsg(env, m);
        if (JSON.stringify(red) === JSON.stringify(m)) continue;
        await inboxAppend(env, red);         // 同一个 uid，覆盖写
        changed++;
      }
      return json({ ok: true, scanned: (all.items || []).length, changed: changed }, 200, headers);
    }

    /* ---- 看板运行时拉数据 ----
     * 以前这份是 build.py 烤进 index.html 的，等于挂在公开的 GitHub Pages 上。
     * 现在构建产物只剩空壳，数据要带 WRITE_KEY 来这里取。 */
    if (action === 'records_read') {
      if (!env.WRITE_KEY) {
        return json({ ok: false, description: 'WRITE_KEY 未配置，这个入口默认关闭' }, 501, headers);
      }
      if (request.headers.get('X-Write-Key') !== env.WRITE_KEY) {
        return json({ ok: false, description: '写入密钥不对' }, 403, headers);
      }
      if (!env.BOARD) return json({ ok: false, description: 'BoardStore 未绑定' }, 501, headers);

      let doc = await board(env, '/doc');
      // 第一次跑：DO 还是空的，把 GitHub 上那份搬进来
      if (!doc.records.length && !doc.messages.length) {
        try { await seedBoardFromGitHub(env); doc = await board(env, '/doc'); }
        catch (e) { return json({ ok: false, description: '导入失败：' + String(e.message || e) }, 502, headers); }
      }
      const rev = Number(body.rev || 0);
      // 页面手里已经是最新的就只回一个 rev，省掉几十 KB 的往返
      if (rev && rev === doc.rev) return json({ ok: true, rev: doc.rev, unchanged: true }, 200, headers);

      // 清洗放在出库这一步 —— 页面拿到的形状和 build.py 时代逐字段一致
      const view = normalizeDoc(doc);
      return json({
        ok: true,
        rev: doc.rev,
        updatedAt: view.updatedAt,
        count: view.records.length,
        records: view.records,
        messages: view.messages,
        statusDefs: view.statusDefs,
        statuses: view.statuses,
        wsPath: BOARD_WS_PATH,
      }, 200, headers);
    }

    /* ---- 看板上的零散改动（MEMO / 跟进提醒 / 处理期限）----
     * 落到 DO 里，串行执行、强一致；GitHub 那份改成事后异步镜像，
     * 所以这里不再有「读 → 改 → PUT 撞 409 → 重来」那个循环。 */
    if (action === 'records_write') {
      if (!env.WRITE_KEY) {
        return json({ ok: false, description: 'WRITE_KEY 未配置，这个入口默认关闭' }, 501, headers);
      }
      if (request.headers.get('X-Write-Key') !== env.WRITE_KEY) {
        return json({ ok: false, description: '写入密钥不对' }, 403, headers);
      }
      if (!env.BOARD) return json({ ok: false, description: 'BoardStore 未绑定' }, 501, headers);

      let ops = [];
      try { ops = JSON.parse(body.ops || '[]'); } catch (e) { ops = []; }
      if (!Array.isArray(ops) || !ops.length) {
        return json({ ok: false, description: 'missing ops' }, 400, headers);
      }
      ops = ops.slice(0, 100);

      const res = await board(env, '/ops', { ops: ops });
      if (res.applied.length) {
        // 备份是后台的事，别让用户等 GitHub
        ctx.waitUntil(mirrorToGitHub(env,
          'chore(board): ' + res.applied.length + ' 项来自看板的改动'));
      }
      return json({ ok: true, applied: res.applied, skipped: res.skipped,
                    rev: res.rev, committed: !!res.applied.length }, 200, headers);
    }

    /* ---- 油猴脚本的整份同步：合并进仓库，而不是覆盖 ---- */
    if (action === 'records_merge') {
      if (!env.WRITE_KEY) {
        return json({ ok: false, description: 'WRITE_KEY 未配置，这个入口默认关闭' }, 501, headers);
      }
      if (request.headers.get('X-Write-Key') !== env.WRITE_KEY) {
        return json({ ok: false, description: '写入密钥不对' }, 403, headers);
      }
      if (!env.BOARD) return json({ ok: false, description: 'BoardStore 未绑定' }, 501, headers);
      const pick = (k) => { try { return JSON.parse(body[k] || 'null'); } catch (e) { return null; } };
      const incoming = {
        records: pick('records') || [],
        messages: pick('messages') || [],
        deleted: pick('deleted') || {},
        statusDefs: pick('statusDefs') || [],
        statusOrder: pick('statusOrder') || [],
      };
      if (!Array.isArray(incoming.records)) {
        return json({ ok: false, description: 'records 不是数组' }, 400, headers);
      }
      /* 空清单直接拒掉。一台刚装好、本机还没有任何记录的机器要是同步一次，
         合并本身不会删东西（缺席 ≠ 删除），但这通常意味着配置错了 —— 早点报出来。 */
      if (!incoming.records.length && !Object.keys(incoming.deleted).length) {
        return json({ ok: false, description: '这台机器一条记录都没有，拒绝同步（避免误操作）' }, 400, headers);
      }

      // 首次跑：DO 还空着的话，先把 GitHub 上那份搬进来当底，
      // 否则这台机器推上来的就成了唯一一份，仓库里的历史会被当成「没有」。
      const cur = await board(env, '/doc');
      if (!cur.records.length && !cur.messages.length) {
        try { await seedBoardFromGitHub(env); }
        catch (e) { return json({ ok: false, description: '导入失败：' + String(e.message || e) }, 502, headers); }
      }

      // 合并在 DO 内部串行完成，多台机器同时推也不会互相抹掉
      const res = await board(env, '/merge', { incoming: incoming });
      const touched = Object.values(res.stat || {}).some((n) => n > 0);
      if (touched) {
        ctx.waitUntil(mirrorToGitHub(env,
          'chore(records): ' + res.counts.records + ' 条投递记录 / '
          + res.counts.messages + ' 条留言（合并）'));
      }
      return json({ ok: true, stat: res.stat, rev: res.rev, committed: touched }, 200, headers);
    }

    /* ---- 外部来源直接推一条进收件箱（Mac 上的 iMessage 桥用）----
     * 为什么不走「发给 Telegram，再靠 webhook 回流」这条现成的路：
     * **bot 收不到自己发的消息**。实测收件箱里以 #SGJOB 开头的一条都没有，
     * 而那些正是 bot 自己发出去的；连 24 小时窗口内的也没进来。
     * 所以要让频道页看到，必须直接写收件箱。
     *
     * 这个入口没有 Origin 可依赖（脚本不是浏览器），所以用独立的 INGEST_KEY，
     * 没配就整个关掉 —— 失败时关闭，不给 Worker 开新的口子。 */
    if (action === 'inbox_push') {
      if (!env.INGEST_KEY) {
        return json({ ok: false, description: 'INGEST_KEY 未配置，这个入口默认关闭' }, 501, headers);
      }
      if (request.headers.get('X-Ingest-Key') !== env.INGEST_KEY) {
        return json({ ok: false, description: 'bad ingest key' }, 403, headers);
      }
      const text = String(body.text || '').slice(0, 4000);
      if (!text) return json({ ok: false, description: 'missing text' }, 400, headers);

      const src = String(body.source || '外部').slice(0, 40);
      const msg = {
        // 外部来源的 uid 单独打前缀，不会和 Telegram 的 <chatId>:<msgId> 撞
        uid: 'ext:' + (String(body.id || '') || Date.now().toString(36)),
        chatId: String(env.TG_CHAT || ''),
        chatTitle: src,
        msgId: 0,                       // 不参与 msgId 缺号统计
        ts: Number(body.ts) || Date.now(),
        editedTs: 0,
        author: String(body.author || '').slice(0, 60),
        bot: false,
        kind: String(body.kind || '').slice(0, 60),
        text: text,
        replyText: String(body.replyText || '').slice(0, 120),
        media: null,
      };
      await inboxAppend(env, redactMsg(env, msg));

      // 顺手也发一条到 Telegram，这样手机上有推送
      let tg = null;
      if (String(body.tg || '') === '1' && env.TG_TOKEN) {
        const head = HEADER_PREFIX + ' ' + src + (msg.author ? ('　' + msg.author) : '');
        tg = await tgSend(env, (head + '\n\n' + text).slice(0, MAX_LEN));
      }
      return json({ ok: true, uid: msg.uid, telegram: tg ? !!tg.ok : null }, 200, headers);
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
      if (!env.BOARD) return json({ ok: false, description: 'BoardStore 未绑定，定时功能不可用' }, 501, headers);
      const items = await listQueue(env);
      return json({ ok: true, items: items.map(i => ({ id: i.id, at: i.at, text: i.text, meta: i.meta || {} })) }, 200, headers);
    }

    // ---- 取消 / 立刻发送 ----
    if (action === 'cancel' || action === 'sendnow') {
      if (!env.BOARD) return json({ ok: false, description: 'BoardStore 未绑定，定时功能不可用' }, 501, headers);
      const id = String(body.id || '');
      if (!id) return json({ ok: false, description: 'missing id' }, 400, headers);

      if (action === 'sendnow') {
        // 先看一眼正文，发出去了才真的出队 —— 发送失败时预约得留着
        const items = await listQueue(env);
        const hit = items.find((i) => i.id === id);
        if (!hit) return json({ ok: false, description: 'not found' }, 404, headers);
        const data = await tgSend(env, hit.text);
        if (!data.ok) return json(data, 502, headers);
      }
      const gone = (await board(env, '/sch/del', { id: id })).item;
      if (!gone && action === 'cancel') return json({ ok: false, description: 'not found' }, 404, headers);
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
      if (!env.BOARD) return json({ ok: false, description: 'BoardStore 未绑定，定时功能不可用' }, 501, headers);
      const at = Number(body.at);
      if (!at || !isFinite(at)) return json({ ok: false, description: 'missing at' }, 400, headers);
      if (at > Date.now() + MAX_AHEAD_MS) {
        return json({ ok: false, description: '排得太远了（最多 180 天）' }, 400, headers);
      }
      if ((await listQueue(env)).length >= MAX_QUEUE) {
        return json({ ok: false, description: '队列已满（上限 ' + MAX_QUEUE + ' 条）' }, 429, headers);
      }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      let meta = {};
      try { meta = body.meta ? JSON.parse(body.meta) : {}; } catch (e) { meta = {}; }
      const item = { id: id, at: at, text: text, createdAt: Date.now(), meta: meta };
      // DO 那边落库之后顺手把 alarm 对到最早的一条，不再依赖 Cron 扫描
      await board(env, '/sch/add', { item: item });
      return json({ ok: true, id: id, at: at }, 200, headers);
    }

    // ---- 立即发送 ----
    const data = await tgSend(env, text);
    return json(data, data.ok ? 200 : 502, headers);
  },

  /**
   * Cron 现在只剩当日速报这一件事。
   *
   * 预约发送已经交给 BoardStore 的 alarm()（精确到秒），所以 Cron 不必再每
   * 5 分钟扫一遍队列 —— 触发频率也跟着从「全天 288 次」收窄成「JST 傍晚
   * 那几个小时里 12 次」，见 wrangler.toml 的 crons。
   */
  async scheduled(event, env, ctx) {
    if (!env.BOARD || !env.TG_TOKEN) return;
    const now = Date.now();

    const jstNow = new Date(now + 9 * 3600000);
    const mins = jstNow.getUTCHours() * 60 + jstNow.getUTCMinutes();
    if (mins < REPORT_HOUR * 60 + REPORT_MIN) return;
    if (await reportSent(env, now)) return;
    if ((await board(env, '/rep/get', { key: reportEmptyKey(now) })).val) return;

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
      await board(env, '/rep/put', { key: reportEmptyKey(now), val: { at: now } });
    }
  }
};
