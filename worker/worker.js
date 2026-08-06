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
 * 受理条件（收紧后，即使 Worker URL 泄漏也发不出任意内容）：
 *   - 只接受 POST
 *   - Origin 必须在 ALLOWED_ORIGINS 里
 *   - 正文必须以 "#SGJOB" 开头
 *   - 正文不超过 4096 字
 *   - 设置了 APP_KEY 时，X-App-Key 头必须一致（可选，建议开）
 */

const TG_API = 'https://api.telegram.org';
const HEADER_PREFIX = '#SGJOB';
const MAX_LEN = 4096;
const MAX_QUEUE = 200;                 // 队列上限，防止被灌爆
const MAX_AHEAD_MS = 180 * 86400000;   // 最多排到 180 天后

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
// 这两种不算「新情况」：状态还停在已投递等联络的，和当天刚投还没动过的
const REPORT_SKIP_STATUS = { '已投递等联络': 1 };

/** JST 的今天，形如 2026-08-06 */
function jstDate(now) {
  return new Date((now || Date.now()) + 9 * 3600000).toISOString().slice(0, 10);
}

/** JST 当天 0 点对应的 UTC 毫秒 */
function jstDayStart(now) {
  const d = jstDate(now);
  return Date.parse(d + 'T00:00:00+09:00');
}

function reportKey(now) { return 'report:' + jstDate(now); }

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

/** 拉取看板数据源（油猴脚本推上去的那份 records.json） */
async function fetchRecords(env) {
  const url = env.RECORDS_URL;
  if (!url) return null;
  const res = await fetch(url, { headers: { 'User-Agent': 'sgjob-worker' } });
  if (!res.ok) return null;
  const blob = await res.json().catch(() => null);
  if (!blob) return null;
  return Array.isArray(blob) ? blob : (blob.records || []);
}

/**
 * 把当天有状态变化的记录整理成一条简报。
 * 没有变化就返回 null —— 没消息就不发，别每天定时打扰。
 */
function buildReport(records, now, boardUrl) {
  const start = jstDayStart(now);
  const end = start + 86400000;
  const hits = (records || []).filter((r) => {
    if (!r || !r.updatedAt) return false;                 // 没改过（含当天新投的）
    if (r.updatedAt < start || r.updatedAt >= end) return false;
    return !REPORT_SKIP_STATUS[r.status];
  });
  if (!hits.length) return null;

  // 按状态归类，同状态内按更新时间从新到旧
  const groups = new Map();
  hits.sort((a, b) => b.updatedAt - a.updatedAt).forEach((r) => {
    if (!groups.has(r.status)) groups.set(r.status, []);
    groups.get(r.status).push(r);
  });

  const lines = [
    HEADER_PREFIX + ' ' + REPORT_TITLE,
    jstDate(now) + '（JST）　共 ' + hits.length + ' 家有新情况',
  ];
  for (const [status, list] of groups) {
    lines.push('', '▸ ' + status + '（' + list.length + '）');
    list.forEach((r) => {
      const who = (r.company || '—') + ' / ' + (r.title || '—');
      lines.push('  · ' + who);
      // 当天写的 MEMO 里挑最新的一条，截短了当作变化要点
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

    // ---- 当日速报：状态 / 预览 / 发送 ----
    if (action === 'report_status' || action === 'report_preview' || action === 'report_send') {
      const sentRaw = await reportSent(env, Date.now());
      let sent = null;
      if (sentRaw) { try { sent = JSON.parse(sentRaw); } catch (e) { sent = { at: 0 }; } }

      if (action === 'report_status') {
        return json({ ok: true, date: jstDate(), sent: !!sent, sentAt: sent ? sent.at : 0 }, 200, headers);
      }

      const records = await fetchRecords(env);
      if (!records) {
        return json({ ok: false, description: 'RECORDS_URL 未配置或拉取失败' }, 501, headers);
      }
      const text = buildReport(records, Date.now(), env.BOARD_URL || '');

      if (action === 'report_preview') {
        return json({ ok: true, date: jstDate(), sent: !!sent, text: text || '' }, 200, headers);
      }
      // ---- report_send ----
      if (sent) {
        return json({ ok: false, description: '今天已经发过了（' + jstDate() + '）' }, 409, headers);
      }
      if (!text) {
        return json({ ok: false, description: '今天没有新情况，不发' }, 200, headers);
      }
      if (!env.TG_TOKEN) {
        return json({ ok: false, description: 'TG_TOKEN is not configured on the worker' }, 500, headers);
      }
      const sendRes = await tgSend(env, text);
      if (sendRes.ok) await markReportSent(env, Date.now(), 'manual');
      return json(sendRes, sendRes.ok ? 200 : 502, headers);
    }

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
    if (mins >= REPORT_HOUR * 60 + REPORT_MIN && !(await reportSent(env, now))) {
      const records = await fetchRecords(env);
      const text = records ? buildReport(records, now, env.BOARD_URL || '') : null;
      if (text) {
        const r = await tgSend(env, text);
        if (r.ok) await markReportSent(env, now, 'auto');
      } else if (records) {
        // 今天没有新情况：也打上标记，免得每 5 分钟重新拉一次数据
        await markReportSent(env, now, 'empty');
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
