var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var TG_API = "https://api.telegram.org";
var HEADER_PREFIX = "#SGJOB";
var MAX_LEN = 4096;
var MAX_QUEUE = 200;
var MAX_AHEAD_MS = 180 * 864e5;
var WEBHOOK_PATH = "/tg/webhook";
var WS_PATH = "/channel/ws";
var INBOX_MAX = 500;
var INBOX_ROOM = "main";
function corsHeaders(origin, allowed) {
  const permitted = allowed.includes("*") || allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": permitted ? origin || "null" : "https://example.invalid",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
__name(corsHeaders, "corsHeaders");
function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers)
  });
}
__name(json, "json");
async function readBody(request) {
  const ct = request.headers.get("Content-Type") || "";
  if (ct.includes("application/json")) {
    return await request.json().catch(() => ({}));
  }
  const form = await request.formData().catch(() => null);
  if (!form) return {};
  const out = {};
  for (const [k, v] of form.entries()) out[k] = String(v);
  return out;
}
__name(readBody, "readBody");
async function tgSend(env, text) {
  const res = await fetch(`${TG_API}/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT, text, disable_web_page_preview: true })
  });
  return await res.json().catch(() => ({ ok: false, description: "invalid response from Telegram" }));
}
__name(tgSend, "tgSend");
var REPORT_HOUR = 21;
var REPORT_MIN = 30;
var REPORT_TITLE = "\u5F53\u65E5\u65B0\u60C5\u51B5\u7684\u901F\u62A5";
var REPORT_SKIP_FALLBACK = "\u5DF2\u6295\u9012\u7B49\u8054\u7EDC";
function reportSkipSet(data) {
  const defs = data && data.statusDefs || [];
  const hit = defs.filter((d) => d && d.role === "default").map((d) => d.name);
  const out = /* @__PURE__ */ Object.create(null);
  (hit.length ? hit : [REPORT_SKIP_FALLBACK]).forEach((n) => {
    out[n] = 1;
  });
  return out;
}
__name(reportSkipSet, "reportSkipSet");
var DEFAULT_STATUS_ORDER = [
  "\u7B49\u5DF1\u65B9\u5904\u7406(XR ball)",
  "\u7B49\u5DF1\u65B9\u5904\u7406(\u5DF1 ball)",
  "\u5DF2\u5B89\u6392\u9762\u8BD5\u3001\u9762\u8BD5\u51C6\u5907\u4E2D",
  "\u5BFE\u65B9\u6765\u8054\u7EDC\u4E86",
  "\u56DB\u6B21\u9762\u8BD5\u901A\u8FC7\u3001\u7B49\u5BF9\u65B9\u5B89\u6392\u4E0B\u4E00\u8F6E",
  "\u4E09\u6B21\u9762\u8BD5\u901A\u8FC7\u3001\u7B49\u5BF9\u65B9\u5B89\u6392\u4E0B\u4E00\u8F6E",
  "\u4E8C\u6B21\u9762\u8BD5\u901A\u8FC7\u3001\u7B49\u5BF9\u65B9\u5B89\u6392\u4E0B\u4E00\u8F6E",
  "\u4E00\u6B21\u9762\u8BD5\u901A\u8FC7\u3001\u7B49\u5BFE\u65B9\u5B89\u6392\u4E0B\u4E00\u8F6E",
  "\u4E00\u6B21\u4EBA\u4E8B\u9762\u8C08\u7ED3\u675F\u3001\u7B49\u5BF9\u65B9\u8054\u7EDC",
  "\u5185\u5B9A",
  "\u4EBA\u4E8B Offer Call",
  "\u5DF2\u6295\u9012\u7B49\u8054\u7EDC",
  "\u9762\u8BD5\u843D\u4E86",
  "\u4E66\u7C7B\u843D\u4E86",
  "\u5BF9\u65B9\u62DB\u5230\u4EBA\u4E86",
  "\u65E0\u6D88\u606F\u7591\u4F3C\u4E66\u7C7B\u843D\u4E86"
];
function jstDate(now) {
  return new Date((now || Date.now()) + 9 * 36e5).toISOString().slice(0, 10);
}
__name(jstDate, "jstDate");
function jstDayStart(now) {
  const d = jstDate(now);
  return Date.parse(d + "T00:00:00+09:00");
}
__name(jstDayStart, "jstDayStart");
function prevReportBoundary(now) {
  return jstDayStart(now) - 864e5 + (REPORT_HOUR * 60 + REPORT_MIN) * 6e4;
}
__name(prevReportBoundary, "prevReportBoundary");
function reportKey(now) {
  return "report:" + jstDate(now);
}
__name(reportKey, "reportKey");
var REPORT_CURSOR_KEY = "report:cursor";
function reportEmptyKey(now) {
  return "reportempty:" + jstDate(now);
}
__name(reportEmptyKey, "reportEmptyKey");
async function reportSent(env, now) {
  if (!env.SCHEDULE) return null;
  return await env.SCHEDULE.get(reportKey(now));
}
__name(reportSent, "reportSent");
async function markReportSent(env, now, by) {
  if (!env.SCHEDULE) return;
  await env.SCHEDULE.put(
    reportKey(now),
    JSON.stringify({ at: Date.now(), by: by || "auto" }),
    { expirationTtl: 3 * 86400 }
  );
}
__name(markReportSent, "markReportSent");
async function reportWindowStart(env, now) {
  const fallback = prevReportBoundary(now);
  if (!env.SCHEDULE) return fallback;
  const raw = await env.SCHEDULE.get(REPORT_CURSOR_KEY);
  if (!raw) return fallback;
  let at = 0;
  try {
    at = Number(JSON.parse(raw).at) || 0;
  } catch (e) {
    at = 0;
  }
  if (!at || at > now || at < now - 7 * 864e5) return fallback;
  return at;
}
__name(reportWindowStart, "reportWindowStart");
async function saveReportCursor(env, end) {
  if (!env.SCHEDULE) return;
  await env.SCHEDULE.put(
    REPORT_CURSOR_KEY,
    JSON.stringify({ at: end }),
    { expirationTtl: 30 * 86400 }
  );
}
__name(saveReportCursor, "saveReportCursor");
async function fetchRecords(env) {
  const url = env.RECORDS_URL;
  if (!url) return null;
  const res = await fetch(url, { headers: { "User-Agent": "sgjob-worker" } });
  if (!res.ok) return null;
  const blob = await res.json().catch(() => null);
  if (!blob) return null;
  if (Array.isArray(blob)) return { records: blob, statusOrder: DEFAULT_STATUS_ORDER, statusDefs: [] };
  const defs = Array.isArray(blob.statusDefs) ? blob.statusDefs : [];
  let order = defs.length ? defs.map((d) => d && d.name).filter(Boolean) : [];
  if (!order.length) {
    order = Array.isArray(blob.statusOrder) && blob.statusOrder.length ? blob.statusOrder : DEFAULT_STATUS_ORDER;
  }
  return { records: blob.records || [], statusOrder: order, statusDefs: defs };
}
__name(fetchRecords, "fetchRecords");
function listOrderComparator(statusOrder) {
  const rank = /* @__PURE__ */ new Map();
  (statusOrder || DEFAULT_STATUS_ORDER).forEach((s, i) => rank.set(s, i));
  const rankOf = /* @__PURE__ */ __name((s) => rank.has(s) ? rank.get(s) : rank.size, "rankOf");
  return (a, b) => {
    const p = (Number(b.priority) || 0) - (Number(a.priority) || 0);
    if (p !== 0) return p;
    const d = rankOf(a.status) - rankOf(b.status);
    if (d !== 0) return d;
    return (b.updatedAt || b.ts || 0) - (a.updatedAt || a.ts || 0);
  };
}
__name(listOrderComparator, "listOrderComparator");
function buildReport(data, now, boardUrl, start) {
  const records = data && data.records || [];
  const end = now || Date.now();
  const skip = reportSkipSet(data);
  const hits = records.filter((r) => {
    if (!r || !r.updatedAt) return false;
    if (r.updatedAt < start || r.updatedAt > end) return false;
    return !skip[r.status];
  });
  if (!hits.length) return null;
  const defOrder = (data && data.statusDefs || []).map((d) => d && d.name).filter(Boolean);
  const cmp = listOrderComparator(defOrder.length ? defOrder : data && data.statusOrder);
  const groups = /* @__PURE__ */ new Map();
  hits.sort(cmp).forEach((r) => {
    if (!groups.has(r.status)) groups.set(r.status, []);
    groups.get(r.status).push(r);
  });
  const fmt = /* @__PURE__ */ __name((ms) => new Date(ms + 9 * 36e5).toISOString().slice(0, 16).replace("T", " "), "fmt");
  const lines = [
    HEADER_PREFIX + " " + REPORT_TITLE,
    jstDate(now) + "\uFF08JST\uFF09\u3000\u5171 " + hits.length + " \u5BB6\u6709\u65B0\u60C5\u51B5",
    "\u7EDF\u8BA1\u8303\u56F4\uFF1A" + fmt(start) + " \uFF5E " + fmt(end) + "\uFF08JST\uFF09"
  ];
  for (const [status, list] of groups) {
    lines.push("", "\u25B8 " + status + "\uFF08" + list.length + "\uFF09");
    list.forEach((r) => {
      const star = Number(r.priority) || 0 ? "  " + "\u2728".repeat(Number(r.priority)) : "";
      lines.push("  \xB7 " + (r.company || "\u2014") + " / " + (r.title || "\u2014") + star);
      if (r.jobUrl) lines.push("    " + r.jobUrl);
      const memo = latestMemoOfDay(r, start, end);
      if (memo) lines.push("    " + memo.slice(0, 120) + (memo.length > 120 ? "\u2026" : ""));
    });
  }
  if (boardUrl) lines.push("", "\u770B\u677F\uFF1A" + boardUrl);
  let text = lines.join("\n");
  if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN - 12) + "\n\u2026\uFF08\u5DF2\u622A\u65AD\uFF09";
  return text;
}
__name(buildReport, "buildReport");
function latestMemoOfDay(r, start, end) {
  const blocks = Array.isArray(r.memos) ? r.memos : [];
  const today = blocks.filter((b) => b && b.text && b.ts >= start && b.ts < end).sort((a, b) => b.ts - a.ts);
  return today.length ? String(today[0].text).replace(/\s+/g, " ").trim() : "";
}
__name(latestMemoOfDay, "latestMemoOfDay");
var DEL_MARKS = ["/del", "/delete", "\u5220\u9664"];
function thumbOf(x) {
  return x && (x.thumbnail || x.thumb);
}
__name(thumbOf, "thumbOf");
function mediaOf(m) {
  if (m.photo && m.photo.length) {
    const best = m.photo[m.photo.length - 1];
    return { kind: "photo", fileId: best.file_id, w: best.width || 0, h: best.height || 0 };
  }
  if (m.sticker) {
    const t2 = thumbOf(m.sticker);
    const use = m.sticker.is_animated || m.sticker.is_video ? t2 : m.sticker;
    if (use) return { kind: "photo", fileId: use.file_id, w: use.width || 0, h: use.height || 0 };
  }
  if (m.document && /^image\//i.test(m.document.mime_type || "")) {
    return { kind: "photo", fileId: m.document.file_id, w: 0, h: 0 };
  }
  const t = thumbOf(m.video) || thumbOf(m.animation) || thumbOf(m.document) || thumbOf(m.audio);
  if (t) return { kind: "thumb", fileId: t.file_id, w: t.width || 0, h: t.height || 0 };
  return null;
}
__name(mediaOf, "mediaOf");
function parseUpdate(u) {
  if (!u || typeof u !== "object") return null;
  const edited = u.edited_channel_post || u.edited_message;
  const m = u.channel_post || u.message || edited;
  if (!m || !m.chat) return null;
  const text = String(m.text || m.caption || "");
  let kind = "";
  if (m.photo) kind = "\u{1F5BC} \u56FE\u7247";
  else if (m.video) kind = "\u{1F3AC} \u89C6\u9891";
  else if (m.animation) kind = "\u{1F39E} \u52A8\u56FE";
  else if (m.voice) kind = "\u{1F3A4} \u8BED\u97F3";
  else if (m.audio) kind = "\u{1F3B5} \u97F3\u9891";
  else if (m.video_note) kind = "\u{1F4F9} \u89C6\u9891\u7559\u8A00";
  else if (m.sticker) kind = "\u{1FA79} \u8D34\u7EB8 " + (m.sticker.emoji || "");
  else if (m.document) kind = "\u{1F4CE} \u6587\u4EF6 " + (m.document.file_name || "");
  else if (m.poll) kind = "\u{1F4CA} \u6295\u7968 " + (m.poll.question || "");
  else if (m.location || m.venue) kind = "\u{1F4CD} \u4F4D\u7F6E";
  else if (m.contact) kind = "\u{1F464} \u8054\u7CFB\u4EBA " + (m.contact.first_name || "");
  else if (m.new_chat_members) kind = "\u{1F44B} \u6709\u4EBA\u52A0\u5165";
  else if (m.left_chat_member) kind = "\u{1F6AA} \u6709\u4EBA\u79BB\u5F00";
  else if (m.pinned_message) kind = "\u{1F4CC} \u7F6E\u9876\u4E86\u4E00\u6761\u6D88\u606F";
  else if (m.new_chat_title) kind = "\u270F\uFE0F \u6539\u540D\u4E3A " + m.new_chat_title;
  else if (!text) kind = "\u2753 \u8FD9\u4E2A\u7C7B\u578B\u8FD8\u6CA1\u9002\u914D";
  const from = m.from || {};
  const author = m.author_signature || [from.first_name, from.last_name].filter(Boolean).join(" ") || (from.username ? "@" + from.username : "") || m.sender_chat && m.sender_chat.title || "";
  const reply = m.reply_to_message;
  return {
    // 同一条消息被编辑时 uid 不变，前端按 uid 覆盖即可
    uid: String(m.chat.id) + ":" + m.message_id,
    chatId: String(m.chat.id),
    chatTitle: String(m.chat.title || m.chat.username || m.chat.first_name || ""),
    msgId: m.message_id,
    ts: (Number(m.date) || Math.floor(Date.now() / 1e3)) * 1e3,
    editedTs: edited ? Date.now() : 0,
    author: String(author).slice(0, 60),
    bot: !!from.is_bot,
    kind: kind.trim().slice(0, 60),
    text: text.slice(0, 4e3),
    replyText: reply ? String(reply.text || reply.caption || "").slice(0, 120) : "",
    media: mediaOf(m),
    // 编辑成 /del 就是要把它从看板上撤掉
    del: !!edited && DEL_MARKS.indexOf(text.trim().toLowerCase()) !== -1
  };
}
__name(parseUpdate, "parseUpdate");
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
__name(msgIdGaps, "msgIdGaps");
function inboxKey(msg) {
  return "in:" + String(msg.ts).padStart(13, "0") + ":" + msg.uid;
}
__name(inboxKey, "inboxKey");
function inboxStub(env) {
  if (!env.INBOX) return null;
  return env.INBOX.get(env.INBOX.idFromName(INBOX_ROOM));
}
__name(inboxStub, "inboxStub");
async function kvInboxAppend(env, msg) {
  if (!env.SCHEDULE) return;
  await env.SCHEDULE.put(
    inboxKey(msg),
    JSON.stringify(msg),
    { expirationTtl: 180 * 86400 }
  );
  if (msg.media && msg.media.fileId) {
    await env.SCHEDULE.put("fid:" + msg.media.fileId, "1", { expirationTtl: 180 * 86400 });
  }
}
__name(kvInboxAppend, "kvInboxAppend");
async function kvInboxDelete(env, uids) {
  if (!env.SCHEDULE) return [];
  const all = await kvInboxList(env, 0);
  const hit = [];
  for (const m of all) {
    if (uids.indexOf(m.uid) === -1) continue;
    await env.SCHEDULE.delete(inboxKey(m));
    if (m.media && m.media.fileId) await env.SCHEDULE.delete("fid:" + m.media.fileId);
    hit.push(m.uid);
  }
  return hit;
}
__name(kvInboxDelete, "kvInboxDelete");
async function kvFileAllowed(env, fileId) {
  if (!env.SCHEDULE) return false;
  return !!await env.SCHEDULE.get("fid:" + fileId);
}
__name(kvFileAllowed, "kvFileAllowed");
async function kvInboxList(env, since) {
  if (!env.SCHEDULE) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.SCHEDULE.list({ prefix: "in:", limit: 1e3, cursor });
    for (const k of page.keys) {
      const raw = await env.SCHEDULE.get(k.name);
      if (!raw) continue;
      try {
        const m = JSON.parse(raw);
        if (!since || (m.editedTs || m.ts) > since) out.push(m);
      } catch (e) {
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-INBOX_MAX);
}
__name(kvInboxList, "kvInboxList");
var ChannelInbox = class {
  static {
    __name(this, "ChannelInbox");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(payload);
      } catch (e) {
      }
    }
  }
  async append(msg) {
    await this.state.storage.put(inboxKey(msg), msg);
    if (msg.media && msg.media.fileId) {
      await this.state.storage.put("fid:" + msg.media.fileId, 1);
    }
    const all = await this.state.storage.list({ prefix: "in:" });
    if (all.size > INBOX_MAX) {
      const keys = [...all.keys()].slice(0, all.size - INBOX_MAX);
      await this.state.storage.delete(keys);
    }
    this.broadcast({ type: "msg", items: [msg] });
  }
  /** 按 uid 删除。返回真正删掉的 uid，好让页面知道该抹掉哪几条 */
  async remove(uids) {
    const all = await this.state.storage.list({ prefix: "in:" });
    const hit = [], keys = [];
    for (const [k, m] of all) {
      if (!m || uids.indexOf(m.uid) === -1) continue;
      hit.push(m.uid);
      keys.push(k);
      if (m.media && m.media.fileId) keys.push("fid:" + m.media.fileId);
    }
    if (keys.length) await this.state.storage.delete(keys);
    if (hit.length) this.broadcast({ type: "del", uids: hit });
    return hit;
  }
  /**
   * archive / 取回。存在服务端而不是各自的浏览器里 ——
   * 这样谁 archive 的，所有人看到的都一样，且立刻广播出去。
   */
  async setArchived(uids, on) {
    const all = await this.state.storage.list({ prefix: "in:" });
    const hit = [];
    for (const [k, m] of all) {
      if (!m || uids.indexOf(m.uid) === -1) continue;
      m.archivedAt = on ? Date.now() : 0;
      await this.state.storage.put(k, m);
      hit.push(m.uid);
    }
    if (hit.length) this.broadcast({ type: "arch", uids: hit, on: !!on, at: Date.now() });
    return hit;
  }
  async clear() {
    const all = await this.state.storage.list({ prefix: "in:" });
    const uids = [...all.values()].map((m) => m && m.uid).filter(Boolean);
    await this.state.storage.deleteAll();
    this.broadcast({ type: "del", uids });
    return uids.length;
  }
  async fileAllowed(fileId) {
    return !!await this.state.storage.get("fid:" + fileId);
  }
  async list(since) {
    const all = await this.state.storage.list({ prefix: "in:" });
    const out = [];
    for (const m of all.values()) {
      if (!since || (m.editedTs || m.ts) > since) out.push(m);
    }
    out.sort((a, b) => a.ts - b.ts);
    return out.slice(-INBOX_MAX);
  }
  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const url = new URL(request.url);
    if (url.pathname === "/push") {
      const msg = await request.json().catch(() => null);
      if (!msg) return new Response("bad", { status: 400 });
      await this.append(msg);
      return new Response("ok");
    }
    if (url.pathname === "/archive") {
      const body = await request.json().catch(() => null);
      const uids = body && Array.isArray(body.uids) ? body.uids : [];
      const hit = await this.setArchived(uids, !!(body && body.on));
      return new Response(JSON.stringify({ changed: hit }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/delete") {
      const body = await request.json().catch(() => null);
      const uids = body && Array.isArray(body.uids) ? body.uids : [];
      const hit = await this.remove(uids);
      return new Response(JSON.stringify({ removed: hit }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/clear") {
      const n = await this.clear();
      return new Response(JSON.stringify({ removed: n }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/fileok") {
      const ok = await this.fileAllowed(url.searchParams.get("id") || "");
      return new Response(JSON.stringify({ ok }), { headers: { "Content-Type": "application/json" } });
    }
    const since = Number(url.searchParams.get("since") || 0);
    const items = await this.list(since);
    const full = since ? await this.list(0) : items;
    return new Response(
      JSON.stringify({ items, total: full.length, gaps: msgIdGaps(full) }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
  // hibernation 下的三个回调。前端只会发心跳，收到就原样回一个 pong。
  async webSocketMessage(ws, data) {
    if (String(data) === "ping") {
      try {
        ws.send("pong");
      } catch (e) {
      }
    }
  }
  async webSocketClose(ws, code, reason, wasClean) {
    try {
      ws.close(code, reason);
    } catch (e) {
    }
  }
  async webSocketError(ws) {
  }
};
async function inboxAppend(env, msg) {
  const stub = inboxStub(env);
  if (!stub) return await kvInboxAppend(env, msg);
  await stub.fetch("https://do/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg)
  });
}
__name(inboxAppend, "inboxAppend");
async function inboxList(env, since) {
  const stub = inboxStub(env);
  if (!stub) {
    const all = await kvInboxList(env, 0);
    const items = since ? all.filter((m) => (m.editedTs || m.ts) > since) : all;
    return { items, total: all.length, gaps: msgIdGaps(all), live: false };
  }
  const res = await stub.fetch("https://do/list?since=" + encodeURIComponent(since || 0));
  const data = await res.json().catch(() => ({ items: [] }));
  return { items: data.items || [], total: data.total || 0, gaps: data.gaps || [], live: true };
}
__name(inboxList, "inboxList");
async function inboxArchive(env, uids, on) {
  const stub = inboxStub(env);
  if (!stub) {
    if (!env.SCHEDULE) return [];
    const all = await kvInboxList(env, 0);
    const hit = [];
    for (const m of all) {
      if (uids.indexOf(m.uid) === -1) continue;
      m.archivedAt = on ? Date.now() : 0;
      await env.SCHEDULE.put(inboxKey(m), JSON.stringify(m), { expirationTtl: 180 * 86400 });
      hit.push(m.uid);
    }
    return hit;
  }
  const res = await stub.fetch("https://do/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uids, on: !!on })
  });
  const d = await res.json().catch(() => ({ changed: [] }));
  return d.changed || [];
}
__name(inboxArchive, "inboxArchive");
async function inboxDelete(env, uids) {
  const stub = inboxStub(env);
  if (!stub) return await kvInboxDelete(env, uids);
  const res = await stub.fetch("https://do/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uids })
  });
  const d = await res.json().catch(() => ({ removed: [] }));
  return d.removed || [];
}
__name(inboxDelete, "inboxDelete");
async function inboxClear(env) {
  const stub = inboxStub(env);
  if (!stub) {
    const all = await kvInboxList(env, 0);
    return (await kvInboxDelete(env, all.map((m) => m.uid))).length;
  }
  const res = await stub.fetch("https://do/clear", { method: "POST" });
  const d = await res.json().catch(() => ({ removed: 0 }));
  return d.removed || 0;
}
__name(inboxClear, "inboxClear");
async function inboxFileAllowed(env, fileId) {
  const stub = inboxStub(env);
  if (!stub) return await kvFileAllowed(env, fileId);
  const res = await stub.fetch("https://do/fileok?id=" + encodeURIComponent(fileId));
  const d = await res.json().catch(() => ({ ok: false }));
  return !!d.ok;
}
__name(inboxFileAllowed, "inboxFileAllowed");
function queueKey(at, id) {
  return "sch:" + String(at).padStart(13, "0") + ":" + id;
}
__name(queueKey, "queueKey");
async function listQueue(env, limit) {
  if (!env.SCHEDULE) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.SCHEDULE.list({ prefix: "sch:", limit: 1e3, cursor });
    for (const k of page.keys) {
      const raw = await env.SCHEDULE.get(k.name);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        item.key = k.name;
        out.push(item);
      } catch (e) {
      }
      if (limit && out.length >= limit) return out;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}
__name(listQueue, "listQueue");
var worker_default = {
  async fetch(request, env) {
    const allowed = String(env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get("Origin") || "null";
    const headers = corsHeaders(origin, allowed);
    const url = new URL(request.url);
    if (url.pathname === WEBHOOK_PATH) {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json().catch(() => null);
      const msg = parseUpdate(update);
      if (msg) {
        if (!env.TG_CHAT || String(msg.chatId) === String(env.TG_CHAT)) {
          if (msg.del) await inboxDelete(env, [msg.uid]);
          else await inboxAppend(env, msg);
        }
      }
      return new Response("ok");
    }
    if (url.pathname === "/tg/file") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("GET only", { status: 405 });
      }
      const fileId = url.searchParams.get("id") || "";
      if (!fileId || !env.TG_TOKEN) return new Response("not found", { status: 404 });
      if (!await inboxFileAllowed(env, fileId)) return new Response("not found", { status: 404 });
      const meta = await fetch(`${TG_API}/bot${env.TG_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`).then((r) => r.json()).catch(() => null);
      if (!meta || !meta.ok || !meta.result || !meta.result.file_path) {
        return new Response("file unavailable", { status: 404 });
      }
      const upstream = await fetch(`${TG_API}/file/bot${env.TG_TOKEN}/${meta.result.file_path}`);
      if (!upstream.ok) return new Response("upstream " + upstream.status, { status: 502 });
      const out = new Response(upstream.body, upstream);
      out.headers.set("Cache-Control", "public, max-age=604800, immutable");
      out.headers.set("Access-Control-Allow-Origin", "*");
      out.headers.delete("Set-Cookie");
      return out;
    }
    if (url.pathname === WS_PATH) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ ok: false, description: "expected websocket upgrade" }, 426, headers);
      }
      if (!(allowed.includes("*") || allowed.includes(origin))) {
        return json({ ok: false, description: "origin not allowed: " + origin }, 403, headers);
      }
      const stub = inboxStub(env);
      if (!stub) return json({ ok: false, description: "Durable Object \u672A\u7ED1\u5B9A\uFF0C\u8BF7\u7528\u8F6E\u8BE2" }, 501, headers);
      return await stub.fetch(request);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") {
      return json({ ok: false, description: "POST only" }, 405, headers);
    }
    if (!(allowed.includes("*") || allowed.includes(origin))) {
      return json({ ok: false, description: "origin not allowed: " + origin }, 403, headers);
    }
    if (env.APP_KEY && request.headers.get("X-App-Key") !== env.APP_KEY) {
      return json({ ok: false, description: "bad app key" }, 403, headers);
    }
    const body = await readBody(request);
    const action = String(body.action || "send");
    if (action === "ai") {
      if (!env.ANTHROPIC_API_KEY) {
        return json({ ok: false, description: "ANTHROPIC_API_KEY \u672A\u914D\u7F6E\u5728 Worker \u4E0A" }, 501, headers);
      }
      const payload = body.payload;
      if (!payload || typeof payload !== "object") {
        return json({ ok: false, description: "missing payload" }, 400, headers);
      }
      payload.max_tokens = Math.min(Number(payload.max_tokens) || 1024, 4e3);
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(payload)
      });
      const data2 = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = data2 && data2.error && data2.error.message || "HTTP " + res.status;
        return json({ ok: false, description: msg }, res.status, headers);
      }
      return json({ ok: true, result: data2 }, 200, headers);
    }
    if (action === "inbox") {
      const since = Number(body.since || 0);
      const data2 = await inboxList(env, since);
      return json({
        ok: true,
        items: data2.items,
        total: data2.total,
        gaps: data2.gaps,
        // 没收到的 msgId 区间，页面据此提示怎么补
        live: data2.live,
        // true = 走 DO，可以开 WebSocket
        wsPath: data2.live ? WS_PATH : "",
        filePath: "/tg/file",
        // 图片代理
        hooked: !!env.WEBHOOK_SECRET,
        // false = webhook 还没配，页面会提示
        now: Date.now()
      }, 200, headers);
    }
    if (action === "inbox_archive") {
      let uids = [];
      try {
        uids = JSON.parse(body.uids || "[]");
      } catch (e) {
        uids = [];
      }
      if (!Array.isArray(uids) || !uids.length) {
        return json({ ok: false, description: "missing uids" }, 400, headers);
      }
      const on = String(body.on == null ? "1" : body.on) !== "0";
      return json({ ok: true, changed: await inboxArchive(env, uids.slice(0, 500), on) }, 200, headers);
    }
    if (action === "inbox_delete") {
      let uids = [];
      try {
        uids = JSON.parse(body.uids || "[]");
      } catch (e) {
        uids = [];
      }
      if (!Array.isArray(uids) || !uids.length) {
        return json({ ok: false, description: "missing uids" }, 400, headers);
      }
      return json({ ok: true, removed: await inboxDelete(env, uids.slice(0, 200)) }, 200, headers);
    }
    if (action === "inbox_clear") {
      return json({ ok: true, removed: await inboxClear(env) }, 200, headers);
    }
    if (action === "report_status" || action === "report_preview" || action === "report_send") {
      const sentRaw = await reportSent(env, Date.now());
      let sent = null;
      if (sentRaw) {
        try {
          sent = JSON.parse(sentRaw);
        } catch (e) {
          sent = { at: 0 };
        }
      }
      if (action === "report_status") {
        return json({ ok: true, date: jstDate(), sent: !!sent, sentAt: sent ? sent.at : 0 }, 200, headers);
      }
      const now = Date.now();
      const data2 = await fetchRecords(env);
      if (!data2) {
        return json({ ok: false, description: "RECORDS_URL \u672A\u914D\u7F6E\u6216\u62C9\u53D6\u5931\u8D25" }, 501, headers);
      }
      const start = await reportWindowStart(env, now);
      const text2 = buildReport(data2, now, env.BOARD_URL || "", start);
      if (action === "report_preview") {
        return json({ ok: true, date: jstDate(), sent: !!sent, from: start, to: now, text: text2 || "" }, 200, headers);
      }
      if (sent) {
        return json({ ok: false, description: "\u4ECA\u5929\u5DF2\u7ECF\u53D1\u8FC7\u4E86\uFF08" + jstDate() + "\uFF09" }, 409, headers);
      }
      if (!text2) {
        return json({ ok: false, description: "\u8FD9\u4E00\u6279\u6CA1\u6709\u65B0\u60C5\u51B5\uFF0C\u4E0D\u53D1" }, 200, headers);
      }
      if (!env.TG_TOKEN) {
        return json({ ok: false, description: "TG_TOKEN is not configured on the worker" }, 500, headers);
      }
      const sendRes = await tgSend(env, text2);
      if (sendRes.ok) {
        await markReportSent(env, now, "manual");
        await saveReportCursor(env, now);
      }
      return json(sendRes, sendRes.ok ? 200 : 502, headers);
    }
    if (!env.TG_TOKEN) {
      return json({ ok: false, description: "TG_TOKEN is not configured on the worker" }, 500, headers);
    }
    if (action === "list") {
      if (!env.SCHEDULE) return json({ ok: false, description: "KV \u672A\u7ED1\u5B9A\uFF0C\u5B9A\u65F6\u529F\u80FD\u4E0D\u53EF\u7528" }, 501, headers);
      const items = await listQueue(env, MAX_QUEUE);
      items.sort((a, b) => a.at - b.at);
      return json({ ok: true, items: items.map((i) => ({ id: i.id, at: i.at, text: i.text, meta: i.meta || {} })) }, 200, headers);
    }
    if (action === "cancel" || action === "sendnow") {
      if (!env.SCHEDULE) return json({ ok: false, description: "KV \u672A\u7ED1\u5B9A\uFF0C\u5B9A\u65F6\u529F\u80FD\u4E0D\u53EF\u7528" }, 501, headers);
      const id = String(body.id || "");
      if (!id) return json({ ok: false, description: "missing id" }, 400, headers);
      const at = Number(body.at || 0);
      let key = null, item = null;
      if (at) {
        key = queueKey(at, id);
        const raw = await env.SCHEDULE.get(key);
        if (raw) {
          try {
            item = JSON.parse(raw);
          } catch (e) {
            item = null;
          }
        }
      }
      if (!item) {
        const items = await listQueue(env, MAX_QUEUE);
        const hit = items.find((i) => i.id === id);
        if (hit) {
          item = hit;
          key = hit.key;
        }
      }
      if (!item || !key) return json({ ok: false, description: "not found" }, 404, headers);
      if (action === "sendnow") {
        const data2 = await tgSend(env, item.text);
        if (!data2.ok) return json(data2, 502, headers);
      }
      await env.SCHEDULE.delete(key);
      return json({ ok: true }, 200, headers);
    }
    const text = String(body.text || "");
    if (!text.startsWith(HEADER_PREFIX)) {
      return json({ ok: false, description: "unexpected payload" }, 400, headers);
    }
    if (text.length > MAX_LEN) {
      return json({ ok: false, description: "text too long" }, 413, headers);
    }
    if (action === "schedule") {
      if (!env.SCHEDULE) return json({ ok: false, description: "KV \u672A\u7ED1\u5B9A\uFF0C\u5B9A\u65F6\u529F\u80FD\u4E0D\u53EF\u7528" }, 501, headers);
      const at = Number(body.at);
      if (!at || !isFinite(at)) return json({ ok: false, description: "missing at" }, 400, headers);
      if (at > Date.now() + MAX_AHEAD_MS) {
        return json({ ok: false, description: "\u6392\u5F97\u592A\u8FDC\u4E86\uFF08\u6700\u591A 180 \u5929\uFF09" }, 400, headers);
      }
      const existing = await listQueue(env, MAX_QUEUE + 1);
      if (existing.length >= MAX_QUEUE) {
        return json({ ok: false, description: "\u961F\u5217\u5DF2\u6EE1\uFF08\u4E0A\u9650 " + MAX_QUEUE + " \u6761\uFF09" }, 429, headers);
      }
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      let meta = {};
      try {
        meta = body.meta ? JSON.parse(body.meta) : {};
      } catch (e) {
        meta = {};
      }
      const item = { id, at, text, createdAt: Date.now(), meta };
      await env.SCHEDULE.put(
        queueKey(at, id),
        JSON.stringify(item),
        { expirationTtl: Math.max(120, Math.floor((at - Date.now()) / 1e3) + 7 * 86400) }
      );
      return json({ ok: true, id, at }, 200, headers);
    }
    const data = await tgSend(env, text);
    return json(data, data.ok ? 200 : 502, headers);
  },
  /** Cron 触发：把到点的消息发出去，顺带看看该不该发当日速报 */
  async scheduled(event, env, ctx) {
    if (!env.SCHEDULE || !env.TG_TOKEN) return;
    const now = Date.now();
    const jstNow = new Date(now + 9 * 36e5);
    const mins = jstNow.getUTCHours() * 60 + jstNow.getUTCMinutes();
    if (mins >= REPORT_HOUR * 60 + REPORT_MIN && !await reportSent(env, now) && !await env.SCHEDULE.get(reportEmptyKey(now))) {
      const data = await fetchRecords(env);
      const start = await reportWindowStart(env, now);
      const text = data ? buildReport(data, now, env.BOARD_URL || "", start) : null;
      if (text) {
        const r = await tgSend(env, text);
        if (r.ok) {
          await markReportSent(env, now, "auto");
          await saveReportCursor(env, now);
        }
      } else if (data) {
        await env.SCHEDULE.put(
          reportEmptyKey(now),
          JSON.stringify({ at: now }),
          { expirationTtl: 3 * 86400 }
        );
      }
    }
    const items = await listQueue(env, MAX_QUEUE);
    for (const item of items) {
      if (item.at > now) continue;
      const data = await tgSend(env, item.text);
      if (data.ok || data.error_code && data.error_code >= 400 && data.error_code < 500) {
        await env.SCHEDULE.delete(item.key);
      }
    }
  }
};
export {
  ChannelInbox,
  worker_default as default
};
//# sourceMappingURL=worker.js.map
