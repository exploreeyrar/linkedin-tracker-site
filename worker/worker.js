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

  /** Cron 触发：把到点的消息发出去 */
  async scheduled(event, env, ctx) {
    if (!env.SCHEDULE || !env.TG_TOKEN) return;
    const now = Date.now();
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
