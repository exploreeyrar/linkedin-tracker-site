/**
 * Gmail → Telegram / channel.html 的自动投送
 * ============================================
 *
 * 装在 Google Apps Script 里，挂一个「每 N 分钟」的时间触发器。每次运行：
 *
 *   1. 找 Worker 要一次规则（action=mail_rules）—— 规则是在看板的
 *      「⚙ 设置 → ✉️ 邮件投送规则」里改的，改完这边下一轮就生效，
 *      **不用再打开这个编辑器**。
 *   2. 按规则拼出 Gmail 搜索式，把范围缩小。
 *   3. 对搜出来的每一封，用 indexOf **逐字**复核关键字（见下）。
 *   4. 命中的整封正文发给 Worker（action=inbox_push），Worker 一边发
 *      Telegram、一边写进频道页的收件箱。
 *   5. 投过的记下**消息 ID**（不是会话 ID），下一轮不再重复；
 *      同时给会话打个标签，纯粹是为了在 Gmail 里一眼看出哪些被推过。
 *
 * 去重为什么不能只靠标签：Gmail 的 label: 搜索是**按会话**算的，一个会话里
 * 只要有一封被打过标，整个会话就被 -label: 排除掉了 —— 同一串对话里后来的
 * 回信会全部漏掉。所以真正的去重是按消息 ID 记在脚本属性里。
 *
 * 关于「完全一致」
 * ----------------
 * Gmail 自己的搜索**做不到**逐字匹配：即使写成 "面接のご案内"，它照样忽略
 * 大小写、把标点当分隔符、还会做词形归并（interview / Interviews 算同一个）。
 * 所以这里分两步：搜索只负责把范围缩小到「大概相关」的那些，真正的判定是
 * 第 3 步的 indexOf —— 大小写、空格、标点全都算数。
 *
 * 装法
 * ----
 *   1. script.google.com → 新建项目，把这个文件整份贴进去。
 *   2. 改下面 ENDPOINT 两行（Worker 地址 + INGEST_KEY）。
 *      INGEST_KEY 就是 `npx wrangler secret put INGEST_KEY` 设的那个值。
 *   3. 先手动运行一次 run()，Google 会弹授权（要 Gmail 读取 + 外部请求）。
 *   4. 左边「触发器」→ 添加触发器 → 函数 run、时间驱动、分钟计时器、每 5 分钟。
 *
 * 间隔选多少
 * ----------
 * 可选 1 / 5 / 10 / 15 / 30 分钟。真正的限制不是粒度，而是**免费（个人 Gmail）
 * 账号的触发器每天总共只能跑 90 分钟**：
 *   · 每 1 分钟 → 一天 1440 次，每次 3 秒就要 72 分钟，几乎顶满配额。
 *     一旦超了，当天剩下的触发器**静默停止**，不会有任何提示。
 *   · 每 5 分钟 → 288 次，约 15 分钟，余量充足。
 * 所以默认给 5 分钟。真要压到 1 分钟：把规则数压到最少（每条规则 = 一次 Gmail
 * 搜索），并盯几天「执行数」页面里每次的耗时，确认 次数 × 耗时 离 90 分钟还远。
 * 另外每次执行本身最长 6 分钟，正常情况下用不到。
 * 配额随时可能变，以 developers.google.com/apps-script/guides/services/quotas 为准。
 *
 * 注意：ENDPOINT / INGEST_KEY 是机密，**别把填好的这份提交回仓库**。
 */

// ---- 只有这两行需要改 ----------------------------------------------------
var ENDPOINT = 'https://sgjob-tracker-telegram.fda-tsk.workers.dev';
var INGEST_KEY = '把 wrangler secret put INGEST_KEY 设的值填在这里';
// -------------------------------------------------------------------------

var LABEL = 'SGJOB-已投送';   // 只是给人看的标记，不参与去重（见文件头的说明）
var MAX_THREADS = 50;         // 一轮最多处理多少个会话，防止第一次跑就炸配额
var BODY_LIMIT = 3000;        // 正文截断长度（Telegram 上限 4096，留出头部空间）
var SEEN_KEY = 'sgjob_sent_msg_ids';
var SEEN_KEEP = 500;          // 记住最近这么多封，够覆盖任何合理的回看窗口


function run() {
  var doc = fetchRules();
  if (!doc || doc.on === false) {
    Logger.log('总开关是关的，或者取不到规则，这一轮什么都不做');
    return;
  }
  var rules = (doc.rules || []).filter(function (r) { return r && r.on !== false; });
  if (!rules.length) { Logger.log('没有启用中的规则'); return; }

  var label = getLabel_();
  var seen = loadSeen_();
  var sent = 0, scanned = 0, dup = 0;

  rules.forEach(function (rule) {
    var query = buildQuery_(rule, doc.lookbackMin || 60);
    Logger.log('规则「' + (rule.name || rule.id) + '」查询：' + query);

    var threads = GmailApp.search(query, 0, MAX_THREADS);
    threads.forEach(function (thread) {
      var hit = false;
      thread.getMessages().forEach(function (msg) {
        scanned++;
        var id = msg.getId();
        if (seen[id]) { dup++; return; }           // 上一轮已经投过这一封
        if (!matches_(rule, msg)) return;
        if (!deliver_(rule, msg)) return;
        seen[id] = Date.now();
        sent++;
        hit = true;
      });
      if (hit) thread.addLabel(label);             // 纯标记，方便在 Gmail 里回看
    });
  });

  saveSeen_(seen);
  Logger.log('扫了 ' + scanned + ' 封（跳过已投 ' + dup + ' 封），投出 ' + sent + ' 封');
}


/* ---- 去重：按消息 ID 记在脚本属性里 ------------------------------------ */

function loadSeen_() {
  var raw = PropertiesService.getScriptProperties().getProperty(SEEN_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}

function saveSeen_(seen) {
  // 只留最近的若干条，否则这个属性会一直长（单个属性有 9KB 上限）
  var ids = Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a]; }).slice(0, SEEN_KEEP);
  var out = {};
  ids.forEach(function (id) { out[id] = seen[id]; });
  PropertiesService.getScriptProperties().setProperty(SEEN_KEY, JSON.stringify(out));
}

/** 想让某些邮件重新投一遍时，手动跑这个把去重记录清掉 */
function resetSeen() {
  PropertiesService.getScriptProperties().deleteProperty(SEEN_KEY);
  Logger.log('去重记录已清空 —— 下一轮回看窗口内命中的邮件会再投一次');
}


/** 找 Worker 要规则。取不到就返回 null —— 宁可这一轮不投，也不要按旧规则乱投 */
function fetchRules() {
  var res = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    payload: { action: 'mail_rules' },
    headers: { 'X-Ingest-Key': INGEST_KEY },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) { Logger.log('取规则失败 HTTP ' + code + '：' + body); return null; }
  var data = JSON.parse(body);
  if (!data.ok) { Logger.log('取规则失败：' + (data.description || '?')); return null; }
  return data.doc;
}


/**
 * 拼 Gmail 搜索式。
 *
 * 关键字在这里是**用来缩小范围的**，所以加引号拼进去（Gmail 会当短语搜，
 * 虽然不严格，但能把明显无关的滤掉）；严格判定在 matches_() 里。
 * 关键字为空的规则就只按 query 筛。
 */
function buildQuery_(rule, lookbackMin) {
  var parts = [];

  // 回看窗口。Gmail 的 newer_than 最小粒度是天，所以分钟级要用 after: 时间戳
  // （这里**不能**加 -label:，那是按会话算的，会把同一串对话里的新回信一起挡掉）
  var after = Math.floor((Date.now() - lookbackMin * 60 * 1000) / 1000);
  parts.push('after:' + after);

  if (rule.query) parts.push('(' + rule.query + ')');

  var phrases = rule.phrases || [];
  if (phrases.length) {
    var quoted = phrases.map(function (p) {
      // 引号本身不能出现在引号里，去掉即可（严格判定不受影响）
      var clean = String(p).replace(/"/g, ' ').trim();
      return clean ? ('"' + clean + '"') : '';
    }).filter(String);
    if (quoted.length) {
      var field = rule.scope === 'subject' ? 'subject:' : '';
      parts.push('(' + quoted.map(function (q) { return field + q; }).join(' OR ') + ')');
    }
  }
  return parts.join(' ');
}


/**
 * 逐字复核。这是「完全一致」真正生效的地方 ——
 * 大小写、空格、标点都算数，也不做任何词形归并。
 *
 * 判定是「这串字**逐字出现过**」（indexOf），不是整段相等、也不看词边界：
 * 关键字 Interview 会在 “Interviews” 里命中，而 interview 不会命中 “Interview”。
 * 要卡住词边界就把空格一起写进关键字（比如 " Interview "）。
 *
 * 规则没写关键字时，能被搜索式选出来就算命中。
 */
function matches_(rule, msg) {
  var phrases = rule.phrases || [];
  if (!phrases.length) return true;

  var scope = rule.scope || 'both';
  var hay = '';
  if (scope === 'subject') hay = msg.getSubject() || '';
  else if (scope === 'body') hay = msg.getPlainBody() || '';
  else hay = (msg.getSubject() || '') + '\n' + (msg.getPlainBody() || '');

  for (var i = 0; i < phrases.length; i++) {
    if (hay.indexOf(phrases[i]) !== -1) return true;
  }
  return false;
}


/** 把一封邮件交给 Worker。返回投没投出去 */
function deliver_(rule, msg) {
  var subject = msg.getSubject() || '(无标题)';
  var from = msg.getFrom() || '';
  var body = (msg.getPlainBody() || '').trim();

  // 引用的历史邮件对推送没意义，遇到常见的引用分隔就截断
  var cut = body.search(/^\s*(On .+ wrote:|-{2,} ?Original Message| 20\d\d\/\d+\/\d+.*<)/m);
  if (cut > 60) body = body.slice(0, cut).trim();
  if (body.length > BODY_LIMIT) body = body.slice(0, BODY_LIMIT) + '\n…（正文过长，已截断）';

  var text = [
    '📧 ' + subject,
    'From: ' + from,
    rule.name ? ('规则：' + rule.name) : '',
    '',
    body,
  ].filter(function (x) { return x !== ''; }).join('\n');

  var res = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    payload: {
      action: 'inbox_push',
      // uid 用 Gmail 的消息 ID：同一封重复投也只会覆盖同一条，不会变成两条
      id: 'gmail-' + msg.getId(),
      source: 'Gmail',
      author: senderName_(from),
      kind: '📧 邮件',
      text: text,
      ts: String(msg.getDate().getTime()),
      tg: rule.tg === false ? '0' : '1',
    },
    headers: { 'X-Ingest-Key': INGEST_KEY },
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    Logger.log('投送失败 HTTP ' + res.getResponseCode() + '：' + res.getContentText());
    return false;
  }
  var data = JSON.parse(res.getContentText());
  if (!data.ok) { Logger.log('投送失败：' + (data.description || '?')); return false; }
  Logger.log('已投送：' + subject);
  return true;
}


/** "Someone <a@b.com>" → "Someone"；没有显示名就用地址 */
function senderName_(from) {
  var m = String(from).match(/^\s*"?([^"<]*?)"?\s*</);
  var name = m ? m[1].trim() : '';
  return name || String(from).replace(/[<>]/g, '').trim();
}


function getLabel_() {
  return GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
}


/**
 * 调试用：不投送，只把当前规则会搜出什么打在日志里。
 * 改完规则先跑这个看一眼，比直接开着触发器试错省心。
 */
function dryRun() {
  var doc = fetchRules();
  if (!doc) return;
  (doc.rules || []).forEach(function (rule) {
    if (rule.on === false) { Logger.log('（停用）' + (rule.name || rule.id)); return; }
    var q = buildQuery_(rule, doc.lookbackMin || 60);
    var threads = GmailApp.search(q, 0, MAX_THREADS);
    Logger.log('规则「' + (rule.name || rule.id) + '」 ' + q + ' → ' + threads.length + ' 个会话');
    threads.forEach(function (t) {
      t.getMessages().forEach(function (m) {
        Logger.log('   ' + (matches_(rule, m) ? '✅ 逐字命中' : '❌ 搜到了但逐字不匹配')
                   + '　' + m.getSubject());
      });
    });
  });
}
