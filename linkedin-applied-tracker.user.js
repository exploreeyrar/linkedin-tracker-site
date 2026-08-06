// ==UserScript==
// @name         LinkedIn / Jobstreet 已递交投递追踪器 (Applied Tracker)
// @namespace    local.linkedin.applied.tracker
// @version      1.5.1
// @updateURL    https://raw.githubusercontent.com/exploreeyrar/linkedin-tracker-site/main/linkedin-applied-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/exploreeyrar/linkedin-tracker-site/main/linkedin-applied-tracker.user.js
// @supportURL   https://github.com/exploreeyrar/linkedin-tracker-site/issues
// @description  在 LinkedIn 与 Jobstreet 的招聘页面左上角添加「已递交投递」悬浮按钮与「已递交清单」悬浮面板：一键记录公司名/岗位名/Hiring team 成员及其主页 URL/投递时间戳/总员工数/要求年限/Job match/Median employee tenure，可填写 MEMO 与状态、设置跟进提醒；按钮与面板可拖拽、面板可缩放可隐藏，所有数据与 UI 状态均持久化到本地；可选自动同步到 GitHub 仓库以驱动 Pages 看板，并在看板页充当回写桥接。Jobstreet 搜索结果里每张卡片还有「✕ 不看」按钮，点过的自动隐藏；投过的同名岗位灰底显示。
// @author       you
// @match        https://www.linkedin.com/jobs/*
// @match        https://www.linkedin.com/job/*
// @match        https://www.linkedin.com/jobs-tracker*
// @match        https://www.linkedin.com/my-items/*
// @match        https://www.linkedin.com/messaging/*
// @match        https://*.jobstreet.com/*
// @match        https://*.jobstreet.com.sg/*
// @match        https://*.github.io/*
// @include      file://*linkedin*
// @include      file://*jobstreet*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @connect      api.anthropic.com
// @connect      workers.dev
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 本地保存的 HTML（file:// 打开）也能用，但需要在 Tampermonkey 的扩展详情里
 * 打开「允许访问文件网址 / Allow access to file URLs」。
 *
 * ---- 自动更新 ----------------------------------------------------------
 * @updateURL / @downloadURL 指向仓库 main 分支上的这份文件。Tampermonkey 会定期
 * （默认每天，也可以在管理面板手动「检查更新」）拉一次那个地址的元数据块，
 * 发现远端 @version 比本地大就整份换掉。
 *
 * 所以改完代码 **必须把 @version 往上加**，否则推上去也不会更新。
 * 另外 raw.githubusercontent.com 有约 5 分钟 CDN 缓存，push 完不会立刻可见。
 *
 * 第一次要手动装：浏览器打开上面那个 raw 链接 → Tampermonkey 弹安装页 → 安装。
 * 这一步不能省，否则 Tampermonkey 不知道去哪儿查更新（本地粘贴进去的那份没有来源）。
 * ------------------------------------------------------------------------ */

(function () {
  'use strict';

  /* =========================================================================
   * 0. 常量
   * ========================================================================= */

  const K_REC = 'lat_records_v1';   // 投递记录
  const K_UI  = 'lat_ui_v1';        // 悬浮按钮 / 面板的位置、尺寸、隐藏状态
  const K_GH  = 'lat_github_v1';    // GitHub 同步配置（含 PAT，仅存在本机）
  const K_MSG = 'lat_messages_v1';  // 通知板
  const K_TPL = 'lat_templates_v1'; // 备注模板（可自定义）
  const K_ORD = 'lat_status_order_v1'; // 状态显示优先级（老版本只存名字数组，保留兼容）
  const K_STA = 'lat_statuses_v1';     // 状态清单（可改名 / 增删 / 排序）
  const K_SAL = 'lat_status_alias_v1'; // 改名累积的别名：旧名字 → 新名字
  const K_PTL = 'lat_push_templates_v1'; // 直接推送用的文字模板
  const K_HID = 'lat_hidden_jobs_v1';    // 「✕ 不看」隐藏掉的职位（Jobstreet 搜索结果）
  const K_SEC = 'lat_sector_cache_v1';   // 公司 → EP 所属行业的判定缓存
  const K_MTL = 'lat_msg_templates_v1';  // 通知板留言用的文字模板
  const K_MAL = 'lat_msg_autolink_v1';   // 追加留言后自动复制其直达链接
  const K_DEL = 'lat_deleted_v1';        // 删除墓碑：{ id: 删除时间 }，多标签页合并时用
  const K_FUD = 'lat_followup_done_v1';  // 已经弹过（并被手动关掉）的跟进提醒

  /* ---- 看板页（GitHub Pages 上的 index.html）------------------------------
   * 脚本在看板页上不建任何 UI，只做一件事：把看板上「设置跟进提醒」写进
   * localStorage 的待办队列取出来，合并进本地记录再推回 GitHub。
   * 静态页面自己没有 PAT，回写只能靠这条桥。
   * ------------------------------------------------------------------------ */
  const BOARD_OUTBOX = 'sgjob_outbox_v1';   // 看板写、脚本读
  const BOARD_ACK    = 'sgjob_outbox_ack_v1';
  const IS_BOARD = /(^|\.)github\.io$/i.test(location.hostname || '');

  /* ---- 当前站点 ----------------------------------------------------------
   * 同一份脚本同时跑在 LinkedIn 和 Jobstreet 上：记录、清单、看板同步、Telegram
   * 这些都共用一套数据，只有「怎么从页面上抓信息」「卡片长什么样」按站点分叉。
   * 本地存档的 HTML（file://）按文件名判断，方便离线调试。
   * ------------------------------------------------------------------------ */
  const SITE = (function () {
    const host = (location.hostname || '').toLowerCase();
    const path = (function () {
      try { return decodeURIComponent(location.pathname || '').toLowerCase(); }
      catch (e) { return (location.pathname || '').toLowerCase(); }
    }());
    if (/(^|\.)jobstreet\.com(\.[a-z]+)?$/.test(host)) return 'jobstreet';
    if (location.protocol === 'file:' && path.indexOf('jobstreet') !== -1) return 'jobstreet';
    return 'linkedin';
  }());
  const IS_JS = SITE === 'jobstreet';   // 反过来就是 LinkedIn

  // Jobstreet 有多个国家站，链接一律拼在当前站点下；离线看存档时退回 sg 站
  const JS_ORIGIN = (IS_JS && /^https?:$/.test(location.protocol))
    ? location.origin : 'https://sg.jobstreet.com';

  const TG_PREFIX = '#SGJOB';       // Worker 只放行以此开头的正文
  const TG_LIMIT  = 4096;           // Telegram 单条上限，Worker 也按这个值拦

  /* ---- 状态定义 ----------------------------------------------------------
   * 名字可以改、可以新增，所以按名字硬编码行为是不行的：
   * 每条状态带一个**永不变的 id**，「算不算落选」「是不是新记录的默认值」
   * 「30 天超时落到哪一条」这些语义全挂在 id 上，改名只动 name。
   * 记录里存的仍然是名字（CSV / 看板 / Telegram 都直接可读），
   * 所以改名时要顺带把用到旧名字的记录一起改（见 renameStatus）。
   * 数组顺序 = 清单的默认排序顺位。
   * ------------------------------------------------------------------------ */
  const BUILTIN_STATUSES = [
    { id: 'self_xr',  name: '等己方处理(XR ball)',            waiting: true },
    { id: 'self_me',  name: '等己方处理(己 ball)',            waiting: true },
    { id: 'itv_set',  name: '已安排面试、面试准备中',          advanced: true },
    { id: 'contact',  name: '対方来联络了' },
    { id: 'pass4',    name: '四次面试通过、等对方安排下一轮',  advanced: true },
    { id: 'pass3',    name: '三次面试通过、等对方安排下一轮',  advanced: true },
    { id: 'pass2',    name: '二次面试通过、等对方安排下一轮',  advanced: true },
    { id: 'pass1',    name: '一次面试通过、等対方安排下一轮',  advanced: true },
    { id: 'hr1',      name: '一次人事面谈结束、等对方联络',    waiting: true },
    { id: 'final',    name: '内定',                            advanced: true },
    { id: 'offer',    name: '人事 Offer Call',                 advanced: true },
    // role:'default' —— 新记录的初始状态，也是 30 天超时的判定来源
    { id: 'wait',     name: '已投递等联络',    role: 'default', waiting: true },
    { id: 'rej_itv',  name: '面试落了',        closed: true, rejected: true },
    { id: 'rej_doc',  name: '书类落了',        closed: true, rejected: true },
    { id: 'taken',    name: '对方招到人了',    closed: true },
    // role:'nonews' —— 超 30 天没动静自动落到这里；显示顺位最低
    { id: 'nonews',   name: '无消息疑似书类落了', role: 'nonews', closed: true },
  ];

  const NO_NEWS_DAYS = 30;

  // 重要度：数字越大排得越靠上，优先级压过状态顺位
  const PRIORITIES = [
    { v: 0, label: '—' },
    { v: 1, label: '★' },
    { v: 2, label: '★★' },
    { v: 3, label: '★★★' },
  ];

  // ---- C1 薪资基准（MOM, Released Aug 2025）----
  // 每个行业 23 个档位，对应年龄 23~45；取「10 分（本地人 65th percentile）」那一列，
  // 也就是 COMPASS C1 拿满 10 分所需的最低月 base。数据由随附 PDF 抽取并逐项校验。
  const C1_AGE_MIN = 23, C1_AGE_MAX = 45;
  const C1_SALARY = {
    'Accommodation':
      [4341, 4444, 4547, 4651, 4754, 4857, 4960, 5063, 5166, 5270, 5373, 5476, 5579, 5682, 5786, 5889, 5992, 6095, 6198, 6301, 6405, 6508, 6611],
    'Administrative & Support':
      [5654, 5823, 5993, 6162, 6331, 6501, 6670, 6839, 7009, 7178, 7347, 7517, 7686, 7855, 8024, 8194, 8363, 8532, 8702, 8871, 9040, 9210, 9379],
    'Air & Sea Transport':
      [5837, 6098, 6359, 6620, 6882, 7143, 7404, 7665, 7926, 8187, 8448, 8710, 8971, 9232, 9493, 9754, 10015, 10276, 10537, 10799, 11060, 11321, 11582],
    'Arts, Entertainment & Recreation':
      [4534, 4750, 4967, 5183, 5400, 5616, 5833, 6049, 6266, 6482, 6699, 6915, 7131, 7348, 7564, 7781, 7997, 8214, 8430, 8647, 8863, 9080, 9296],
    'Banking & Other Financial Services Activities n.e.c.':
      [7510, 8044, 8579, 9113, 9647, 10182, 10716, 11251, 11785, 12319, 12854, 13388, 13922, 14457, 14991, 15525, 16060, 16594, 17129, 17663, 18197, 18732, 19266],
    'Construction':
      [5262, 5392, 5522, 5652, 5783, 5913, 6043, 6173, 6303, 6433, 6563, 6694, 6824, 6954, 7084, 7214, 7344, 7474, 7604, 7735, 7865, 7995, 8125],
    'Education':
      [5122, 5363, 5605, 5846, 6088, 6329, 6571, 6812, 7054, 7295, 7537, 7778, 8019, 8261, 8502, 8744, 8985, 9227, 9468, 9710, 9951, 10193, 10434],
    'Food & Beverage Services':
      [4241, 4325, 4409, 4493, 4577, 4661, 4745, 4829, 4913, 4997, 5081, 5165, 5249, 5333, 5417, 5501, 5585, 5669, 5753, 5837, 5921, 6005, 6089],
    'Fund Management Activities & Activities Auxiliary to Financial Services':
      [8917, 9505, 10092, 10680, 11268, 11855, 12443, 13030, 13618, 14206, 14793, 15381, 15969, 16556, 17144, 17732, 18319, 18907, 19494, 20082, 20670, 21257, 21845],
    'Health & Social Services':
      [5352, 5537, 5723, 5908, 6093, 6279, 6464, 6650, 6835, 7020, 7206, 7391, 7576, 7762, 7947, 8132, 8318, 8503, 8689, 8874, 9059, 9245, 9430],
    'Info-communication Technology':
      [6939, 7229, 7520, 7810, 8100, 8391, 8681, 8971, 9262, 9552, 9842, 10133, 10423, 10713, 11003, 11294, 11584, 11874, 12165, 12455, 12745, 13036, 13326],
    'Insurance, Reinsurance, Provident and Pension Funding':
      [6481, 6735, 6988, 7242, 7495, 7749, 8003, 8256, 8510, 8763, 9017, 9271, 9524, 9778, 10031, 10285, 10538, 10792, 11046, 11299, 11553, 11806, 12060],
    'Land Transport & Logistics':
      [4721, 4860, 4999, 5138, 5276, 5415, 5554, 5693, 5832, 5971, 6110, 6249, 6387, 6526, 6665, 6804, 6943, 7082, 7221, 7359, 7498, 7637, 7776],
    'Manufacturing':
      [5609, 5830, 6050, 6271, 6491, 6712, 6933, 7153, 7374, 7594, 7815, 8036, 8256, 8477, 8697, 8918, 9138, 9359, 9580, 9800, 10021, 10241, 10462],
    'Media':
      [5323, 5522, 5721, 5920, 6119, 6318, 6516, 6715, 6914, 7113, 7312, 7511, 7710, 7909, 8108, 8307, 8506, 8704, 8903, 9102, 9301, 9500, 9699],
    'Other Community, Social & Personal Services':
      [4492, 4611, 4731, 4850, 4969, 5089, 5208, 5328, 5447, 5566, 5686, 5805, 5924, 6044, 6163, 6282, 6402, 6521, 6641, 6760, 6879, 6999, 7118],
    'Professional Services':
      [6175, 6437, 6699, 6961, 7223, 7485, 7748, 8010, 8272, 8534, 8796, 9058, 9320, 9582, 9844, 10106, 10368, 10631, 10893, 11155, 11417, 11679, 11941],
    'Public Administration & Defence':
      [6648, 6932, 7216, 7500, 7784, 8068, 8352, 8636, 8920, 9204, 9488, 9772, 10055, 10339, 10623, 10907, 11191, 11475, 11759, 12043, 12327, 12611, 12895],
    'Real Estate Services':
      [5746, 5882, 6017, 6153, 6289, 6424, 6560, 6695, 6831, 6967, 7102, 7238, 7374, 7509, 7645, 7781, 7916, 8052, 8187, 8323, 8459, 8594, 8730],
    'Retail Trade':
      [5247, 5332, 5417, 5501, 5586, 5671, 5756, 5841, 5926, 6010, 6095, 6180, 6265, 6350, 6434, 6519, 6604, 6689, 6774, 6859, 6943, 7028, 7113],
    'Utilities & Other Goods Producing Industries':
      [5909, 6155, 6401, 6647, 6893, 7139, 7385, 7631, 7877, 8123, 8369, 8616, 8862, 9108, 9354, 9600, 9846, 10092, 10338, 10584, 10830, 11076, 11322],
    'Wholesale Trade':
      [5749, 5974, 6199, 6424, 6649, 6874, 7098, 7323, 7548, 7773, 7998, 8223, 8448, 8673, 8898, 9123, 9348, 9572, 9797, 10022, 10247, 10472, 10697],
  };

  /** 生日 → 当前周岁 */
  function ageFrom(birth) {
    if (!birth) return null;
    const b = new Date(birth + 'T00:00:00');
    if (isNaN(b)) return null;
    const now = new Date();
    let a = now.getFullYear() - b.getFullYear();
    const m = now.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < b.getDate())) a--;
    return (a >= 0 && a < 120) ? a : null;
  }

  /** 某行业 + 某年龄所需的最低月 base；超出表格范围按最近的档位取 */
  function c1Monthly(sector, age) {
    const row = C1_SALARY[sector];
    if (!row || age == null) return 0;
    const i = Math.min(Math.max(age, C1_AGE_MIN), C1_AGE_MAX) - C1_AGE_MIN;
    return row[i] || 0;
  }

  /** 年总所需 = 月 base / 0.7 * 12 */
  function c1Annual(monthly) {
    return monthly ? Math.round(monthly / 0.7 * 12) : 0;
  }

  const fmtMoney = (n) => n ? n.toLocaleString('en-US') : '';

  // 脚本自带的旧写法 → 新写法，避免历史记录掉出下拉框。
  // 用户自己改名产生的别名另存一份（statusAlias），两者会合并使用。
  const BUILTIN_ALIAS = {
    '对方来联络了': '対方来联络了',
    '已安排面试': '已安排面试、面试准备中',
    '等己方处理': '等己方处理(XR ball)',
  };

  /**
   * 状态清单（可改名、可增删、可拖动排序）。
   * 真正的取值放在 store 初始化之后，这里只先声明。
   */
  let statuses = null;        // [{ id, name, closed, rejected, advanced, waiting, role }]
  let statusAlias = null;     // { 旧名字: 新名字 }，改名时累积

  const statusDefs = () => (Array.isArray(statuses) && statuses.length
    ? statuses : BUILTIN_STATUSES);

  /** 只要名字，顺序即显示顺位 —— 下拉框、排序、推给看板的都用它 */
  function activeStatuses() { return statusDefs().map((s) => s.name); }

  function defByName(name) {
    const list = statusDefs();
    for (let i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
    return null;
  }
  function defByRole(role) {
    const list = statusDefs();
    for (let i = 0; i < list.length; i++) if (list[i].role === role) return list[i];
    return null;
  }

  /** 新记录的初始状态；标了 role:'default' 的那条，没有就退回第一条 */
  function defaultStatus() {
    const d = defByRole('default');
    return d ? d.name : (statusDefs()[0] || {}).name || '';
  }
  /** 30 天没动静自动落到的那条；被删掉就退回「不自动改」 */
  function noNewsStatus() {
    const d = defByRole('nonews');
    return d ? d.name : '';
  }
  /** 已落选：清单里划掉并置灰 */
  function isClosedStatus(name) {
    const d = defByName(name);
    return !!(d && d.closed);
  }
  /**
   * 「真的被这家公司刷掉过」——同公司提醒里那段红字只认这类。
   * 「对方招到人了」「无消息」都不是对你个人的判断，不该跟着报红。
   */
  function isRejectedStatus(name) {
    const d = defByName(name);
    return !!(d && d.rejected);
  }

  /**
   * 把任意历史状态值归一到当前清单里的写法。
   * 逐字匹配之外还做一次「去掉标点 + 対/对 统一」的模糊匹配，
   * 这样以后再调整顿号/逗号或「対」「对」的写法，老数据也不会掉出下拉框。
   */
  const loose = (s) => String(s || '').replace(/[，,、･·・\s]/g, '').replace(/対/g, '对');

  function canonStatus(s) {
    if (!s) return defaultStatus();
    const names = activeStatuses();
    if (names.indexOf(s) !== -1) return s;
    // 用户改名产生的别名优先于内置别名：同一个旧名字被改过两次也能一路跟到最新
    let seen = 0;
    let cur = s;
    while (seen++ < 8) {
      const next = (statusAlias && statusAlias[cur]) || BUILTIN_ALIAS[cur];
      if (!next || next === cur) break;
      cur = next;
      if (names.indexOf(cur) !== -1) return cur;
    }
    const map = Object.create(null);
    names.forEach((n) => { map[loose(n)] = n; });
    return map[loose(s)] || s;
  }

  function saveStatuses() {
    store.set(K_STA, statuses);
    store.set(K_SAL, statusAlias);
    store.set(K_ORD, activeStatuses());   // 老版本读的是这个键，顺手维护着
  }

  const statusRank = (s) => {
    const list = activeStatuses();
    const i = list.indexOf(s);
    return i === -1 ? list.length : i;   // 未知状态排最后
  };

  const DEFAULT_UI = {
    bar:   { x: 16,  y: 100 },
    panel: { x: 16,  y: 156, w: 1340, h: 440, hidden: false },
    stats: { x: 0, y: 0, placed: false },
  };

  /* =========================================================================
   * 1. 本地存储（GM storage 优先，localStorage 兜底）
   * ========================================================================= */

  const HAS_GM = (typeof GM_getValue === 'function') && (typeof GM_setValue === 'function');

  const store = {
    get(key, fallback) {
      try {
        if (HAS_GM) {
          const v = GM_getValue(key, null);
          if (v == null) return fallback;
          return typeof v === 'string' ? JSON.parse(v) : v;
        }
      } catch (e) { /* fallthrough */ }
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    /**
     * secret = true 的条目只写油猴存储，绝不落到页面的 localStorage。
     * localStorage 是跟页面同源的，LinkedIn / Jobstreet 上任何一段脚本都能读，
     * GitHub PAT、Anthropic API Key 这种东西放进去等于公开。
     * 代价是没有油猴时（纯 file:// 调试）这些配置存不下来，可以接受。
     */
    set(key, value, secret) {
      const raw = JSON.stringify(value);
      try { if (HAS_GM) GM_setValue(key, raw); } catch (e) { /* ignore */ }
      if (secret && HAS_GM) {
        try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
        return;
      }
      try { localStorage.setItem(key, raw); } catch (e) { /* ignore */ }
    },
  };

  /* ---- 状态清单：读取 + 从老版本迁移 ------------------------------------
   * 必须排在记录迁移（下面的 canonStatus）之前：否则那一轮拿到的是内置名字，
   * 会把用户改过名的状态又「归一」回旧写法。
   * 老版本只存了一个名字数组（K_ORD，纯排序）。第一次跑新版时按那个顺序
   * 重建成带 id 的定义；名字对不上内置项的就当自定义项收下。
   * ------------------------------------------------------------------------ */
  statusAlias = store.get(K_SAL, null);
  if (!statusAlias || typeof statusAlias !== 'object' || Array.isArray(statusAlias)) statusAlias = {};

  statuses = store.get(K_STA, null);
  if (!Array.isArray(statuses) || !statuses.length) {
    const byName = Object.create(null);
    BUILTIN_STATUSES.forEach((s) => { byName[s.name] = s; });
    const legacy = store.get(K_ORD, null);
    const out = [];
    if (Array.isArray(legacy)) {
      legacy.forEach((name) => {
        if (typeof name !== 'string' || !name) return;
        const b = byName[name];
        out.push(b ? Object.assign({}, b) : { id: 'u' + out.length + Date.now().toString(36), name: name });
        delete byName[name];
      });
    }
    // 老顺序里没提到的内置项按内置顺序补在后面
    BUILTIN_STATUSES.forEach((s) => { if (byName[s.name]) out.push(Object.assign({}, s)); });
    statuses = out;
  }
  // 脏数据兜底：至少要有一条，否则下拉框会空掉
  statuses = statuses.filter((s) => s && typeof s.name === 'string' && s.name.trim());
  if (!statuses.length) statuses = BUILTIN_STATUSES.map((s) => Object.assign({}, s));
  statuses.forEach((s, i) => { if (!s.id) s.id = 'u' + i + Date.now().toString(36); });

  let records = store.get(K_REC, []);
  if (!Array.isArray(records)) records = [];

  /* ---- 删除墓碑 ----------------------------------------------------------
   * 保存时要和存储里那份合并（见 mergeStored），否则同时开着好几个标签页时，
   * 后保存的那个会拿自己加载时的旧快照把别的标签页刚加的记录整份盖掉 ——
   * 「明明点过『已递交投递』，事后却在清单里找不到」就是这么来的。
   * 合并的代价是「删除」会被别处的旧快照复活，所以删掉的 id 要单独记一笔。
   * ------------------------------------------------------------------------ */
  const TOMB_KEEP_MS = 90 * 86400000;
  let deleted = store.get(K_DEL, null);
  if (!deleted || typeof deleted !== 'object' || Array.isArray(deleted)) deleted = {};
  (function pruneTombs() {
    const cut = Date.now() - TOMB_KEEP_MS;
    Object.keys(deleted).forEach((k) => { if (!(deleted[k] > cut)) delete deleted[k]; });
  }());
  const saveDeleted = () => store.set(K_DEL, deleted);

  // 旧状态值迁移（只在真的改动了才回写）
  let migrated = 0;
  records.forEach((r) => {
    if (!r) return;
    const c = canonStatus(r.status);
    if (c !== r.status) { r.status = c; migrated++; }
  });

  /**
   * Jobstreet 的职位链接统一收敛成 https://<站点>/job/<id>。
   * 早期存进来的可能是带一长串筛选参数的搜索页地址，点开只会跳回列表，
   * 定位不到那条职缺。带 ref/sol 之类的跟踪参数也一并洗掉。
   */
  records.forEach((r) => {
    if (!r || recSite(r) !== 'jobstreet') return;
    let id = r.jobId;
    if (!id) {
      const m = String(r.jobUrl || '').match(/\/job\/(\d{5,})/);
      if (!m) return;
      id = r.jobId = m[1];
      migrated++;
    }
    // 站点域名沿用原记录里的，别把别国站的链接改到 sg
    const om = String(r.jobUrl || '').match(/^(https?:\/\/[^/]+)/);
    const origin = (om && /jobstreet/i.test(om[1])) ? om[1] : JS_ORIGIN;
    const next = origin + '/job/' + id;
    if (r.jobUrl !== next) { r.jobUrl = next; migrated++; }
  });

  let ui = Object.assign({}, DEFAULT_UI, store.get(K_UI, {}) || {});
  ui.bar   = Object.assign({}, DEFAULT_UI.bar,   ui.bar   || {});
  ui.panel = Object.assign({}, DEFAULT_UI.panel, ui.panel || {});
  ui.stats = Object.assign({}, DEFAULT_UI.stats, ui.stats || {});

  const DEFAULT_GH = {
    repo: '',                    // owner/repo
    branch: 'main',
    path: 'data/records.json',
    token: '',                   // fine-grained PAT，contents: read & write
    auto: true,                  // 记录变化后自动推送
    tgEndpoint: '',              // Cloudflare Worker 中继地址（Bot Token 在 Worker 上）
    tgAppKey: '',                // Worker 设了 APP_KEY 时才需要
    boardUrl: 'https://exploreeyrar.github.io/linkedin-tracker-site/',   // 看板页面
    birthday: '',                // 出生年月日，用来算 C1 薪资档位
    aiEndpoint: '',              // Claude 中继地址（同一个 Worker，Key 放在 Worker 上）
    aiKey: '',                   // Anthropic API Key（不配中继时才需要，仅存本机油猴存储）
    aiModel: 'claude-opus-5',    // 判定 EP 行业用的模型
    aiAuto: true,                // 新记录自动判定行业
    lastSync: 0,
    lastSha: null,               // 上次 PUT 返回的文件 sha，避免再去读会命中缓存的 GET
    lastError: '',
  };
  let gh = Object.assign({}, DEFAULT_GH, store.get(K_GH, {}) || {});
  // 老版本把这份配置（含 PAT）也写进了页面的 localStorage，顺手清掉
  if (HAS_GM) { try { localStorage.removeItem(K_GH); } catch (e) { /* ignore */ } }

  // 公司 → EP 行业的判定结果缓存：{ 公司名键: { sector, by:'ai'|'manual', ts } }
  let sectorCache = store.get(K_SEC, null);
  if (!sectorCache || typeof sectorCache !== 'object' || Array.isArray(sectorCache)) sectorCache = {};
  const saveSectorCache = () => store.set(K_SEC, sectorCache);

  let messages = store.get(K_MSG, []);
  if (!Array.isArray(messages)) messages = [];

  // 备注模板。首次使用给几条起手式，之后完全由用户自己维护。
  const DEFAULT_TEMPLATES = [
    { name: '催进度',  text: '麻烦帮忙催一下这家的进度。' },
    { name: '等结果',  text: '面试已完成，正在等对方回复结果。' },
    { name: '要材料',  text: '对方要求补充材料，麻烦确认具体要求。' },
    { name: '要安排',  text: '请帮忙安排下一轮的时间。' },
  ];
  let templates = store.get(K_TPL, null);
  if (!Array.isArray(templates)) templates = DEFAULT_TEMPLATES.map((t) => Object.assign({}, t));
  const saveTemplates = () => store.set(K_TPL, templates);

  // 直接推送用的文字模板，和备注模板各存各的
  const DEFAULT_PUSH_TEMPLATES = [
    { name: '投完了',   text: '今天这批投完了。' },
    { name: '帮忙看',   text: '有几家想请你帮忙看一下。' },
    { name: '暂停',     text: '这周先暂停，下周继续。' },
  ];

  // 通知板留言用的模板，和上面两套各存各的
  const DEFAULT_MSG_TEMPLATES = [
    {
      name: '暂停投递',
      text: '【留意】\n因目前堆积 XR ball 过多，为避免过负载影响质量，暂停投递',
    },
  ];
  let msgTemplates = store.get(K_MTL, null);
  if (!Array.isArray(msgTemplates)) msgTemplates = DEFAULT_MSG_TEMPLATES.map((t) => Object.assign({}, t));
  const saveMsgTemplates = () => store.set(K_MTL, msgTemplates);
  // 「✕ 不看」隐藏掉的职位：{ '<site>:<jobId>': { title, company, url, ts } }
  let hiddenJobs = store.get(K_HID, null);
  if (!hiddenJobs || typeof hiddenJobs !== 'object' || Array.isArray(hiddenJobs)) hiddenJobs = {};
  const saveHiddenJobs = () => store.set(K_HID, hiddenJobs);

  let pushTemplates = store.get(K_PTL, null);
  if (!Array.isArray(pushTemplates)) pushTemplates = DEFAULT_PUSH_TEMPLATES.map((t) => Object.assign({}, t));
  const savePushTemplates = () => store.set(K_PTL, pushTemplates);

  const saveGh = () => store.set(K_GH, gh, true);   // 含 PAT / API Key，只写油猴存储
  const saveUI = () => store.set(K_UI, ui);

  /** 一条记录「最后被改动」的时刻，用来在合并时判断谁更新 */
  const recStamp = (r) => Math.max(r && r.updatedAt || 0, r && r.ts || 0);

  /**
   * 把内存里的清单和存储里那份合起来，避免多标签页互相覆盖。
   *   - 两边都有：取 updatedAt 更新的那条（同时间以内存里的为准，那是刚改完的）
   *   - 只有存储里有：别的标签页新加的，收进来；除非它已经被本机删过（墓碑）
   *   - 只有内存里有：本标签页新加的，保留
   * 返回合并后的数组，并就地替换 records。
   */
  function mergeStored() {
    let stored = store.get(K_REC, []);
    if (!Array.isArray(stored)) stored = [];
    const mine = Object.create(null);
    records.forEach((r) => { if (r && r.id) mine[r.id] = r; });

    let changed = false;
    stored.forEach((s) => {
      if (!s || !s.id) return;
      if (deleted[s.id]) return;                       // 本机删过，别复活
      const m = mine[s.id];
      if (!m) { records.push(s); mine[s.id] = s; changed = true; return; }
      if (recStamp(s) > recStamp(m)) {
        records[records.indexOf(m)] = s;
        mine[s.id] = s;
        changed = true;
      }
    });
    return changed;
  }

  const saveRecords = () => {
    mergeStored();
    store.set(K_REC, records);
    scheduleSync();              // 函数声明会提升，此处可安全调用
  };
  const saveMessages = () => {
    // 留言也一样按 id 合并，规则简单些：存储里有而内存里没有的直接收进来
    let stored = store.get(K_MSG, []);
    if (!Array.isArray(stored)) stored = [];
    const seen = Object.create(null);
    messages.forEach((m) => { if (m && m.id) seen[m.id] = m; });
    stored.forEach((s) => {
      if (!s || !s.id || seen[s.id] || deleted[s.id]) return;
      messages.push(s);
      seen[s.id] = s;
    });
    store.set(K_MSG, messages);
    scheduleSync();
  };

  if (migrated) store.set(K_REC, records);   // 迁移结果落盘，但不触发同步

  /* =========================================================================
   * 2. 页面信息抓取
   *    LinkedIn 新版详情页的 class 名是随构建变化的哈希，不能依赖，
   *    因此统一用「可见文本锚点 + 结构关系」抓取，并保留旧版 class 兜底。
   * ========================================================================= */

  const norm = (el) => {
    if (!el) return '';
    const t = el.innerText != null ? el.innerText : el.textContent;
    return (t || '').replace(/\s+/g, ' ').trim();
  };

  const TEXT_SCAN_SEL = 'h1,h2,h3,h4,h5,p,span,strong,div,li,dt,dd';

  /** 找到可见文本正好等于 texts 之一的最内层元素 */
  function findByExactText(texts) {
    const want = texts.map((t) => t.toLowerCase());
    const nodes = document.querySelectorAll(TEXT_SCAN_SEL);
    for (const el of nodes) {
      if (el.childElementCount > 3) continue;
      const t = norm(el).toLowerCase().replace(/[:：]\s*$/, '');
      if (want.indexOf(t) !== -1) return el;
    }
    return null;
  }

  /** 从 el 向上找到第一个匹配 selector 的后代所在的祖先 */
  function climbUntil(el, selector, maxHops) {
    let cur = el;
    let hops = 0;
    while (cur && hops <= (maxHops || 5)) {
      if (cur.querySelector && cur.querySelector(selector)) return cur;
      cur = cur.parentElement;
      hops++;
    }
    return null;
  }

  /**
   * 当前页面正在展示的职位 ID —— 只认 URL。
   * 不能退化成「页面上第一个 /jobs/view/ 链接」：在 Job tracker 或搜索列表页，
   * 那会把别的卡片误当成当前职位。
   */
  function getJobId() {
    if (IS_JS) return jsJobId();
    const src = location.href + ' ' + (document.title || '');
    let m = src.match(/jobs[/:%3A]+view[/:%3A]+(\d{6,})/i);
    if (m) return m[1];
    m = src.match(/[?&]currentJobId=(\d{6,})/);
    if (m) return m[1];
    return '';
  }

  /**
   * Jobstreet 的职位 ID。
   *   /job/93732888                        单独的详情页
   *   /xxx-jobs/full-time?…&jobId=93732888 搜索页分屏时选中的那条
   * 存档的 HTML 文件名里参数是转义过的，所以先解一次码再匹配。
   * URL 上什么都没有时（分屏页直接进来就自动选中了第一条），再去右侧详情面板里
   * 那几个指向本职缺的链接上取，最后才退回列表里 aria-selected 的卡片。
   */
  function jsJobId() {
    let src = location.href;
    try { src = decodeURIComponent(src); } catch (e) { /* 解不开就用原串 */ }
    let m = src.match(/[/:]job[/:](\d{5,})/i);
    if (m) return m[1];
    m = src.match(/[?&]jobId=(\d{5,})/i);
    if (m) return m[1];

    const fromPane = jsPaneJobId();
    if (fromPane) return fromPane;

    const sel = document.querySelector('article[data-job-id][aria-selected="true"]');
    return (sel && sel.getAttribute('data-job-id')) || '';
  }

  /**
   * 右侧详情面板里指向「这条职缺自己」的链接。
   * 「New tab」按钮外面那层 a、标题上的 a、Apply 按钮的 a，href 都是
   * /job/<id>?ref=…，取出中间那串数字即可。
   */
  function jsPaneJobId() {
    const sels = [
      '#newTabButton',
      '[data-automation="job-detail-title"] a[href*="/job/"]',
      '[data-automation="job-detail-apply"]',
      '[data-automation="splitViewJobDetailsWrapper"] a[href*="/job/"]',
      '[data-automation="jobDetailsPage"] a[href*="/job/"]',
    ];
    for (const s of sels) {
      const node = document.querySelector(s);
      if (!node) continue;
      const a = node.matches('a[href]') ? node : (node.closest('a[href]') || node.querySelector('a[href]'));
      const href = a ? (a.getAttribute('href') || '') : '';
      const m = href.match(/\/job\/(\d{5,})/);
      if (m) return m[1];
    }
    return '';
  }

  /** Jobstreet 分屏页里当前选中（右侧正在展示）的那张卡片 */
  function currentJsCard() {
    const id = jsJobId();
    return (id && document.querySelector('article[data-job-id="' + id + '"]'))
        || document.querySelector('article[data-job-id][aria-selected="true"]');
  }

  /** 是不是「单个职位详情」页（决定要不要显示「已递交投递」按钮） */
  function isJobPage() { return !!getJobId(); }

  /** 是不是站内信页面（只有 LinkedIn 有） */
  function isMessagingPage() {
    if (IS_JS) return false;
    return /messaging[/:%3A]/i.test(location.href) || !!document.querySelector('.msg-thread-actions__control');
  }

  /**
   * 当前会话的对方信息。
   * 站内信用的还是 Ember 那套 UI，class 名是语义化的、比 jobs 页稳定得多。
   */
  function getThreadInfo() {
    const link  = document.querySelector('a.msg-thread__link-to-profile');
    const title = (link && link.querySelector('.msg-entity-lockup__entity-title'))
               || document.querySelector('.msg-title-bar .msg-entity-lockup__entity-title')
               || document.querySelector('.msg-entity-lockup__entity-title');
    const info  = (link && link.querySelector('.msg-entity-lockup__entity-info'))
               || document.querySelector('.msg-entity-lockup__entity-info');
    let thread = location.href.split('?')[0];
    const m = thread.match(/messaging[/:%3A]+thread[/:%3A]+([^/?#]+)/i);
    if (m) thread = 'https://www.linkedin.com/messaging/thread/' + decodeURIComponent(m[1]).replace(/\.html$/i, '') + '/';
    return {
      name: norm(title) || '(未知)',
      headline: norm(info),
      profileUrl: link ? (link.href || '').split('?')[0] : '',
      threadUrl: thread,
    };
  }

  /**
   * 驱动 LinkedIn 自己的会话菜单执行 Archive / Move to Other。
   * 菜单是 Ember 懒渲染的，点开之后才有内容，所以要轮询等它出现。
   */
  const THREAD_ACTIONS = {
    archive: { label: 'Archive',       re: /^(archive|存档|歸檔|归档|アーカイブ)$/i },
    other:   { label: 'Move to Other', re: /^(move to other|移至其他|移動先: その他|その他に移動)$/i },
  };

  /**
   * 线程头部的「更多」按钮。
   * 左侧会话列表里每张卡片也有同名按钮，点错会操作到别的会话，
   * 所以必须排除掉卡片里的那些，只认标题栏里的那一个。
   */
  // 左侧会话列表的范围。这里面的「三点」都是某张卡片的，不是当前线程的
  function inConversationList(b) {
    return !!(b.closest('.msg-conversation-card')
           || b.closest('.msg-conversation-listitem')
           || b.closest('.msg-conversations-container'));
  }

  // 右侧线程区域，从最贴近标题栏的往外找
  const THREAD_SCOPES = [
    '.msg-title-bar',
    '.msg-thread__topcard',
    '.msg-convo-wrapper',
    '.msg-thread',
    '.msg__detail',
    '.scaffold-layout__detail',
  ];

  function findThreadMenuTrigger() {
    // (a) 线程标题栏里的那个
    for (const sel of THREAD_SCOPES) {
      const scopes = document.querySelectorAll(sel);
      for (const scope of scopes) {
        const b = scope.querySelector('button.msg-thread-actions__control');
        if (b && !inConversationList(b)) return b;
      }
    }
    // (b) 对方头像链接旁边的
    const link = document.querySelector('a.msg-thread__link-to-profile');
    if (link && link.parentElement) {
      const inHeader = link.parentElement.querySelector('button.msg-thread-actions__control');
      if (inHeader) return inHeader;
    }
    // (c) 兜底：全页排除掉列表里的，唯一才认，不唯一宁可不动，交给人工
    const all = [].slice.call(document.querySelectorAll('button.msg-thread-actions__control'))
      .filter((b) => !inConversationList(b));
    return all.length === 1 ? all[0] : null;
  }

  /** 是不是真的有一个打开着的会话线程（不是光看 URL） */
  function hasOpenThread() { return !!findThreadMenuTrigger(); }

  // 菜单项可能是 button / [role=button]，也可能是套着它们的 li
  const MENU_ITEM_SEL = [
    '.msg-thread-actions__dropdown-options',
    '.msg-thread-actions__dropdown-options--inbox-shortcuts',
    '.artdeco-dropdown__content',
  ].map((box) => box + ' button,' + box + ' [role="button"],' + box + ' li').join(',');

  /** 命中的若是外层 li，真正能点的是里面那个按钮 */
  function clickTarget(node) {
    if (node.matches('button, a, [role="button"]')) return node;
    return node.querySelector('button, a, [role="button"]') || node;
  }

  /**
   * 菜单项的文字。菜单刚渲染出来、还没切到可见状态的那一小段时间里
   * innerText 是空的（不可见的文本不计入），所以要退回 textContent，
   * 否则会白等到超时。
   */
  function itemText(el) {
    return norm(el) || (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 点开某个「更多」菜单，等 Ember 把菜单渲染出来后点掉匹配的那一项。
   * scope 限定在这个菜单自己的下拉容器里，避免点到别的会话的同名菜单项。
   */
  async function runMenuAction(trigger, kind, scope) {
    const spec = THREAD_ACTIONS[kind];
    trigger.click();
    const box = scope || trigger.closest('.artdeco-dropdown') || document;

    for (let i = 0; i < 25; i++) {
      await new Promise((res) => setTimeout(res, 100));
      const items = box.querySelectorAll(MENU_ITEM_SEL);
      for (const it of items) {
        const label = itemText(it);
        if (spec.re.test(label)) {
          clickTarget(it).click();
          // 正常情况下 LinkedIn 自己会把菜单收起来，万一没收就补一下，
          // 别在页面上留一个张着的下拉（卡片被移走时 trigger 已经不在文档里了）
          setTimeout(() => {
            if (document.contains(trigger) && trigger.getAttribute('aria-expanded') === 'true') trigger.click();
          }, 400);
          return { ok: true, label: label };
        }
      }
    }
    trigger.click();   // 没找到就把菜单关回去，别留个打开的下拉
    return { ok: false, why: '菜单里没有「' + spec.label + '」这一项' };
  }

  /**
   * 当前打开的这个会话（标题栏那个菜单）。
   * LinkedIn 是 SPA：刚点进站内信时 URL 已经变了、线程还没渲染出来，
   * 这时候直接报错太急躁，先等它一会儿。
   */
  async function runThreadAction(kind) {
    let trigger = findThreadMenuTrigger();
    for (let i = 0; !trigger && i < 15; i++) {
      await new Promise((res) => setTimeout(res, 120));
      trigger = findThreadMenuTrigger();
    }
    if (!trigger) {
      return { ok: false, why: '这个页面上没有打开着的会话（线程还没加载出来，或者停在了别的页面）' };
    }
    return runMenuAction(trigger, kind, trigger.closest('.msg-thread-actions__dropdown') || document);
  }

  /** 左侧列表里指定的某张会话卡片（用它自己那个「三点」菜单） */
  async function runCardAction(card, kind) {
    const trigger = card && card.querySelector('button.msg-thread-actions__control');
    if (!trigger) return { ok: false, why: '这张卡片上找不到「三点」菜单按钮' };
    return runMenuAction(trigger, kind, trigger.closest('.artdeco-dropdown') || card);
  }

  function getJobUrl() {
    const id = getJobId();
    if (!id) return location.href;
    return IS_JS ? (JS_ORIGIN + '/job/' + id) : ('https://www.linkedin.com/jobs/view/' + id + '/');
  }

  /**
   * Jobstreet 的岗位名 + 公司名。
   * data-automation 是 SEEK 系站点自己的自动化测试锚点，比 class 稳定得多。
   */
  function jsTitleAndCompany() {
    let title = norm(document.querySelector('[data-automation="job-detail-title"]'));
    let company = norm(document.querySelector('[data-automation="advertiser-name"]'));

    // 详情面板还没渲染出来（或就在纯列表页）时，退回当前选中的卡片
    if (!title || !company) {
      const card = currentJsCard();
      if (card) {
        if (!title)   title   = norm(card.querySelector('[data-automation="jobTitle"]'));
        if (!company) company = norm(card.querySelector('[data-automation="jobCompany"]'));
      }
    }
    return { title: title, company: company };
  }

  /** 岗位名 + 公司名 */
  function getTitleAndCompany() {
    if (IS_JS) return jsTitleAndCompany();

    let title = '';
    let company = '';

    // (a) document.title：「岗位 | 公司 | LinkedIn」或「公司 hiring 岗位 in 地区 | LinkedIn」
    let dt = (document.title || '').replace(/^\(\d+\)\s*/, '').trim();
    dt = dt.replace(/\s*[|｜]\s*LinkedIn\s*$/i, '').trim();
    const hiring = dt.match(/^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+[^|]+)?$/i);
    if (hiring) {
      company = hiring[1].trim();
      title = hiring[2].trim();
    } else {
      const parts = dt.split(/\s*[|｜]\s*/).map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) { title = parts[0]; company = parts[1]; }
      else if (parts.length === 1) { title = parts[0]; }
    }

    // (b) DOM 兜底：岗位名
    if (!title) {
      const sels = [
        '.job-details-jobs-unified-top-card__job-title h1',
        '.job-details-jobs-unified-top-card__job-title',
        '.jobs-unified-top-card__job-title',
        '.topcard__title',
        '.top-card-layout__title',
        'main h1',
        'h1',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && norm(el)) { title = norm(el); break; }
      }
    }

    // (c) DOM 兜底：公司名（页面顶部第一个 /company/ 链接）
    if (!company) {
      const sels = [
        '.job-details-jobs-unified-top-card__company-name a',
        '.job-details-jobs-unified-top-card__company-name',
        '.jobs-unified-top-card__company-name a',
        '.topcard__org-name-link',
        'main a[href*="/company/"]',
        'a[href*="/company/"]',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && norm(el)) { company = norm(el).split('\n')[0].trim(); break; }
      }
    }

    return { title: title, company: company };
  }

  /** Meet the hiring team → [{ name, url, role }]（Jobstreet 不公开招聘负责人） */
  function getHiringTeam() {
    const out = [];
    if (IS_JS) return out;
    const seen = Object.create(null);

    const push = (name, url, role) => {
      url = (url || '').split('?')[0];
      if (!url || seen[url]) return;
      seen[url] = 1;
      out.push({ name: (name || '').trim(), url: url, role: (role || '').trim() });
    };

    // "• 3rd" / "· 2nd degree" 这类人脉度数标记，既不是姓名也不是职位
    const DEGREE_RE = /^[•·・‧∙]?\s*(?:1st|2nd|3rd|\d+(?:st|nd|rd|th))(?:\s*(?:degree|connection))?\s*$/i;

    const cleanName = (s) => (s || '')
      .split('\n')[0]
      .replace(/\s*[•·・‧∙]\s*(?:1st|2nd|3rd|\d+(?:st|nd|rd|th))(?:\s*(?:degree|connection))?\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    const isDegree = (s) => !s || DEGREE_RE.test(s);

    // 新版：文本锚点 "Meet the hiring team"
    const label = findByExactText(['meet the hiring team', 'meet the hiring team:']);
    let scope = label ? climbUntil(label.parentElement || label, 'a[href*="/in/"]', 4) : null;

    // 旧版兜底
    if (!scope) {
      scope = document.querySelector('.hirer-card__hirer-information')
           || document.querySelector('.jobs-poster__name')
           || document.querySelector('.job-details-people-who-can-help__section');
      if (scope && !scope.querySelector('a[href*="/in/"]')) {
        scope = climbUntil(scope, 'a[href*="/in/"]', 4);
      }
    }
    if (!scope) return out;

    scope.querySelectorAll('a[href*="/in/"]').forEach((a) => {
      // 卡片内的文本块依次是：姓名 / 人脉度数 / 头衔 / "Job poster"
      const lines = [];
      a.querySelectorAll('p, .jobs-poster__name, strong').forEach((p) => {
        const t = cleanName(norm(p));
        if (t && !isDegree(t) && lines.indexOf(t) === -1) lines.push(t);
      });
      if (!lines.length) {
        const t = cleanName(a.getAttribute('aria-label') || norm(a));
        if (t) lines.push(t);
      }

      const name = lines[0] || '';
      const role = (lines[1] && lines[1] !== name) ? lines[1] : '';

      push(name, a.href || a.getAttribute('href'), role);
    });

    return out;
  }

  /**
   * Job match（Premium 的匹配度）。
   * 原文形如「Job match is high, we can help you stand out」，
   * 也兼容「Job match: high」这类写法。没有就返回空。
   */
  const JOB_MATCH_RE = /job\s*match\s*(?:is|：|:)?\s*(high|medium|moderate|low)\b/i;
  const MATCH_LEVEL = { high: 'High', medium: 'Medium', moderate: 'Medium', low: 'Low' };

  function getJobMatch() {
    if (IS_JS) return '';        // Jobstreet 没有这个指标，它给的是下面的徽章
    // 先在小块文本里找，命中的元素更可能是那句原文
    const nodes = document.querySelectorAll('p, span, h1, h2, h3, h4, div, li, strong');
    for (const el of nodes) {
      if (el.childElementCount > 4) continue;
      const t = norm(el);
      if (t.length > 200) continue;
      const m = t.match(JOB_MATCH_RE);
      if (m) return MATCH_LEVEL[m[1].toLowerCase()] || '';
    }
    // 兜底：整页文本里再找一次
    const m2 = norm(document.body).slice(0, 300000).match(JOB_MATCH_RE);
    return m2 ? (MATCH_LEVEL[m2[1].toLowerCase()] || '') : '';
  }

  /**
   * 正文里提到的工作年限要求，例如
   *   "5+ years of experience" / "3-5 years experience" / "minimum 8 years' experience"
   * 收集所有出现过的数字，去重后按小到大列出。
   */
  const YEARS_RE = /(\d{1,2})\s*(?:\+|\s*-\s*\d{1,2})?\s*(?:\+)?\s*year[s]?(?:['’]s)?\s*(?:of\s+)?(?:relevant\s+|working\s+|professional\s+)?experience/gi;

  function getYearsExperience() {
    const text = norm(document.body).slice(0, 300000);
    const found = [];
    let m;
    YEARS_RE.lastIndex = 0;
    while ((m = YEARS_RE.exec(text)) !== null) {
      const whole = m[0];
      // 区间写法「3-5 years」两个数字都要
      const nums = (whole.match(/\d{1,2}/g) || []).map(Number).filter((n) => n >= 1 && n <= 30);
      nums.forEach((n) => { if (found.indexOf(n) === -1) found.push(n); });
      if (found.length > 6) break;
    }
    found.sort((a, b) => a - b);
    return found.length ? (found.join(' / ') + ' 年') : '';
  }

  /**
   * Jobstreet 详情页顶部的徽章：Strong applicant / Early applicant / New to you。
   * 「Strong applicant」是站方算出来的匹配度，等价于 LinkedIn 的 Job match。
   */
  function getJsBadge() {
    if (!IS_JS) return '';
    const sels = [
      '[data-automation="jdv-badges-section"] [data-testid="job-status-badge"]',
      '[data-automation="jdv-badges-section"] [data-automation$="AdBadge"]',
      '#topApplicant',
    ];
    for (const s of sels) {
      const t = norm(document.querySelector(s));
      if (t && t.length <= 40) return t;
    }
    return '';
  }

  /** Jobstreet 标出来的薪资（没写薪资的职缺就是空） */
  function getSalary() {
    if (!IS_JS) return '';
    let t = norm(document.querySelector('[data-automation="job-detail-salary"]'));
    if (!t) {
      const card = currentJsCard();
      if (card) t = norm(card.querySelector('[data-automation="jobSalary"]'));
    }
    return t.length > 60 ? '' : t;
  }

  /** Total employees —— 结构是 <p>548</p><p>Total employees</p> 两个兄弟节点 */
  function getTotalEmployees() {
    if (IS_JS) return '';
    const label = findByExactText(['total employees', '员工总数', '従業員数']);
    if (label) {
      const scope = label.parentElement || label;
      const m = norm(scope).match(/([\d][\d,]*)\s*(?:total employees|员工总数|従業員数)/i);
      if (m) return m[1].replace(/,/g, '');
      // 数字在前一个兄弟节点里
      const prev = label.previousElementSibling;
      if (prev) {
        const t = norm(prev).replace(/,/g, '');
        if (/^\d+$/.test(t)) return t;
      }
    }
    return '';
  }

  /** Median employee tenure（LinkedIn Premium 才有） */
  function getMedianTenure() {
    if (IS_JS) return '';
    // 含该短语的元素有一串祖先，取文本最短（也就是最贴近数值）的那个，
    // 否则会把整块 Premium Insights 的文字一起吞进来。
    let best = null;
    let bestLen = Infinity;
    document.querySelectorAll('p,span,div,li,dd').forEach((el) => {
      if (el.childElementCount > 4) return;
      const t = norm(el);
      if (!/median employee tenure/i.test(t)) return;
      if (t.length < bestLen) { bestLen = t.length; best = el; }
    });
    if (!best) return '';

    const strong = best.querySelector('strong,b');
    if (strong && norm(strong)) return norm(strong);

    const t = norm(best);
    const m = t.match(/median employee tenure\s*[:：]?\s*([\d.,]+\s*\+?\s*(?:years?|yrs?|months?|mos?|年|ヶ月|か月))/i);
    if (m) return m[1].trim();

    const m2 = t.match(/median employee tenure\s*[:：]?\s*(.{1,30}?)\s*$/i);
    return m2 ? m2[1].trim() : '';
  }

  function collectJobInfo() {
    const tc = getTitleAndCompany();
    return {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      site: SITE,                // 'linkedin' | 'jobstreet'
      jobId: getJobId(),
      jobUrl: getJobUrl(),
      company: tc.company,
      title: tc.title,
      hirers: getHiringTeam(),
      ts: Date.now(),
      // 右下角「📊 公司数据」里那几项，记录时一并存下来带去看板详情页
      employees: getTotalEmployees(),
      years: getYearsExperience(),
      jobMatch: getJobMatch() || getJsBadge(),
      tenure: getMedianTenure(),
      memo: '',
      status: defaultStatus(),
      scout: false,              // 人事主动 scout 的
      sector: '',                // EP 所属行业（C1 薪资基准用）
      priority: 0,               // 重要度，看板排序时压过状态与时间
      followUpAt: 0,             // 跟进提醒日期（当天 0 点的毫秒）
      followUpNote: '',
      updatedAt: 0,              // 最后一次改 MEMO / 状态的时间
    };
  }

  /* =========================================================================
   * 3. UI（Shadow DOM 隔离，避免被 LinkedIn 样式污染）
   * ========================================================================= */

  const HOST_ID = 'lat-host-root';

  // 若脚本被重复注入：移除旧宿主，并用「代际标记」让旧实例的守护定时器自行退休
  const GEN = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const oldHost = document.getElementById(HOST_ID);
  if (oldHost) oldHost.remove();
  document.documentElement.dataset.latGen = GEN;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
  (document.body || document.documentElement).appendChild(host);

  const root = host.attachShadow({ mode: 'open' });

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif; }

  /* 主题变量定义在 :host 上，好让 shadow 树里所有节点（含弹窗）都能继承 */
  :host {
    --bg: #ffffff;
    --fg: #1f2328;
    --sub: #5b6470;
    --line: #d8dee4;
    --head: #f4f6f8;
    --accent: #0a66c2;
    --accent-fg: #ffffff;
    --ok: #0f7b3f;
    --shadow: 0 6px 24px rgba(0,0,0,.18);
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --bg: #1d2226; --fg: #e9e6e3; --sub: #9aa3ab; --line: #38434f;
      --head: #262d34; --accent: #71b7ff; --accent-fg: #06121f; --ok: #63d297;
      --shadow: 0 6px 24px rgba(0,0,0,.5);
    }
  }

  .bar, .panel { position: fixed; z-index: 2147483647; }

  /* 右上角快捷入口 */
  .navbar {
    position: fixed; top: 12px; right: 16px; z-index: 2147483646;
    display: flex; gap: 8px;
  }
  .navbtn {
    font-size: 12px; font-weight: 600; text-decoration: none; white-space: nowrap;
    padding: 7px 13px; border-radius: 999px;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); box-shadow: var(--shadow);
  }
  .navbtn:hover { border-color: var(--accent); color: var(--accent); }

  /* 右下角公司数据 */
  .stats {
    position: fixed; z-index: 2147483646;
    min-width: 168px; padding: 10px 12px; border-radius: 12px;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); box-shadow: var(--shadow);
    font-size: 12px; user-select: none;
  }
  .stats[hidden] { display: none; }
  .stats .sthdr {
    font-size: 11px; font-weight: 700; color: var(--sub);
    margin-bottom: 7px; cursor: grab;
  }
  .stats .sthdr.dragging { cursor: grabbing; }
  .strow { display: flex; align-items: baseline; gap: 10px; line-height: 1.7; }
  .strow span { color: var(--sub); }
  .strow b { margin-left: auto; font-size: 13px; font-variant-numeric: tabular-nums; }
  .strow[hidden] { display: none; }

  /* ---------- 同公司已投过的提醒（醒目黄） ---------- */
  /* 顶部居中的常亮横幅，不遮挡页面 */
  /* 用 .mask.comask 提高特异性：这段写在 .mask 之前，同特异性会被它覆盖掉 */
  .mask.comask {
    inset: auto;                 /* inset 是简写，必须写在 top/left 之前 */
    position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
    z-index: 2147483645; background: none; display: block;
    width: min(620px, calc(100vw - 24px)); max-height: 42vh; overflow: auto;
    pointer-events: auto;
  }
  .mask.comask[hidden] { display: none; }
  .codlg {
    background: #fff8d6; color: #3d3200;
    border: 2px solid #eab308; border-radius: 12px;
    box-shadow: 0 6px 22px rgba(0,0,0,.28); padding: 12px 16px;
  }
  .codlg.mini .colist, .codlg.mini .cotitle, .codlg.mini .corow,
  .codlg.mini .coreject { display: none; }
  .cohead { cursor: pointer; }

  /* 同步成功横幅 */
  .syncbanner {
    position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
    z-index: 2147483646; width: min(520px, calc(100vw - 24px));
    background: #e7f6ec; color: #14532d; border: 2px solid #16a34a; border-radius: 12px;
    box-shadow: 0 6px 22px rgba(0,0,0,.24); padding: 11px 15px; font-size: 13px; line-height: 1.6;
  }
  .syncbanner[hidden] { display: none; }
  .syncbanner b { display: block; margin-bottom: 4px; }
  .syncbanner div { font-size: 12px; }
  .cohead { font-size: 14px; font-weight: 800; margin-bottom: 4px; }
  .cotitle { font-size: 13px; color: #6b5a00; margin-bottom: 12px; }
  .colist { display: grid; gap: 8px; }
  .coitem {
    background: rgba(255,255,255,.72); border: 1px solid #e6c200; border-radius: 10px;
    padding: 9px 12px; font-size: 13px; line-height: 1.6;
  }
  .coitem .cojob { font-weight: 700; color: #7a4b00; text-decoration: none; }
  .coitem .cojob:hover { text-decoration: underline; }
  .coitem .cometa { font-size: 12px; color: #6b5a00; margin-top: 2px; }
  .coitem .costat {
    display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 999px;
    background: #eab308; color: #2a2300; font-weight: 700; font-size: 11.5px;
  }
  /* 同一家公司出现过「书类落了 / 面试落了」时，黄框下面再补一段红色的 */
  .coreject {
    margin: 0 0 12px; padding: 10px 12px; border-radius: 10px;
    background: #fdeaea; border: 2px solid #d93025; color: #7f1d1d;
  }
  .coreject .rjhead { font-size: 13px; font-weight: 800; margin-bottom: 6px; }
  .coreject .rjitem { font-size: 12.5px; line-height: 1.6; }
  .coreject .rjitem .rjstat {
    display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 999px;
    background: #d93025; color: #fff; font-weight: 700; font-size: 11px;
  }
  .coreject[hidden] { display: none; }

  .corow { display: flex; justify-content: flex-end; margin-top: 14px; }
  .cook {
    font: inherit; font-size: 13px; font-weight: 700; padding: 8px 18px; border-radius: 9px;
    border: 0; background: #eab308; color: #2a2300; cursor: pointer;
  }
  .cook:hover { filter: brightness(1.06); }
  .strow b.match.lv-high   { color: var(--ok); }
  .strow b.match.lv-medium { color: #b45309; }
  .strow b.match.lv-low    { color: #d93025; }
  @media (prefers-color-scheme: dark) {
    .strow b.match.lv-medium { color: #fbbf24; }
    .strow b.match.lv-low    { color: #f87171; }
  }

  /* ---------- 悬浮按钮组 ---------- */
  .bar {
    display: flex; align-items: stretch; gap: 6px;
    padding: 6px; border-radius: 12px;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); box-shadow: var(--shadow);
    user-select: none; cursor: grab;
  }
  .bar.dragging { cursor: grabbing; }
  .bar .grip {
    width: 12px; border-radius: 6px; flex: 0 0 12px;
    background: repeating-linear-gradient(to bottom, var(--line) 0 2px, transparent 2px 5px);
  }
  .bar button {
    font-size: 13px; line-height: 1; padding: 9px 12px;
    border-radius: 8px; border: 1px solid transparent; cursor: pointer;
    background: var(--accent); color: var(--accent-fg); font-weight: 600;
    white-space: nowrap;
  }
  .bar button.ghost {
    background: transparent; color: var(--fg); border-color: var(--line); font-weight: 500;
  }
  .bar button:hover { filter: brightness(1.08); }
  .bar button.done { background: var(--ok); color: #fff; }
  .bar button:disabled { opacity: .75; cursor: default; }

  /* ---------- 悬浮清单 ---------- */
  .panel {
    display: flex; flex-direction: column;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 12px;
    box-shadow: var(--shadow); overflow: hidden;
    min-width: 380px; min-height: 180px;
  }
  .panel[hidden] { display: none; }
  .hdr {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; background: var(--head);
    border-bottom: 1px solid var(--line);
    cursor: grab; user-select: none; flex: 0 0 auto;
  }
  .hdr.dragging { cursor: grabbing; }
  .hdr .ttl { font-size: 13px; font-weight: 700; margin-right: auto; white-space: nowrap; }
  .hdr .ttl em { font-style: normal; color: var(--sub); font-weight: 500; }
  .hdr button {
    font-size: 12px; padding: 5px 9px; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg); white-space: nowrap;
  }
  .hdr button:hover { background: var(--line); }

  /* 🔍 公司名快速定位 */
  .hdr .srchbox { position: relative; flex: 0 1 180px; min-width: 110px; }
  .hdr input.srch {
    width: 100%; box-sizing: border-box; font: inherit; font-size: 12px;
    padding: 5px 8px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
  }
  .hdr input.srch:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .sugg {
    position: absolute; left: 0; top: calc(100% + 4px); min-width: 100%; max-width: 320px;
    max-height: 260px; overflow: auto; padding: 4px; z-index: 6;
    background: var(--bg); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow);
  }
  .sugg[hidden] { display: none; }
  .sugg .item {
    display: flex; align-items: center; gap: 8px; padding: 5px 7px;
    border-radius: 6px; cursor: pointer; font-size: 12px;
  }
  .sugg .item .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sugg .item .n { margin-left: auto; color: var(--sub); font-size: 11px; white-space: nowrap; }
  .sugg .item.on, .sugg .item:hover { background: var(--line); }
  .sugg .none { padding: 6px 7px; color: var(--sub); font-size: 12px; white-space: nowrap; }
  /* 定位到的那家公司的所有行 */
  tbody tr.hit > td { background: color-mix(in srgb, var(--accent) 16%, transparent); }

  .body { flex: 1 1 auto; overflow: auto; }
  /* 固定布局 + 百分比列宽：默认尺寸下 9 列全部可见；面板被缩得太窄时才出现横向滚动 */
  table { border-collapse: collapse; width: 100%; min-width: 1320px; table-layout: fixed; font-size: 12px; }
  thead th {
    position: sticky; top: 0; z-index: 2;
    background: var(--head); color: var(--sub);
    text-align: left; font-weight: 600; white-space: nowrap;
    padding: 7px 8px; border-bottom: 1px solid var(--line);
  }
  tbody td {
    padding: 6px 8px; border-bottom: 1px solid var(--line);
    vertical-align: top; color: var(--fg);
    overflow-wrap: anywhere; word-break: break-word;
  }
  tbody tr:hover td { background: rgba(127,127,127,.08); }
  /* 书类落了 / 面试落了：整行划掉并置灰 */
  tbody tr.closed td { color: var(--sub); text-decoration: line-through; }
  tbody tr.closed td a { color: var(--sub); text-decoration: line-through; }
  tbody tr.closed .role { text-decoration: line-through; }
  tbody tr.closed select, tbody tr.closed textarea { text-decoration: none; opacity: .75; }
  tbody tr.flash td { animation: flash 1.4s ease-out; }
  @keyframes flash { from { background: rgba(255,193,7,.55); } to { background: transparent; } }

  .c-pr   { width: 6%;  text-align: center; }
  td.c-pr select { font-size: 12px; text-align: center; padding: 3px 2px; }
  td.c-pr select.p3 { color: #d93025; font-weight: 700; }
  td.c-pr select.p2 { color: #e08600; font-weight: 600; }
  .c-sc   { width: 5%;  text-align: center; }
  .c-ts   { width: 13%; color: var(--sub); font-size: 11px; }
  .c-co   { width: 8%; }
  .c-ti   { width: 11%; }
  .c-hr   { width: 8%; }
  .c-te   { width: 5%;  }
  .c-st   { width: 11%; }
  .c-me   { width: 9%; }
  .c-op   { width: 5%;  white-space: nowrap; text-align: center; }
  .c-ep   { width: 12%; }
  .c-eb   { width: 7%;  text-align: right; white-space: nowrap; }
  .c-ea   { width: 7%;  text-align: right; white-space: nowrap; }

  th.c-sc { font-size: 10px; line-height: 1.25; white-space: normal; }
  td.c-sc input { width: 16px; height: 16px; cursor: pointer; margin: 2px 0 0; }
  input[type="datetime-local"] {
    width: 100%; font: inherit; font-size: 11px; color: var(--fg); background: var(--bg);
    border: 1px solid var(--line); border-radius: 6px; padding: 3px 4px;
  }
  input[type="datetime-local"]:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

  td a { color: var(--accent); text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .hirer + .hirer { display: block; margin-top: 2px; }
  .role {
    color: var(--sub); font-size: 11px; line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  /* 模型预填的行业，配色提醒你核对一下 */
  select.ai-guess {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
    background: color-mix(in srgb, var(--accent) 10%, var(--bg));
  }

  select, textarea {
    width: 100%; font-size: 11px; color: var(--fg); background: var(--bg);
    border: 1px solid var(--line); border-radius: 6px; padding: 4px 5px;
    font-family: inherit;
  }
  textarea { resize: vertical; min-height: 32px; max-height: 120px; line-height: 1.35; overflow: hidden; }
  select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

  /* MEMO 单元格：只做预览，点开才编辑 */
  .memo-cell {
    width: 100%; text-align: left; font: inherit; font-size: 11px; line-height: 1.45;
    color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
    padding: 5px 6px; cursor: text; white-space: pre-wrap; word-break: break-word;
    max-height: 64px; overflow: hidden; display: block;
  }
  .memo-cell:hover { border-color: var(--accent); }
  .memo-cell.blank { color: var(--sub); font-style: italic; }

  .op-btn {
    border: none; background: transparent; cursor: pointer; font-size: 13px;
    padding: 2px 3px; color: var(--sub); border-radius: 5px;
  }
  .op-btn:hover { background: var(--line); color: var(--fg); }

  .empty { padding: 26px 14px; text-align: center; color: var(--sub); font-size: 13px; }

  .rz {
    position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
    cursor: nwse-resize; z-index: 3;
    background: linear-gradient(135deg, transparent 0 48%, var(--line) 48% 58%, transparent 58% 70%,
                                var(--line) 70% 80%, transparent 80%);
  }

  .toast {
    position: fixed; z-index: 2147483647;
    padding: 9px 14px; border-radius: 9px; font-size: 13px;
    background: rgba(20,20,20,.92); color: #fff; box-shadow: var(--shadow);
    pointer-events: none; opacity: 0; transition: opacity .18s ease;
  }
  .toast.show { opacity: 1; }

  /* ---------- GitHub 同步 ---------- */
  .hdr button.gh { font-variant-numeric: tabular-nums; }
  .hdr button.gh.ok   { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
  .hdr button.gh.err  { color: #d93025; border-color: #d93025; }
  .hdr button.gh.busy { opacity: .6; }

  .mask {
    position: fixed; inset: 0; background: rgba(0,0,0,.45);
    display: flex; align-items: center; justify-content: center; z-index: 2147483647;
  }
  .mask[hidden] { display: none; }
  .dlg {
    width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto;
    background: var(--bg); color: var(--fg); border: 1px solid var(--line);
    border-radius: 14px; box-shadow: var(--shadow); padding: 18px 20px;
  }
  .dlg h3 { margin: 0 0 4px; font-size: 15px; }
  .dlg .desc { color: var(--sub); font-size: 12px; line-height: 1.6; margin-bottom: 14px; }
  .dlg label { display: block; font-size: 12px; font-weight: 600; margin: 12px 0 4px; }
  .dlg input[type=text], .dlg input[type=password] {
    width: 100%; font: inherit; font-size: 13px; padding: 7px 9px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--head); color: var(--fg);
  }
  .dlg input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .dlg .tip { color: var(--sub); font-size: 11px; margin-top: 4px; line-height: 1.5; }
  .dlg .chk { display: flex; align-items: center; gap: 7px; margin-top: 14px; font-size: 13px; }
  .dlg .chk input { width: 15px; height: 15px; }
  /* 放在按钮那一行里的复选框：别再顶一个上边距出来 */
  .dlg .row .chk.inline { margin-top: 0; font-size: 12px; color: var(--sub); white-space: nowrap; }
  .dlg .row { display: flex; gap: 8px; margin-top: 18px; }
  .dlg .row button {
    font: inherit; font-size: 13px; padding: 8px 13px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
  }
  .dlg .row button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 600; }
  .dlg .row button:hover { filter: brightness(1.08); }
  .dlg .row .sp { margin-left: auto; }
  .dlg .status { margin-top: 14px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .dlg .status.ok  { color: var(--ok); }
  .dlg .status.err { color: #d93025; }

  /* ---------- 通用确认弹窗 ---------- */
  .dlg .body-text { font-size: 13px; line-height: 1.7; color: var(--fg); white-space: pre-wrap; word-break: break-word; }
  .dlg .row button.danger { background: #d93025; color: #fff; border-color: transparent; font-weight: 600; }

  /* ---------- 点击 Apply 后的非阻塞提示条 ---------- */
  .ask {
    position: fixed; z-index: 2147483647;
    width: min(330px, calc(100vw - 24px));
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 12px;
    box-shadow: var(--shadow); padding: 13px 15px;
  }
  .ask[hidden] { display: none; }
  .ask .t { font-size: 13px; font-weight: 700; margin-bottom: 3px; }
  .ask .d { font-size: 12px; color: var(--sub); line-height: 1.55; word-break: break-word; }
  .ask .row { display: flex; gap: 8px; margin-top: 12px; }
  .ask button {
    font: inherit; font-size: 12px; padding: 7px 12px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
  }
  .ask button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 600; }
  .ask button:hover { filter: brightness(1.08); }
  .ask .sp { margin-left: auto; }

  /* ---------- 通知板 ---------- */
  .dlg.wide { width: min(560px, calc(100vw - 32px)); }
  .dlg h3 .cnt { font-style: normal; font-weight: 500; color: var(--sub); font-size: 13px; }
  .minput {
    width: 100%; min-height: 74px; resize: vertical; font: inherit; font-size: 13px; line-height: 1.5;
    padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px;
    background: var(--head); color: var(--fg);
  }
  .minput:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  /* 会随内容长高的输入框：上面那条通用 textarea 规则把高度锁在 120px，这里放开，
     具体到多高由 autoGrow() 按视口算 */
  .minput.grow { max-height: none; resize: none; }
  /* MEMO 时间轴：一条一块，新的在上面 */
  .memolog { margin-top: 10px; max-height: 40vh; overflow: auto; }
  .memoitem {
    border: 1px solid var(--line); border-left: 3px solid var(--line);
    border-radius: 9px; padding: 7px 10px; margin-bottom: 7px; background: var(--head);
  }
  .memoitem.latest { border-left-color: var(--accent); }
  .memohd { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
  .memots { font-size: 11px; color: var(--sub); font-variant-numeric: tabular-nums; }
  .memotag {
    font-size: 10px; padding: 0 5px; border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent);
  }
  .memohd .op-btn { margin-left: auto; }
  .memobody { font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }

  .mlist { margin-top: 6px; max-height: 320px; overflow: auto; border-top: 1px solid var(--line); }
  .mempty { padding: 20px 4px; text-align: center; color: var(--sub); font-size: 12px; }
  .mitem { padding: 10px 2px; border-bottom: 1px solid var(--line); }
  .mitem:last-child { border-bottom: 0; }
  .mtext { font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .medit {
    width: 100%; min-height: 66px; resize: vertical; font: inherit; font-size: 13px; line-height: 1.5;
    padding: 7px 9px; border: 1px solid var(--accent); border-radius: 8px;
    background: var(--head); color: var(--fg);
  }
  .mmeta { display: flex; align-items: center; gap: 8px; margin-top: 5px; font-size: 11px; color: var(--sub); }
  .mops { margin-left: auto; display: flex; gap: 2px; }

  /* ---------- 📢 请求更新状态 ---------- */
  .dlg select {
    width: 100%; font: inherit; font-size: 13px; padding: 7px 9px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--head); color: var(--fg);
  }
  .dlg select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .rminfo {
    font-size: 12px; color: var(--fg); line-height: 1.6; white-space: pre-wrap; word-break: break-word;
    background: var(--head); border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px;
    max-height: 240px; overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .previewhdr {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; font-weight: 600; margin: 16px 0 5px;
  }
  .previewhdr .cnum { margin-left: auto; font-weight: 500; color: var(--sub); font-variant-numeric: tabular-nums; }
  .previewhdr .cnum.over { color: #d93025; font-weight: 700; }
  .rmhint {
    font-size: 11.5px; color: var(--sub); line-height: 1.6; margin-top: 6px;
    white-space: pre-wrap; word-break: break-word;
  }
  .rmhint.warn { color: #d93025; }
  .rmhint:empty { display: none; }

  /* ---------- 备注模板 ---------- */
  .tplbar { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 7px; }
  .tplchip {
    font: inherit; font-size: 11.5px; padding: 4px 10px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--line); background: var(--head); color: var(--fg);
    max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tplchip:hover { border-color: var(--accent); color: var(--accent); }
  .tplchip.gear { color: var(--sub); border-style: dashed; }

  .tpllist { max-height: 300px; overflow: auto; margin-top: 6px; border-top: 1px solid var(--line); }
  .tplitem { padding: 10px 2px; border-bottom: 1px solid var(--line); }
  .tplitem:last-child { border-bottom: 0; }
  .tplrow { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
  .tplname {
    flex: 1 1 auto; font: inherit; font-size: 12px; font-weight: 600; padding: 5px 8px;
    border: 1px solid var(--line); border-radius: 7px; background: var(--head); color: var(--fg);
  }
  .tpltext {
    width: 100%; min-height: 52px; resize: vertical; font: inherit; font-size: 12px; line-height: 1.5;
    padding: 6px 8px; border: 1px solid var(--line); border-radius: 7px;
    background: var(--head); color: var(--fg);
  }
  .tplname:focus, .tpltext:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

  /* ---------- 状态管理 ---------- */
  .ordlist { max-height: 380px; overflow: auto; border: 1px solid var(--line); border-radius: 9px; margin-top: 6px; }
  .orditem {
    display: flex; align-items: center; gap: 8px; padding: 7px 10px; font-size: 12.5px;
    border-bottom: 1px solid var(--line); background: var(--bg); cursor: grab; user-select: none;
  }
  .orditem:last-child { border-bottom: 0; }
  .orditem.dragging { opacity: .4; }
  .orditem.over { border-top: 2px solid var(--accent); }
  .orditem .no { color: var(--sub); font-variant-numeric: tabular-nums; min-width: 18px; }
  .orditem .grip { color: var(--sub); cursor: grab; }
  .orditem .dot { width: 9px; height: 9px; border-radius: 3px; flex: 0 0 9px; background: var(--sub); }
  /* 可改名的名字框：平时看着像纯文本，聚焦了才显出输入框的样子 */
  .orditem .stname {
    flex: 1 1 auto; min-width: 0; font: inherit; font-size: 12.5px; color: var(--fg);
    padding: 4px 6px; border: 1px solid transparent; border-radius: 6px; background: transparent;
    user-select: text; cursor: text;
  }
  .orditem .stname:hover { border-color: var(--line); }
  .orditem .stname:focus { outline: 2px solid var(--accent); outline-offset: -1px; background: var(--head); }
  .orditem .stflag {
    display: flex; align-items: center; gap: 3px; flex: 0 0 auto;
    font-size: 11px; color: var(--sub); cursor: pointer;
  }
  .orditem .stflag input { width: 14px; height: 14px; margin: 0; cursor: pointer; }
  .orditem .strole {
    flex: 0 0 auto; font-size: 10px; padding: 1px 6px; border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); white-space: nowrap;
  }

  /* ---------- 🕐 跟进提醒 ---------- */
  /* 状态格里那排小标记（🕐 / ✨），跟在下拉框下面 */
  .stmarks { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 3px; font-size: 11px; }
  .stmarks .fu {
    cursor: pointer; border: 0; background: transparent; padding: 0; font: inherit; font-size: 11px;
    color: var(--sub);
  }
  .stmarks .fu.due { color: #d93025; font-weight: 700; }
  .stmarks .stars { letter-spacing: -1px; }

  /* 到期提示：铺满整个视口，只有「取消」能关掉 */
  .fumask {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(12,10,0,.86); display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .fumask[hidden] { display: none; }
  .fudlg {
    width: min(680px, 100%); max-height: calc(100vh - 48px); overflow: auto;
    background: #fff8d6; color: #3d3200; border: 3px solid #eab308; border-radius: 16px;
    box-shadow: 0 12px 48px rgba(0,0,0,.5); padding: 26px 28px; text-align: center;
  }
  .futitle { font-size: 24px; font-weight: 900; line-height: 1.4; margin-bottom: 16px; }
  .fulist { display: grid; gap: 9px; text-align: left; }
  .fuitem {
    background: rgba(255,255,255,.75); border: 1px solid #e6c200; border-radius: 10px;
    padding: 10px 13px; font-size: 14px; line-height: 1.6;
  }
  .fuitem .fujob { font-weight: 800; color: #7a4b00; text-decoration: none; }
  .fuitem .fujob:hover { text-decoration: underline; }
  .fuitem .fumeta { font-size: 12px; color: #6b5a00; margin-top: 2px; }
  .fuitem .funote { font-size: 13px; margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
  .furow { display: flex; justify-content: center; margin-top: 20px; }
  .fubtn {
    font: inherit; font-size: 15px; font-weight: 800; padding: 11px 40px; border-radius: 10px;
    border: 0; background: #eab308; color: #2a2300; cursor: pointer;
  }
  .fubtn:hover { filter: brightness(1.06); }
  .dlg input[type=date] {
    width: 100%; font: inherit; font-size: 13px; padding: 7px 9px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--head); color: var(--fg);
  }
  `;

  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  /**
   * 元素构造器。
   * LinkedIn 的 CSP 带 require-trusted-types-for 'script'，对 innerHTML 赋值会直接抛
   * TypeError（连 shadow root 内部和 DOMParser 也一样），所以全部 DOM 都用
   * createElement + textContent 构建，不碰任何 HTML 字符串接收点。
   */
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'data') { for (const d in v) n.dataset[d] = v[d]; }
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else if (v === true) n.setAttribute(k, '');
        else n.setAttribute(k, v);
      }
    }
    if (kids != null) {
      [].concat(kids).forEach((c) => {
        if (c == null || c === false) return;
        n.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
      });
    }
    return n;
  }

  const COLS = [
    ['c-pr', '重要度'],
    ['c-st', '状态'], ['c-op', '操作'], ['c-me', 'MEMO'], ['c-sc', '人事主动 scout 的'],
    ['c-ts', '投递时间'], ['c-co', '公司名'], ['c-ti', '岗位名'], ['c-hr', 'Hiring team'],
    ['c-te', '中位任职'],
    ['c-ep', 'EP 所属行业'], ['c-eb', '最低月 base'], ['c-ea', '年总所需'],
  ];

  const $tbody = el('tbody');
  const $cnt   = el('em', { class: 'cnt', text: '(0)' });
  const $empty = el('div', {
    class: 'empty', hidden: true,
    text: '还没有记录。在职位详情页点击左上角的「已递交投递」即可添加。',
  });

  const $applyBt = el('button', { class: 'apply', type: 'button', text: '已递交投递' });
  const $toggle  = el('button', {
    class: 'toggle ghost', type: 'button',
    title: '显示 / 隐藏「已递交清单」', text: '📋 清单',
  });
  const $syncBt = el('button', {
    class: 'toggle ghost', type: 'button',
    title: '保存并立即同步到 GitHub', text: '☁ 同步',
  });
  const $boardBt = el('button', {
    class: 'toggle ghost', type: 'button',
    title: '通知板：追加 / 编辑给看板的留言', text: '💬 留言',
  });
  const $pushBt = el('button', {
    class: 'toggle ghost', type: 'button',
    title: '直接给 Telegram 群发一条文字消息', text: '✉ 发消息',
  });

  const $otherBt = el('button', {
    class: 'toggle ghost', type: 'button',
    title: '把这个会话移到 Other 并推送 Telegram', text: '📥 Move to Other',
  });
  const $archiveBt = el('button', {
    class: 'toggle ghost', type: 'button',
    title: '归档这个会话并推送 Telegram', text: '🗄 Archive',
  });

  const $bar = el('div', { class: 'bar' }, [
    el('div', { class: 'grip', title: '拖拽移动' }),
    $applyBt,
    $toggle,
    $syncBt,
    $boardBt,
    $pushBt,
    $otherBt,
    $archiveBt,
  ]);

  const $ghBtn = el('button', { class: 'gh', type: 'button', text: '☁ GitHub' });

  /* ---------- 🔍 按公司名快速定位到清单里的那几行 ---------- */
  const $search = el('input', {
    type: 'text', class: 'srch', placeholder: '🔍 公司名 / 岗位名…', spellcheck: 'false',
    autocomplete: 'off', title: '输入公司名或岗位名，从提示里选一条，清单会滚到对应的行',
  });
  const $sugg = el('div', { class: 'sugg', hidden: true });
  const $searchBox = el('div', { class: 'srchbox' }, [$search, $sugg]);

  const $hdr = el('div', { class: 'hdr' }, [
    el('span', { class: 'ttl' }, ['已递交清单 ', $cnt]),
    $searchBox,
    $ghBtn,
    el('button', { class: 'act', type: 'button', data: { act: 'order'  }, text: '⚙ 状态管理' }),
    el('button', { class: 'act', type: 'button', data: { act: 'hidden' }, text: '🙈 已隐藏' }),
    el('button', { class: 'act', type: 'button', data: { act: 'sector' }, text: '🤖 行业',
                   title: '用 Claude 补全空白的「EP 所属行业」' }),
    el('button', { class: 'act', type: 'button', data: { act: 'csv'    }, text: '导出 CSV'  }),
    el('button', { class: 'act', type: 'button', data: { act: 'json'   }, text: '导出 JSON' }),
    el('button', { class: 'act', type: 'button', data: { act: 'import' }, text: '导入'      }),
    el('button', { class: 'act', type: 'button', data: { act: 'hide'   }, text: '隐藏 ✕'    }),
  ]);

  const $rz = el('div', { class: 'rz', title: '拖拽调整大小' });

  const $panel = el('div', { class: 'panel' }, [
    $hdr,
    el('div', { class: 'body' }, [
      el('table', null, [
        el('thead', null, [
          el('tr', null, COLS.map(([cls, label]) => el('th', { class: cls, text: label }))),
        ]),
        $tbody,
      ]),
      $empty,
    ]),
    $rz,
  ]);

  /* ---------- 右上角快捷入口（跟着当前站点走） ---------- */
  const $nav = el('div', { class: 'navbar' }, IS_JS
    ? [
      el('a', { class: 'navbtn', href: JS_ORIGIN + '/jobs', text: '🔎 Jobstreet 筛工作' }),
      el('a', { class: 'navbtn', href: JS_ORIGIN + '/my-activity/saved-jobs', text: '🔖 Job Saved list' }),
      el('a', { class: 'navbtn', href: JS_ORIGIN + '/my-activity/applied-jobs', text: '📨 Applied jobs' }),
    ]
    : [
      el('a', { class: 'navbtn', href: 'https://www.linkedin.com/jobs/', text: '🔎 Linkedin 筛工作' }),
      el('a', { class: 'navbtn', href: 'https://www.linkedin.com/jobs-tracker/', text: '🔖 Job Saved list' }),
    ]);

  /* ---------- 右下角：公司数据 ---------- */
  const $stEmp    = el('b');
  const $stTenure = el('b');
  const $stRowEmp = el('div', { class: 'strow' }, [el('span', { text: '总员工数' }), $stEmp]);
  const $stRowTen = el('div', { class: 'strow' }, [el('span', { text: '中位任职' }), $stTenure]);
  const $stMatch  = el('b', { class: 'match' });
  const $stRowMat = el('div', { class: 'strow' }, [el('span', { text: 'Job match' }), $stMatch]);
  const $stYears  = el('b');
  const $stRowYr  = el('div', { class: 'strow' }, [el('span', { text: '要求年限' }), $stYears]);
  // 下面两项只有 Jobstreet 有
  const $stBadge  = el('b', { class: 'match' });
  const $stRowBdg = el('div', { class: 'strow' }, [el('span', { text: '竞争力' }), $stBadge]);
  const $stSalary = el('b');
  const $stRowSal = el('div', { class: 'strow' }, [el('span', { text: '薪资' }), $stSalary]);
  const $stats = el('div', { class: 'stats', hidden: true }, [
    el('div', { class: 'sthdr', title: '拖拽移动' }, [el('span', { text: '📊 公司数据' })]),
    $stRowMat,
    $stRowBdg,
    $stRowSal,
    $stRowYr,
    $stRowEmp,
    $stRowTen,
  ]);

  /* ---------- 同公司已投过的提醒 ---------- */
  const $coTitle = el('div', { class: 'cotitle' });
  const $coList  = el('div', { class: 'colist' });
  const $coRjHead= el('div', { class: 'rjhead' });
  const $coRjList= el('div');
  const $coReject= el('div', { class: 'coreject', hidden: true }, [$coRjHead, $coRjList]);
  const $coOk    = el('button', { class: 'cook', type: 'button', text: '收起' });
  const $coMask  = el('div', { class: 'mask comask', hidden: true }, [
    el('div', { class: 'codlg' }, [
      el('div', { class: 'cohead' }, ['⚠️ 该公司已投过岗位']),
      $coTitle,
      // 红框放在列表之前：横幅有高度上限、内容要滚动，
      // 「这家挂过你」比「这家投过」更值得先看到，不能让它落到折叠线以下
      $coReject,
      $coList,
      el('div', { class: 'corow' }, [$coOk]),
    ]),
  ]);

  /* ---------- 同步成功提示（顶部） ---------- */
  const $syncBanner = el('div', { class: 'syncbanner', hidden: true });

  const $toast = el('div', { class: 'toast' });

  /* ---------- GitHub 同步设置弹窗 ---------- */
  const $ghRepo   = el('input', { type: 'text', placeholder: 'owner/repo', spellcheck: 'false' });
  const $ghBranch = el('input', { type: 'text', placeholder: 'main', spellcheck: 'false' });
  const $ghPath   = el('input', { type: 'text', placeholder: 'data/records.json', spellcheck: 'false' });
  const $ghToken  = el('input', { type: 'password', placeholder: 'github_pat_…', spellcheck: 'false' });
  const $ghTg     = el('input', { type: 'text', placeholder: 'https://….workers.dev', spellcheck: 'false' });
  const $ghBoard  = el('input', { type: 'text', placeholder: 'https://….github.io/…/', spellcheck: 'false' });
  const $ghBirth  = el('input', { type: 'date' });
  const $ghAuto   = el('input', { type: 'checkbox' });
  const $ghAiEp   = el('input', { type: 'text', placeholder: 'https://….workers.dev（留空则用下面的 Key 直连）', spellcheck: 'false' });
  const $ghAiKey  = el('input', { type: 'password', placeholder: 'sk-ant-…', spellcheck: 'false' });
  const $ghAiMdl  = el('input', { type: 'text', placeholder: 'claude-opus-5', spellcheck: 'false' });
  const $ghAiAuto = el('input', { type: 'checkbox' });
  const $ghAiFill = el('button', { type: 'button', text: '🤖 立即补全空白行业' });
  const $ghStatus = el('div', { class: 'status' });

  const $ghSave   = el('button', { class: 'primary', type: 'button', text: '保存并立即同步' });
  const $ghSaveOnly = el('button', { type: 'button', text: '仅保存' });
  const $ghClear  = el('button', { type: 'button', text: '清除 Token' });
  const $ghClose  = el('button', { class: 'sp', type: 'button', text: '关闭' });

  const $dlg = el('div', { class: 'dlg' }, [
    el('h3', { text: '☁ GitHub 同步设置' }),
    el('div', {
      class: 'desc',
      text: '把清单推送到仓库的 JSON 文件，由 GitHub Actions 构建成公开看板。'
          + 'Token 只保存在本机油猴存储里，不会发往 GitHub 以外的任何地方。',
    }),

    el('label', { text: '仓库' }), $ghRepo,
    el('div', { class: 'tip', text: '格式：owner/repo，例如 yourname/job-tracker' }),

    el('label', { text: '分支' }), $ghBranch,
    el('label', { text: '文件路径' }), $ghPath,

    el('label', { text: '出生年月日' }), $ghBirth,
    el('div', { class: 'tip', text: 'EP 所属行业选定后，按当前年龄自动算出 C1 所需的最低月 base 与年总所需。' }),

    el('label', { text: '看板地址（index.html）' }), $ghBoard,
    el('div', { class: 'tip', text: '用于「附上看板链接」，点开会定位并高亮对应的那一条。' }),

    el('label', { text: 'Telegram 中继地址（Cloudflare Worker）' }), $ghTg,
    el('div', {
      class: 'tip',
      text: '部署 linkedin-tracker-site/worker 后 wrangler 输出的 URL。留空则「✈ 通知全部」不可用。'
          + 'Bot Token 保存在 Worker 的 Secret 里，不会经过浏览器。',
    }),

    el('label', { text: 'Personal Access Token' }), $ghToken,
    el('div', {
      class: 'tip',
      text: 'GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens；'
          + 'Repository access 只选这一个仓库，Permissions 里把 Contents 设为 Read and write 即可。',
    }),

    el('label', { class: 'chk' }, [$ghAuto, el('span', { text: '记录变化后自动推送（延迟 5 秒合并提交）' })]),

    el('h3', { text: '🤖 EP 行业自动判定（Claude）' }),
    el('div', {
      class: 'desc',
      text: '按公司名判断它属于 COMPASS C1 的哪个行业，填进「EP 所属行业」。'
          + '填上的会标 🤖，你在下拉框里改过的会被记住，之后同一家公司不再由模型判定。'
          + '判定结果只是预填，报 EP 之前请自行核对。',
    }),

    el('label', { text: 'Claude 中继地址（同一个 Worker）' }), $ghAiEp,
    el('div', {
      class: 'tip',
      text: '推荐：把 ANTHROPIC_API_KEY 放在 Worker 的 Secret 里，浏览器这边不存任何密钥。'
          + '地址和上面的 Telegram 中继是同一个。',
    }),

    el('label', { text: 'Anthropic API Key（没配中继时才需要）' }), $ghAiKey,
    el('div', {
      class: 'tip',
      text: '只存在本机的油猴存储里，不写进页面 localStorage。'
          + '注意：直连意味着密钥在浏览器里，能配中继就别用这条路。',
    }),

    el('label', { text: '模型' }), $ghAiMdl,
    el('div', { class: 'tip', text: '默认 claude-opus-5。判一次几百 token，很便宜。' }),

    el('label', { class: 'chk' }, [$ghAiAuto, el('span', { text: '新记录入库时自动判定行业' })]),
    el('div', { class: 'row' }, [$ghAiFill]),

    $ghStatus,
    el('div', { class: 'row' }, [$ghSave, $ghSaveOnly, $ghClear, $ghClose]),
  ]);

  const $mask = el('div', { class: 'mask', hidden: true }, [$dlg]);

  /* ---------- 通知板（写给看板的留言） ---------- */
  const $msgTplBar = el('div', { class: 'tplbar' });
  const $msgInput = el('textarea', { class: 'minput', placeholder: '写给看板通知板的内容…' });
  const $msgAdd   = el('button', { class: 'primary', type: 'button', text: '追加留言' });
  // 追加完顺手把这条的直达链接放进剪贴板，转发给别人时不用再回来点 🔗
  const $msgAutoLink = el('input', { type: 'checkbox' });
  $msgAutoLink.checked = store.get(K_MAL, true) !== false;
  $msgAutoLink.addEventListener('change', () => store.set(K_MAL, $msgAutoLink.checked));
  const $msgClose = el('button', { class: 'sp', type: 'button', text: '关闭' });
  const $msgCount = el('em', { class: 'cnt', text: '(0)' });
  const $msgList  = el('div', { class: 'mlist' });

  const $msgMask = el('div', { class: 'mask', hidden: true }, [
    el('div', { class: 'dlg wide' }, [
      el('h3', {}, ['💬 通知板 ', $msgCount]),
      el('div', {
        class: 'desc',
        text: '这里写的留言会随投递记录一起推送到仓库，出现在看板页面的通知板里；'
            + '看板上有未读时会显示小红点。留言随时可以回来编辑。',
      }),
      $msgTplBar,
      $msgInput,
      el('div', { class: 'row' }, [
        $msgAdd,
        el('label', { class: 'chk inline' }, [$msgAutoLink, el('span', { text: '自动复制新增留言的链接' })]),
        $msgClose,
      ]),
      $msgList,
    ]),
  ]);

  /* ---------- 通用确认弹窗 ---------- */
  const $cfTitle = el('h3');
  const $cfBody  = el('div', { class: 'body-text' });
  const $cfOk    = el('button', { class: 'primary', type: 'button', text: '确定' });
  const $cfNo    = el('button', { class: 'sp', type: 'button', text: '取消' });
  const $cfMask  = el('div', { class: 'mask', hidden: true }, [
    el('div', { class: 'dlg' }, [$cfTitle, $cfBody, el('div', { class: 'row' }, [$cfOk, $cfNo])]),
  ]);

  /* ---------- 点击 Apply 后的非阻塞提示 ---------- */
  const $askDesc = el('div', { class: 'd' });
  const $askYes  = el('button', { class: 'primary', type: 'button', text: '加入清单' });
  const $askNo   = el('button', { class: 'sp', type: 'button', text: '不用了' });
  const $ask = el('div', { class: 'ask', hidden: true }, [
    el('div', { class: 't', text: '要把这个职位加入「已递交清单」吗？' }),
    $askDesc,
    el('div', { class: 'row' }, [$askYes, $askNo]),
  ]);

  /* ---------- 📢 请求更新状态 ---------- */
  const $rmWho = el('select', {}, [
    el('option', { value: 'XR ball', selected: true, text: 'XR ball' }),
    el('option', { value: '己 ball', text: '己 ball' }),
    el('option', { value: '通知', text: '通知' }),
  ]);
  const $rmPriority = el('select', {}, ['紧急', '高', '中（下班后处理 OK）', '低（下班后处理 OK）', '无'].map(
    (v) => el('option', { value: v, selected: v === '无', text: v })));
  const $rmNewStatus = el('select', {});
  const $rmTplBar = el('div', { class: 'tplbar' });
  const $rmMemo   = el('textarea', { class: 'minput', placeholder: '想让对方知道的事…' });
  const $rmAppend = el('input', { type: 'checkbox' });
  const $rmReplace= el('input', { type: 'checkbox' });
  const $rmWith   = el('input', { type: 'checkbox' });
  const $rmLink   = el('input', { type: 'checkbox' });
  const $rmInfo   = el('div', { class: 'rminfo' });
  const $rmCount  = el('span', { class: 'cnum' });
  const $rmHint   = el('div', { class: 'rmhint' });
  const $rmState  = el('div', { class: 'status' });
  const $rmSend   = el('button', { class: 'primary', type: 'button', text: '发送到 Telegram' });
  const $rmCancel = el('button', { class: 'sp', type: 'button', text: '取消' });

  const $rmMask = el('div', { class: 'mask', hidden: true }, [
    el('div', { class: 'dlg wide' }, [
      el('h3', { text: '📢 请求更新状态' }),
      el('div', { class: 'desc', text: '提醒内容会连同这条投递的基本信息一起发到 Telegram 群。' }),

      el('label', { text: '谁需要处理这个提醒？' }), $rmWho,

      el('label', { text: '优先级' }), $rmPriority,
      el('div', { class: 'tip', text: '选「无」则不在 Telegram 消息里附上这一行。' }),

      el('label', { text: '把这条的状态改为' }), $rmNewStatus,
      el('div', { class: 'tip', text: '不改就保持原样；改了会在发送成功后写回清单。' }),

      el('label', { text: '备注' }),
      $rmTplBar,
      $rmMemo,

      el('label', { class: 'chk' }, [$rmAppend,  el('span', { text: '把上面的内容追加到这条的 MEMO' })]),
      el('label', { class: 'chk' }, [$rmReplace, el('span', { text: '用上面的内容替换掉这条的 MEMO' })]),
      el('label', { class: 'chk' }, [$rmWith,    el('span', { text: '附上 MEMO 里已有的内容一并发送' })]),
      el('label', { class: 'chk' }, [$rmLink,    el('span', { text: '附上看板链接（点开直接定位并高亮这一条）' })]),

      el('div', { class: 'previewhdr' }, [
        el('span', { text: '预览 —— 实际发送的内容' }),
        $rmCount,
      ]),
      $rmInfo,
      $rmHint,
      $rmState,
      el('div', { class: 'row' }, [$rmSend, $rmCancel]),
    ]),
  ]);

  /* ---------- ✉ 直接发消息 ---------- */
  const $pshTplBar = el('div', { class: 'tplbar' });
  const $pshText   = el('textarea', { class: 'minput', placeholder: '想发到群里的话…' });
  const $pshCount  = el('span', { class: 'cnum' });
  const $pshInfo   = el('div', { class: 'rminfo' });
  const $pshState  = el('div', { class: 'status' });
  const $pshSend   = el('button', { class: 'primary', type: 'button', text: '发送到 Telegram' });
  const $pshCancel = el('button', { class: 'sp', type: 'button', text: '取消' });

  const $pshMask = el('div', { class: 'mask', hidden: true }, [
    el('div', { class: 'dlg wide' }, [
      el('h3', { text: '✉ 发消息到 Telegram 群' }),
      el('div', { class: 'desc', text: '只发这段文字，不附带任何投递记录。' }),
      $pshTplBar,
      $pshText,
      el('div', { class: 'previewhdr' }, [el('span', { text: '预览 —— 实际发送的内容' }), $pshCount]),
      $pshInfo,
      $pshState,
      el('div', { class: 'row' }, [$pshSend, $pshCancel]),
    ]),
  ]);

  /* ---------- 🙈 被「✕ 不看」隐藏掉的职位 ---------- */
  const $hidTitle = el('h3', { text: '🙈 已隐藏的职位' });
  const $hidList  = el('div', { class: 'tpllist' });
  const $hidAll   = el('button', { type: 'button', text: '全部恢复' });
  const $hidClose = el('button', { class: 'primary sp', type: 'button', text: '完成' });

  const $hidMask = el('div', { class: 'mask', hidden: true }, [
    el('div', { class: 'dlg wide' }, [
      $hidTitle,
      el('div', {
        class: 'desc',
        text: '在搜索结果里点过卡片上「✕」的职位会被藏起来，之后的搜索结果里也不再出现。'
            + '在这里可以单条或全部恢复。只存在本机。',
      }),
      $hidList,
      el('div', { class: 'row' }, [$hidAll, $hidClose]),
    ]),
  ]);

  /* ---------- ⚙ 状态管理（改名 / 新增 / 删除 / 排序） ---------- */
  const $ordList  = el('div', { class: 'ordlist' });
  const $ordAdd   = el('button', { type: 'button', text: '＋ 新增状态' });
  const $ordReset = el('button', { type: 'button', text: '恢复默认' });
  const $ordClose = el('button', { class: 'primary sp', type: 'button', text: '完成' });

  const $ordMask = el('div', { class: 'mask', hidden: true }, [
    el('div', { class: 'dlg wide' }, [
      el('h3', { text: '⚙ 状态管理' }),
      el('div', {
        class: 'desc',
        text: '拖 ⠿ 调整顺序，直接在名字上改名，也可以新增或删除状态。'
            + '清单和看板都按这个顺序排列，状态下拉框的选项顺序也跟着变；同步后看板一致。'
            + '勾「落」表示这条算已落选（清单里划掉置灰）。改名会自动把用到旧名字的记录一起改掉。',
      }),
      $ordList,
      el('div', { class: 'row' }, [$ordAdd, $ordReset, $ordClose]),
    ]),
  ]);

  /** 名字在清单里已经被别的状态占了？（改名 / 新增时查重） */
  function statusNameTaken(name, exceptId) {
    return statusDefs().some((s) => s.name === name && s.id !== exceptId);
  }

  /** 用了这个状态名的记录条数 */
  function statusUseCount(name) {
    return records.filter((r) => r && r.status === name).length;
  }

  /**
   * 改名：清单里换名字，同时把所有用旧名字的记录改过来，并记一条别名。
   * 别名是给「以后又从别处导入 / 同步回来的老数据」兜底的。
   */
  function renameStatus(def, next) {
    const prev = def.name;
    if (!next || next === prev) return 0;
    def.name = next;
    statusAlias[prev] = next;
    // 旧别名链要跟着往前指，别停在中间那个已经不存在的名字上
    Object.keys(statusAlias).forEach((k) => { if (statusAlias[k] === prev) statusAlias[k] = next; });
    delete statusAlias[next];       // 新名字本身不该再是别名的起点
    let n = 0;
    records.forEach((r) => { if (r && r.status === prev) { r.status = next; n++; } });
    saveStatuses();
    if (n) saveRecords(); else store.set(K_REC, records);
    return n;
  }

  function renderOrderList() {
    $ordList.textContent = '';
    const list = statusDefs();
    list.forEach((def, idx) => {
      const item = el('div', { class: 'orditem' });
      item.draggable = true;
      item.dataset.id = def.id;
      item.appendChild(el('span', { class: 'no', text: String(idx + 1) }));
      item.appendChild(el('span', { class: 'grip', title: '拖动调整顺序', text: '⠿' }));

      // 名字可编辑。输入框在拖拽区里，所以聚焦时要把 draggable 关掉，否则选不了字
      const nameBox = el('input', { type: 'text', class: 'stname', value: def.name });
      nameBox.value = def.name;
      nameBox.addEventListener('focus', () => { item.draggable = false; });
      nameBox.addEventListener('blur', () => {
        item.draggable = true;
        const next = nameBox.value.trim();
        if (!next) { nameBox.value = def.name; toast('状态名不能为空'); return; }
        if (next === def.name) return;
        if (statusNameTaken(next, def.id)) {
          nameBox.value = def.name;
          toast('已经有叫「' + next + '」的状态了');
          return;
        }
        const n = renameStatus(def, next);
        renderOrderList();
        render();
        toast(n ? ('已改名，并更新了 ' + n + ' 条记录') : '已改名');
      });
      nameBox.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') nameBox.blur();
        else if (e.key === 'Escape') { nameBox.value = def.name; nameBox.blur(); }
      });
      item.appendChild(nameBox);

      // 「算不算已落选」跟着这一条走，改名之后划线/置灰的行为不会丢
      const closed = el('input', { type: 'checkbox', class: 'stclosed', title: '算作已落选（清单里划掉置灰）' });
      closed.checked = !!def.closed;
      closed.addEventListener('mousedown', (e) => e.stopPropagation());
      closed.addEventListener('change', () => {
        def.closed = closed.checked;
        if (!def.closed) def.rejected = false;
        saveStatuses();
        render();
      });
      item.appendChild(el('label', { class: 'stflag', title: '算作已落选（清单里划掉置灰）' },
        [closed, el('span', { text: '落' })]));

      // 角色标记：这两条被别处的逻辑按角色引用，删掉会关掉对应的自动行为
      if (def.role === 'default') {
        item.appendChild(el('span', { class: 'strole', title: '新记录的初始状态', text: '默认' }));
      } else if (def.role === 'nonews') {
        item.appendChild(el('span', { class: 'strole', title: '超 ' + NO_NEWS_DAYS + ' 天无响应时自动落到这里', text: '超时' }));
      }

      const del = el('button', { class: 'op-btn', type: 'button', title: '删除这个状态', text: '🗑' });
      del.addEventListener('click', () => {
        if (statusDefs().length <= 1) { toast('至少要留一个状态'); return; }
        const used = statusUseCount(def.name);
        if (used) {
          toast('还有 ' + used + ' 条记录在用「' + def.name + '」，先改掉它们再删');
          return;
        }
        confirmDialog({
          title: '删除状态「' + def.name + '」？',
          body: def.role === 'default'
            ? '这是新记录的初始状态，删掉之后新记录会用清单里的第一条。'
            : (def.role === 'nonews'
              ? '这是「超 ' + NO_NEWS_DAYS + ' 天无响应」自动落到的状态，删掉之后这个自动判定就不生效了。'
              : '没有记录在用它，可以安全删除。'),
          okText: '删除', danger: true,
        }).then((ok) => {
          if (!ok) return;
          statuses = statusDefs().filter((s) => s.id !== def.id);
          saveStatuses();
          renderOrderList();
          render();
          toast('已删除「' + def.name + '」');
        });
      });
      item.appendChild(del);

      item.addEventListener('dragstart', (e) => {
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', def.id);
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        [].forEach.call($ordList.children, (n) => n.classList.remove('over'));
      });
      item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('over'); });
      item.addEventListener('dragleave', () => item.classList.remove('over'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('over');
        const fromId = e.dataTransfer.getData('text/plain');
        if (!fromId || fromId === def.id) return;
        const cur = statusDefs();
        const moving = cur.filter((s) => s.id === fromId)[0];
        if (!moving) return;
        const next = cur.filter((s) => s.id !== fromId);
        next.splice(next.map((s) => s.id).indexOf(def.id), 0, moving);
        statuses = next;
        saveStatuses();
        renderOrderList();
        render();                 // 清单立刻按新顺序重排
      });

      $ordList.appendChild(item);
    });
  }

  function openOrderDialog() {
    renderOrderList();
    $ordMask.hidden = false;
  }

  $ordAdd.addEventListener('click', () => {
    let base = '新状态';
    let name = base;
    for (let i = 2; statusNameTaken(name, null); i++) name = base + i;
    statuses = statusDefs().concat([{ id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name }]);
    saveStatuses();
    renderOrderList();
    render();
    // 新增完直接选中名字，接着打字就是改名
    const boxes = $ordList.querySelectorAll('.stname');
    if (boxes.length) { const b = boxes[boxes.length - 1]; b.focus(); b.select(); }
  });

  $ordReset.addEventListener('click', () => {
    confirmDialog({
      title: '恢复默认状态清单？',
      body: '会回到脚本内置的 ' + BUILTIN_STATUSES.length + ' 条状态与顺序。\n'
          + '你自己新增的状态会消失，改过的名字会变回内置写法 —— '
          + '但记录里已经写着的状态值不会被动，可能因此掉出下拉框。',
      okText: '恢复', danger: true,
    }).then((ok) => {
      if (!ok) return;
      statuses = BUILTIN_STATUSES.map((s) => Object.assign({}, s));
      saveStatuses();
      renderOrderList();
      render();
    });
  });
  $ordClose.addEventListener('click', () => {
    $ordMask.hidden = true;
    saveRecords();               // 顺序变了就推一次，让看板跟上
  });
  $ordMask.addEventListener('click', (e) => {
    if (e.target === $ordMask) { $ordMask.hidden = true; saveRecords(); }
  });

  function renderHiddenList() {
    const keys = Object.keys(hiddenJobs);
    $hidTitle.textContent = '🙈 已隐藏的职位（' + keys.length + '）';
    $hidAll.hidden = !keys.length;
    $hidList.textContent = '';

    if (!keys.length) {
      $hidList.appendChild(el('div', { class: 'mempty', text: '还没有隐藏任何职位。' }));
      return;
    }

    keys.sort((a, b) => (hiddenJobs[b].ts || 0) - (hiddenJobs[a].ts || 0)).forEach((key) => {
      const it = hiddenJobs[key] || {};
      const back = el('button', { class: 'op-btn', type: 'button', title: '恢复显示', text: '↩' });
      back.addEventListener('click', () => { unhideJob(key); renderHiddenList(); });

      const label = (it.title || '(无标题)') + (it.company ? ('　—　' + it.company) : '');
      const name = it.url
        ? el('a', { href: it.url, target: '_blank', rel: 'noopener', text: label })
        : el('span', { text: label });

      $hidList.appendChild(el('div', { class: 'tplitem' }, [
        el('div', { class: 'tplrow' }, [name, back]),
      ]));
    });
  }

  function openHiddenDialog() {
    renderHiddenList();
    $hidMask.hidden = false;
  }

  $hidAll.addEventListener('click', () => {
    const n = Object.keys(hiddenJobs).length;
    confirmDialog({
      title: '恢复全部隐藏的职位？',
      body: '共 ' + n + ' 条，恢复后它们会重新出现在搜索结果里。',
      okText: '全部恢复',
    }).then((ok) => {
      if (!ok) return;
      hiddenJobs = {};
      saveHiddenJobs();
      renderHiddenList();
      unhideAllCards();
      toast('已恢复 ' + n + ' 条');
    });
  });
  $hidClose.addEventListener('click', () => { $hidMask.hidden = true; });
  $hidMask.addEventListener('click', (e) => { if (e.target === $hidMask) $hidMask.hidden = true; });

  /* ---------- 🗂 备注模板管理 ---------- */
  const $tplTitle = el('h3');
  const $tplHint  = el('div', { class: 'desc' });
  const $tplList  = el('div', { class: 'tpllist' });
  const $tplAdd   = el('button', { type: 'button', text: '＋ 新增一条' });
  const $tplReset = el('button', { type: 'button', text: '恢复默认' });
  const $tplClose = el('button', { class: 'primary sp', type: 'button', text: '完成' });

  const $tplMask = el('div', { class: 'mask', hidden: true }, [
    el('div', { class: 'dlg wide' }, [
      $tplTitle,
      $tplHint,
      $tplList,
      el('div', { class: 'row' }, [$tplAdd, $tplReset, $tplClose]),
    ]),
  ]);

  /* ---------- 📝 MEMO 编辑 ---------- */
  const $meText  = el('textarea', { class: 'minput grow', placeholder: '写一条新的…（不会覆盖以前的，按时间往上叠）' });
  const $mePush  = el('input', { type: 'checkbox' });
  const $meInfo  = el('div', { class: 'rminfo' });
  const $meLog   = el('div', { class: 'memolog' });
  const $meState = el('div', { class: 'status' });
  const $meSave  = el('button', { class: 'primary', type: 'button', text: '追加这一条' });
  const $meCancel= el('button', { class: 'sp', type: 'button', text: '取消' });

  const $meMask = el('div', { class: 'mask', hidden: true }, [
    el('div', { class: 'dlg wide' }, [
      el('h3', { text: '📝 MEMO' }),
      $meInfo,
      $meText,
      $meLog,
      el('label', { class: 'chk' }, [$mePush, el('span', { text: '保存后把这条 MEMO 推送到 Telegram' })]),
      $meState,
      el('div', { class: 'row' }, [$meSave, $meCancel]),
    ]),
  ]);

  /* ---------- 🕐 跟进提醒 ---------- */
  const $fuInfo  = el('div', { class: 'rminfo' });
  const $fuDate  = el('input', { type: 'date' });
  const $fuNote  = el('textarea', { class: 'minput', placeholder: '到时候要做什么（可留空）…' });
  const $fuQuick = el('div', { class: 'tplbar' });
  const $fuState = el('div', { class: 'status' });
  const $fuSave  = el('button', { class: 'primary', type: 'button', text: '保存提醒' });
  const $fuClear = el('button', { type: 'button', text: '清除提醒' });
  const $fuCancel= el('button', { class: 'sp', type: 'button', text: '取消' });

  const $fuMask = el('div', { class: 'mask', hidden: true }, [
    el('div', { class: 'dlg' }, [
      el('h3', { text: '🕐 设置跟进提醒' }),
      el('div', {
        class: 'desc',
        text: '到了这一天，打开 LinkedIn 或看板时会弹一个必须手动关掉的全屏提示，'
            + '并尝试发一条 Chrome 通知。清单里这一条的状态下方会显示 🕐。',
      }),
      $fuInfo,
      el('label', { text: '提醒日期' }),
      $fuQuick,
      $fuDate,
      el('label', { text: '备注' }), $fuNote,
      $fuState,
      el('div', { class: 'row' }, [$fuSave, $fuClear, $fuCancel]),
    ]),
  ]);

  /* ---------- 🕐 到期后的全屏提示（只有「取消」能关掉） ---------- */
  const $fuAlertList = el('div', { class: 'fulist' });
  const $fuAlertOk   = el('button', { class: 'fubtn', type: 'button', text: '取消' });
  const $fuAlert = el('div', { class: 'fumask', hidden: true }, [
    el('div', { class: 'fudlg' }, [
      el('div', { class: 'futitle', text: '🕐 到了该项目的跟进提醒时间了' }),
      $fuAlertList,
      el('div', { class: 'furow' }, [$fuAlertOk]),
    ]),
  ]);

  // 所有 .mask 的 z-index 都顶到了 int 上限，同级之间只能靠 DOM 顺序分先后。
  // $cfMask（通用确认框）常常是从别的弹窗里叫出来的（例如在 MEMO 弹窗里点 🗑），
  // 所以必须排在全部弹窗之后，否则会被叫它的那个弹窗盖住。
  root.appendChild(el('div', null,
    [$bar, $nav, $stats, $syncBanner, $panel, $toast, $mask, $ask, $msgMask, $rmMask, $meMask,
     $tplMask, $ordMask, $pshMask, $coMask, $hidMask, $fuMask, $cfMask, $fuAlert]));

  /* =========================================================================
   * 4. 位置 / 尺寸 / 显隐
   * ========================================================================= */

  function applyBarPos() {
    const w = $bar.offsetWidth || 200;
    const h = $bar.offsetHeight || 44;
    ui.bar.x = Math.min(Math.max(0, ui.bar.x), Math.max(0, window.innerWidth  - Math.min(w, 60)));
    ui.bar.y = Math.min(Math.max(0, ui.bar.y), Math.max(0, window.innerHeight - Math.min(h, 30)));
    $bar.style.left = ui.bar.x + 'px';
    $bar.style.top  = ui.bar.y + 'px';
  }

  function applyPanelBox() {
    const p = ui.panel;
    p.w = Math.max(380, Math.min(p.w, Math.max(380, window.innerWidth  - 8)));
    p.h = Math.max(180, Math.min(p.h, Math.max(180, window.innerHeight - 8)));
    p.x = Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth  - 80));
    p.y = Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - 40));
    $panel.style.left   = p.x + 'px';
    $panel.style.top    = p.y + 'px';
    $panel.style.width  = p.w + 'px';
    $panel.style.height = p.h + 'px';
    $panel.hidden = !!p.hidden;
    $toggle.textContent = p.hidden ? '📋 清单' : '📋 收起';
  }

  function setPanelHidden(hidden) {
    ui.panel.hidden = !!hidden;
    applyPanelBox();
    saveUI();
  }

  /** 通用拖拽：handle 触发，移动 target；返回是否发生过位移由 onClick 判断 */
  function makeDraggable(handle, target, onMove, onEnd) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, active = false;

    const down = (e) => {
      if (e.button !== 0) return;
      const tag = (e.target && e.target.tagName || '').toLowerCase();
      if (['select', 'textarea', 'input', 'option', 'a'].indexOf(tag) !== -1) return;
      const r = target.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      moved = false; active = true;
      handle.classList.add('dragging');
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
      e.preventDefault();
    };
    const move = (e) => {
      if (!active) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      onMove(ox + dx, oy + dy);
    };
    const up = () => {
      if (!active) return;
      active = false;
      handle.classList.remove('dragging');
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      if (moved) onEnd();
      // 让 click 事件知道刚刚是拖拽而非点击
      handle.dataset.dragged = moved ? '1' : '';
      setTimeout(() => { handle.dataset.dragged = ''; }, 0);
    };

    handle.addEventListener('mousedown', down);
  }

  makeDraggable($bar, $bar,
    (x, y) => { ui.bar.x = x; ui.bar.y = y; applyBarPos(); },
    () => saveUI());

  makeDraggable($hdr, $panel,
    (x, y) => { ui.panel.x = x; ui.panel.y = y; applyPanelBox(); },
    () => saveUI());

  makeDraggable($stats.querySelector('.sthdr'), $stats,
    (x, y) => { ui.stats.x = x; ui.stats.y = y; ui.stats.placed = true; applyStatsPos(); },
    () => saveUI());

  // 面板缩放
  (function () {
    let sx = 0, sy = 0, sw = 0, sh = 0, active = false;
    const move = (e) => {
      if (!active) return;
      ui.panel.w = Math.max(380, sw + (e.clientX - sx));
      ui.panel.h = Math.max(180, sh + (e.clientY - sy));
      applyPanelBox();
    };
    const up = () => {
      if (!active) return;
      active = false;
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      saveUI();
    };
    $rz.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const r = $panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height; active = true;
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
      e.preventDefault(); e.stopPropagation();
    });
  })();

  function applyStatsPos() {
    const st = ui.stats;
    const w = $stats.offsetWidth || 180;
    const h = $stats.offsetHeight || 88;
    if (!st.placed) {
      // 默认贴右下，但避开 LinkedIn 自己的消息浮窗
      st.x = Math.max(8, window.innerWidth - w - 20);
      st.y = Math.max(8, window.innerHeight - h - 96);
      st.placed = true;
    }
    st.x = Math.min(Math.max(0, st.x), Math.max(0, window.innerWidth - 60));
    st.y = Math.min(Math.max(0, st.y), Math.max(0, window.innerHeight - 30));
    $stats.style.left = st.x + 'px';
    $stats.style.top  = st.y + 'px';
  }

  /** 抓当前职位的公司数据，全都没有就不显示 */
  function refreshStats() {
    if (!isJobPage()) { $stats.hidden = true; return; }
    const emp = getTotalEmployees();
    const ten = getMedianTenure();
    const mat = getJobMatch();
    const yrs = getYearsExperience();
    const bdg = getJsBadge();
    const sal = getSalary();
    if (!emp && !ten && !mat && !yrs && !bdg && !sal) { $stats.hidden = true; return; }

    $stRowBdg.hidden = !bdg;
    $stBadge.textContent = bdg || '—';
    // 「Strong applicant」= 站方判定的高匹配，配色沿用 Job match 的高/中
    $stBadge.className = 'match' + (/strong/i.test(bdg) ? ' lv-high' : (bdg ? ' lv-medium' : ''));
    $stRowSal.hidden = !sal;
    $stSalary.textContent = sal || '—';
    $stRowYr.hidden = !yrs;
    $stYears.textContent = yrs || '—';
    $stRowMat.hidden = !mat;
    $stRowEmp.hidden = !emp;
    $stRowTen.hidden = !ten;
    $stMatch.textContent = mat || '—';
    $stMatch.className = 'match' + (mat ? (' lv-' + mat.toLowerCase()) : '');
    $stEmp.textContent = emp || '—';
    $stTenure.textContent = ten || '—';
    $stats.hidden = false;
    applyStatsPos();
  }

  /**
   * 打开某个职位页时，如果这家公司之前投过别的岗位，居中弹一个醒目提示。
   * 同一个职位只提示一次，关掉后不再反复弹。
   */
  let coAlertShownFor = '';

  function checkCompanyAlert() {
    if (!isJobPage()) { return; }
    const jid = getJobId();
    if (!jid) return;

    const co = getTitleAndCompany().company;
    const key = companyKey(co);
    if (!key || key.length < 2) return;

    // 同公司、但不是当前这条职位的记录
    const hits = records.filter((r) => companyKey(r.company) === key && r.jobId !== jid);
    if (!hits.length) { $coMask.hidden = true; coAlertShownFor = ''; return; }
    if (coAlertShownFor === jid) return;          // 同一职位不重复重建 DOM

    hits.sort((a, b) => b.ts - a.ts);
    $coTitle.textContent = co + ' —— 清单里已有 ' + hits.length + ' 个投过的岗位';
    $coList.textContent = '';
    hits.forEach((r) => {
      const job = r.jobUrl
        ? el('a', { class: 'cojob', href: r.jobUrl, target: '_blank', rel: 'noopener',
                    text: r.title || '(无标题)' })
        : el('span', { class: 'cojob', text: r.title || '(无标题)' });
      const meta = el('div', { class: 'cometa' }, [
        el('span', { text: '投递时间：' + fmtTs(r.ts) }),
        el('span', { class: 'costat', text: r.status }),
      ]);
      $coList.appendChild(el('div', { class: 'coitem' }, [job, meta]));
    });

    // 这家公司之前挂过（书类落 / 面试落）：黄框下面再补一段红的，比「投过」更值得警惕
    const rejects = hits.filter((r) => isRejectedStatus(r.status));
    $coRjList.textContent = '';
    if (rejects.length) {
      $coRjHead.textContent = '🚫 这家公司之前有 ' + rejects.length + ' 次落选记录';
      rejects.forEach((r) => {
        $coRjList.appendChild(el('div', { class: 'rjitem' }, [
          el('span', { text: (r.title || '(无标题)') + '　' + fmtTs(r.ts).slice(0, 10) }),
          el('span', { class: 'rjstat', text: r.status }),
        ]));
      });
      $coReject.hidden = false;
    } else {
      $coReject.hidden = true;
    }

    coAlertShownFor = jid;
    $coMask.hidden = false;
  }

  // 常亮，不关闭；点标题栏可折叠成一行
  $coOk.addEventListener('click', () => {
    $coMask.querySelector('.codlg').classList.toggle('mini');
    $coOk.textContent = $coMask.querySelector('.codlg').classList.contains('mini') ? '展开' : '收起';
  });
  $coMask.querySelector('.cohead').addEventListener('click', () => $coOk.click());

  let statsTimer = null;
  function scheduleStats() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => { refreshStats(); checkCompanyAlert(); }, 700);
  }

  window.addEventListener('resize', () => { applyBarPos(); applyPanelBox(); applyStatsPos(); });

  /* =========================================================================
   * 5. 渲染
   * ========================================================================= */

  function fmtTs(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** 只要日期的那种，YYYY-MM-DD（本地时区） */
  function fmtDate(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** 今天 0 点（本地时区）。跟进提醒都按「日期」比，不比时刻 */
  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** 追加进 MEMO 的内容前缀，标明是什么时候加的 */
  function memoStamp(ts) {
    return '[' + fmtTs(ts || Date.now()).slice(0, 16) + '] ';
  }

  /* ---- MEMO 是一条条带时间的区块（像 Trello 的评论），不是一大坨文本 ----
   * 老数据只有 memo 字符串，读的时候就地当成一条区块，不做全量迁移；
   * 一旦写过就会落成 memos 数组。memo 字段继续维护，CSV / 看板 / Telegram 都还在用。
   */
  function memoBlocks(rec) {
    if (!rec) return [];
    if (Array.isArray(rec.memos) && rec.memos.length) {
      return rec.memos.filter((b) => b && b.text).slice().sort((a, b) => b.ts - a.ts);
    }
    if (rec.memo) return [{ ts: rec.updatedAt || rec.ts, text: rec.memo }];
    return [];
  }

  function setMemoBlocks(rec, blocks) {
    const list = (blocks || [])
      .map((b) => ({ ts: b.ts || Date.now(), text: String(b.text || '').trim() }))
      .filter((b) => b.text)
      .sort((a, b) => b.ts - a.ts);          // 新 → 旧
    rec.memos = list;
    // 扁平化的那份保持可读：每块前面带时间戳，块之间空一行
    rec.memo = list.map((b) => memoStamp(b.ts) + b.text).join('\n\n');
  }

  function addMemoBlock(rec, text, ts) {
    const t = String(text || '').trim();
    if (!t) return false;
    setMemoBlocks(rec, memoBlocks(rec).concat([{ ts: ts || Date.now(), text: t }]));
    return true;
  }

  /** 毫秒 → <input type="datetime-local"> 需要的本地时间字符串 */
  function toLocalInput(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * 复制到剪贴板。navigator.clipboard 在没有用户手势、或页面权限被收紧时会直接拒绝，
   * 那种时候退回 execCommand —— 它对「临时 textarea + select」这条老路一直管用。
   * 返回 Promise<boolean>。
   */
  function copyToClipboard(text) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => fallback());
    }
    return Promise.resolve(fallback());
  }

  let toastTimer = null;
  function toast(msg) {
    $toast.textContent = msg;
    const r = $bar.getBoundingClientRect();
    $toast.style.left = Math.max(8, r.left) + 'px';
    $toast.style.top  = (r.bottom + 8) + 'px';
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 1900);
  }

  /**
   * Hiring team 单元格：每人一个指向其 LinkedIn 主页的链接 + 头衔。
   * Jobstreet 不公开招聘负责人，这一格一律写纯文本「Jobstreet」，
   * 和 LinkedIn 上「有这栏但没抓到」的「—」区分开。
   */
  function hirerNodes(rec) {
    if (recSite(rec) === 'jobstreet') return [el('span', { class: 'hirer', text: 'Jobstreet' })];
    const hirers = rec && rec.hirers;
    if (!hirers || !hirers.length) return [el('span', { class: 'role', text: '—' })];
    const out = [];
    hirers.forEach((h) => {
      const name = h.name || h.url || '(未知)';
      // 只显示人名，头衔那串后缀放进 title 里备查
      out.push(h.url
        ? el('a', { class: 'hirer', href: h.url, target: '_blank', rel: 'noopener',
                    title: h.role ? (h.role + '\n' + h.url) : h.url, text: name })
        : el('span', { class: 'hirer', title: h.role || '', text: name }));
    });
    return out;
  }

  function rowNode(r) {
    const select = el('select', { data: { f: 'status' } },
      activeStatuses().map((s) => el('option', { value: s, selected: s === r.status, text: s })));
    select.value = r.status || defaultStatus();

    // MEMO 改为点开弹窗编辑，格子里只预览最新的那一条
    const blocks = memoBlocks(r);
    const memo = el('button', {
      class: 'memo-cell', type: 'button', data: { act: 'memo' },
      title: blocks.length ? ('共 ' + blocks.length + ' 条，点开看完整时间轴') : '点击写 MEMO',
      text: blocks.length ? blocks[0].text : '写备注…',
    });
    if (!blocks.length) memo.classList.add('blank');

    const scout = el('input', { type: 'checkbox', data: { f: 'scout' }, title: '人事主动 scout 的' });
    scout.checked = !!r.scout;

    // 投递时间可手动修改；datetime-local 只吃本地时间字符串，不带时区
    const when = el('input', { type: 'datetime-local', data: { f: 'ts' }, step: '60' });
    when.value = toLocalInput(r.ts);

    // EP 行业下拉 + 按当前年龄算出的薪资门槛
    const age = ageFrom(gh.birthday);
    const monthly = c1Monthly(r.sector, age);
    const annual = c1Annual(monthly);
    const byAI = r.sectorBy === 'ai' && !!r.sector;
    const sector = el('select', {
      class: byAI ? 'ai-guess' : null,
      data: { f: 'sector' },
      title: (byAI ? '🤖 Claude 判定的，核对一下；改成别的就会记住你的选择\n' : '')
           + (age == null ? '先在 ☁ 设置里填出生年月日' : ('按 ' + age + ' 岁计算')),
    },
      [el('option', { value: '', text: '（未选）' })].concat(
        Object.keys(C1_SALARY).sort().map((k) => el('option', {
          value: k, selected: k === r.sector, text: (byAI && k === r.sector ? '🤖 ' : '') + k,
        }))));
    sector.value = r.sector || '';

    // 重要度：数字大的排在最上面，和状态顺位无关
    const prio = el('select', { class: 'p' + (r.priority || 0), data: { f: 'priority' },
                                title: '重要度：设了之后排在清单最上面' },
      PRIORITIES.map((p) => el('option', { value: String(p.v), selected: p.v === (r.priority || 0), text: p.label })));
    prio.value = String(r.priority || 0);

    // 状态下方的小标记：跟进提醒 🕐 与重要度 ✨，和看板上的显示保持一致
    const marks = el('div', { class: 'stmarks' });
    if (r.followUpAt) {
      const due = r.followUpAt <= startOfToday();
      marks.appendChild(el('button', {
        class: 'fu' + (due ? ' due' : ''), type: 'button', data: { act: 'followup' },
        title: '跟进提醒：' + fmtDate(r.followUpAt) + (r.followUpNote ? ('\n' + r.followUpNote) : '')
             + '\n点击可修改',
        text: '🕐 ' + fmtDate(r.followUpAt).slice(5),
      }));
    }
    if (r.priority) {
      marks.appendChild(el('span', {
        class: 'stars', title: '重要度 ' + r.priority + ' 级', text: '✨'.repeat(r.priority),
      }));
    }

    // 列序要和 COLS 一致：重要度 → 状态 → 操作 → MEMO → scout → 投递时间 → 公司 → 岗位 → HR → 中位任职
    return el('tr', { class: isClosedStatus(r.status) ? 'closed' : null, data: { id: r.id } }, [
      el('td', { class: 'c-pr' }, [prio]),
      el('td', { class: 'c-st' }, [select, marks]),
      el('td', { class: 'c-op' }, [
        el('button', { class: 'op-btn', data: { act: 'remind' }, title: '请求更新状态（发 Telegram）', text: '📢' }),
        el('button', { class: 'op-btn', data: { act: 'followup' }, title: '设置跟进提醒', text: '🕐' }),
        el('button', { class: 'op-btn', data: { act: 'copy' }, title: '复制该条', text: '⧉' }),
        el('button', { class: 'op-btn', data: { act: 'del'  }, title: '删除该条', text: '🗑' }),
      ]),
      el('td', { class: 'c-me' }, [memo]),
      el('td', { class: 'c-sc' }, [scout]),
      el('td', { class: 'c-ts' }, [when]),
      el('td', { class: 'c-co', text: r.company || '—' }),
      el('td', { class: 'c-ti' }, [
        r.jobUrl
          ? el('a', { href: r.jobUrl, target: '_blank', rel: 'noopener', text: r.title || '(无标题)' })
          : document.createTextNode(r.title || '(无标题)'),
      ]),
      el('td', { class: 'c-hr' }, hirerNodes(r)),
      el('td', { class: 'c-te', text: r.tenure || '—' }),
      el('td', { class: 'c-ep' }, [sector]),
      el('td', { class: 'c-eb', text: monthly ? ('S$' + fmtMoney(monthly)) : '—' }),
      el('td', { class: 'c-ea', text: annual ? ('S$' + fmtMoney(annual)) : '—' }),
    ]);
  }

  function render() {
    $cnt.textContent = '(' + records.length + ')';
    // 重要度最优先（★ 多的在最上面），其次状态顺位，最后按投递时间从新到旧
    const sorted = records.slice().sort((a, b) => {
      const p = (b.priority || 0) - (a.priority || 0);
      if (p !== 0) return p;
      const d = statusRank(a.status) - statusRank(b.status);
      return d !== 0 ? d : b.ts - a.ts;
    });

    $tbody.textContent = '';
    const frag = document.createDocumentFragment();
    sorted.forEach((r) => frag.appendChild(rowNode(r)));
    $tbody.appendChild(frag);

    $empty.hidden = records.length > 0;
    applyHitRows();              // 表格是整体重建的，定位高亮要补回去
    refreshApplyBtn();
  }

  /* -------------------------------------------------------------------------
   * 5.1 🔍 按公司名快速定位
   *     输入公司名开头 → 弹出清单里已有的公司提示 → 选中后滚到它那几行并高亮，
   *     直接就能改状态 / 写 MEMO。
   * ---------------------------------------------------------------------- */

  let hitIds = null;      // 当前定位到的那批记录 id（null = 没有定位）
  let suggList = [];
  let suggIdx = -1;

  /**
   * 清单里出现过的公司名与岗位名，按「开头匹配 > 包含匹配」排序。
   * 两类混在一个框里搜，条目上标 🏢 / 💼 区分。
   */
  function companySuggestions(q) {
    const map = Object.create(null);
    const add = (kind, label, key, id) => {
      if (!key) return;
      const k = kind + ' ' + key;
      if (!map[k]) map[k] = { kind: kind, name: label, key: key, ids: [] };
      map[k].ids.push(id);
    };
    records.forEach((r) => {
      add('co', r.company, companyKey(r.company), r.id);
      add('ti', r.title, titleKey(r.title), r.id);
    });
    // 公司排在岗位前面，各自按名称排序
    const all = Object.keys(map).map((k) => map[k]).sort((a, b) =>
      (a.kind === b.kind ? 0 : (a.kind === 'co' ? -1 : 1))
      || String(a.name).localeCompare(String(b.name), 'zh'));

    // 公司名和岗位名的归一化规则不同，两边各算一次键，命中任意一个都算
    const ck = companyKey(q), tk = titleKey(q);
    if (!ck && !tk) return all.slice(0, 12);
    const pos = (c) => {
      const key = c.kind === 'co' ? ck : tk;
      return key ? c.key.indexOf(key) : -1;
    };
    const head = all.filter((c) => pos(c) === 0);
    const rest = all.filter((c) => pos(c) > 0);
    return head.concat(rest).slice(0, 12);
  }

  function renderSugg() {
    $sugg.textContent = '';
    if (!suggList.length) {
      $sugg.appendChild(el('div', { class: 'none', text: '清单里没有匹配的公司或岗位' }));
      $sugg.hidden = false;
      return;
    }
    suggList.forEach((c, i) => {
      const item = el('div', { class: 'item' + (i === suggIdx ? ' on' : '') }, [
        el('span', { class: 'nm', text: (c.kind === 'co' ? '🏢 ' : '💼 ') + c.name }),
        el('span', { class: 'n', text: c.ids.length + ' 条' }),
      ]);
      // 用 mousedown：click 之前输入框会先 blur，那时候下拉已经关了
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();       // 别让标题栏当成拖拽起手
        pickSugg(i);
      });
      $sugg.appendChild(item);
    });
    $sugg.hidden = false;
  }

  function openSugg() {
    suggList = companySuggestions($search.value);
    suggIdx = suggList.length ? 0 : -1;
    renderSugg();
  }

  function closeSugg() { $sugg.hidden = true; }

  function pickSugg(i) {
    const c = suggList[i];
    if (!c) return;
    $search.value = c.name;
    closeSugg();
    jumpToCompany(c);
  }

  /** 把这一条建议对应的所有行标出来并滚到第一行 */
  function jumpToCompany(c) {
    hitIds = Object.create(null);
    c.ids.forEach((id) => { hitIds[id] = 1; });
    $tbody.querySelectorAll('tr.hit').forEach((tr) => tr.classList.remove('hit'));
    const rows = applyHitRows();
    if (!rows.length) { toast('清单里没找到「' + c.name + '」'); return; }
    rows[0].scrollIntoView({ block: 'center' });
    flashRow(rows[0].dataset.id);
    toast('已定位到「' + c.name + '」（' + rows.length + ' 条）');
  }

  /** 按 hitIds 给对应的行加高亮，返回这些行（按清单里的显示顺序） */
  function applyHitRows() {
    const rows = [];
    if (!hitIds) return rows;
    $tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      if (!hitIds[tr.dataset.id]) return;
      tr.classList.add('hit');
      rows.push(tr);
    });
    return rows;
  }

  function clearHit() {
    hitIds = null;
    $tbody.querySelectorAll('tr.hit').forEach((tr) => tr.classList.remove('hit'));
  }

  $search.addEventListener('input', () => {
    if (!$search.value.trim()) clearHit();
    openSugg();
  });
  $search.addEventListener('focus', openSugg);
  $search.addEventListener('blur', () => setTimeout(closeSugg, 120));
  $search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if ($sugg.hidden) { openSugg(); return; }
      if (!suggList.length) return;
      suggIdx = (suggIdx + (e.key === 'ArrowDown' ? 1 : suggList.length - 1)) % suggList.length;
      renderSugg();
      const on = $sugg.querySelector('.item.on');
      if (on) on.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickSugg(suggIdx >= 0 ? suggIdx : 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!$sugg.hidden) { closeSugg(); return; }
      $search.value = '';
      clearHit();
    }
  });

  /** MEMO / 状态改动后打个时间戳，看板的「更新时间」列用它 */
  function touch(rec) { if (rec) rec.updatedAt = Date.now(); }

  /**
   * 默认状态（role:'default'）超过 30 天没有任何更新 → 自动落到 role:'nonews' 那条。
   * 两头都按角色找，所以这两条状态被改名了也照样工作；
   * 把 role:'nonews' 那条删掉就等于关掉这个自动判定。
   * 以最后一次改动（没改过就是投递时间）为准；自动改完会打上更新时间戳，
   * 所以同一条不会被反复判定，手动改回去也不会立刻又被翻掉。
   */
  function applyNoNewsTimeout() {
    const from = defaultStatus();
    const to = noNewsStatus();
    if (!from || !to || from === to) return 0;

    const cut = Date.now() - NO_NEWS_DAYS * 86400000;
    let n = 0;
    records.forEach((r) => {
      if (!r || r.status !== from) return;
      const last = r.updatedAt || r.ts;
      if (!last || last >= cut) return;
      const now = Date.now();
      const days = Math.floor((now - r.ts) / 86400000);
      r.status = to;
      // 自动改的也要留痕：不然过一阵回头看，只会觉得状态莫名其妙自己变了
      addMemoBlock(r,
        '🤖 自动变更：投递后 ' + days + ' 天无响应（判定阈值 ' + NO_NEWS_DAYS + ' 天），'
        + '状态由「' + from + '」改为「' + to + '」。\n'
        + '变更时间：' + fmtTs(now), now);
      r.updatedAt = now;
      n++;
    });
    if (n) {
      saveRecords();
      render();
      toast(n + ' 条超过 ' + NO_NEWS_DAYS + ' 天没动静，已标为「' + to + '」');
    }
    return n;
  }

  function findRec(id) {
    for (let i = 0; i < records.length; i++) if (records[i].id === id) return records[i];
    return null;
  }

  // 行内编辑：状态 / scout / 投递时间 —— 即时写入本地存储
  $tbody.addEventListener('change', (e) => {
    const f = e.target.dataset && e.target.dataset.f;
    if (!f) return;
    const tr = e.target.closest('tr');
    const rec = findRec(tr.dataset.id);
    if (!rec) return;

    if (f === 'status') {
      rec.status = e.target.value;
      touch(rec);
      saveRecords();
      render();                  // 状态决定排序与划线，改完要重排
      flashRow(rec.id);
      markPageCards();
      toast('状态已保存：' + rec.status);

    } else if (f === 'priority') {
      rec.priority = Number(e.target.value) || 0;
      touch(rec);
      saveRecords();
      render();                  // 重要度决定排序，改完要重排
      flashRow(rec.id);
      toast(rec.priority ? ('重要度：' + '★'.repeat(rec.priority)) : '已取消重要度');

    } else if (f === 'sector') {
      rec.sector = e.target.value;
      // 自己选过的就是定论：记进缓存，同一家公司以后不再由模型判定。
      // 清空只清这一行——公司级的对应关系留着，否则会连累同公司的其它行。
      rec.sectorBy = rec.sector ? 'manual' : '';
      if (rec.sector) rememberSector(rec.company, rec.sector, 'manual');
      touch(rec);
      saveRecords();
      render();
      toast(rec.sector ? ('EP 行业：' + rec.sector) : '已清除 EP 行业');

    } else if (f === 'scout') {
      rec.scout = e.target.checked;
      saveRecords();
      toast(rec.scout ? '已标记为「人事主动 scout 的」' : '已取消 scout 标记');

    } else if (f === 'ts') {
      const t = Date.parse(e.target.value);          // datetime-local 按本地时区解析
      if (isNaN(t)) { e.target.value = toLocalInput(rec.ts); toast('时间格式无法识别'); return; }
      rec.ts = t;
      saveRecords();
      render();                  // 同状态内按时间排序，改完要重排
      flashRow(rec.id);
      toast('投递时间已改为 ' + fmtTs(t));
    }
  });

  $tbody.addEventListener('click', (e) => {
    const cell = e.target.closest('.memo-cell');
    if (cell) {
      const rec = findRec(cell.closest('tr').dataset.id);
      if (rec) openMemoDialog(rec);
      return;
    }
    const btn = e.target.closest('.op-btn, .stmarks .fu');
    if (!btn) return;
    const tr = btn.closest('tr');
    const rec = findRec(tr.dataset.id);
    if (!rec) return;

    if (btn.dataset.act === 'remind') {
      openRemind(rec);
    } else if (btn.dataset.act === 'followup') {
      openFollowUp(rec);
    } else if (btn.dataset.act === 'del') {
      confirmDialog({
        title: '删除这条记录？',
        body: (rec.company || '') + ' / ' + (rec.title || '') + '\n投递于 ' + fmtTs(rec.ts),
        okText: '删除', danger: true,
      }).then((ok) => { if (ok) deleteRecord(rec.id); });
    } else if (btn.dataset.act === 'copy') {
      const text = [
        fmtTs(rec.ts), rec.company, rec.title,
        (rec.hirers || []).map((h) => h.name + ' <' + h.url + '>').join(' / '),
        '总员工数: ' + (rec.employees || '-'),
        '要求年限: ' + (rec.years || '-'),
        'Job match: ' + (rec.jobMatch || '-'),
        'Median tenure: ' + (rec.tenure || '-'),
        '状态: ' + rec.status,
        rec.memo ? ('MEMO: ' + rec.memo) : '',
        rec.jobUrl,
      ].filter(Boolean).join('\n');
      copyToClipboard(text).then((ok) => toast(ok ? '已复制到剪贴板' : '复制失败'));
    }
  });

  /* =========================================================================
   * 6. 记录 / 导入导出
   * ========================================================================= */

  /**
   * 页面内确认弹窗，替代原生 confirm()。
   * 返回 Promise<boolean>。
   */
  let cfResolve = null;
  function confirmDialog(opts) {
    $cfTitle.textContent = opts.title || '确认';
    $cfBody.textContent = opts.body || '';
    $cfOk.textContent = opts.okText || '确定';
    $cfNo.textContent = opts.cancelText || '取消';
    $cfOk.className = opts.danger ? 'danger' : 'primary';
    $cfMask.hidden = false;
    return new Promise((resolve) => {
      cfResolve = (v) => { $cfMask.hidden = true; cfResolve = null; resolve(v); };
    });
  }
  $cfOk.addEventListener('click', () => cfResolve && cfResolve(true));
  $cfNo.addEventListener('click', () => cfResolve && cfResolve(false));
  $cfMask.addEventListener('click', (e) => { if (e.target === $cfMask && cfResolve) cfResolve(false); });

  function currentRecorded() {
    const jid = getJobId();
    if (!jid) return null;
    for (let i = 0; i < records.length; i++) {
      // 职位 ID 只在本站内唯一，站点不同就不是同一条
      if (records[i].jobId === jid && recSite(records[i]) === SITE) return records[i];
    }
    return null;
  }

  function deleteRecord(id) {
    // 先立墓碑再保存：saveRecords 会和存储里那份合并，没有墓碑的话
    // 别的标签页（或本页刚才那次写入）里的同一条会被原样收回来。
    deleted[id] = Date.now();
    saveDeleted();
    records = records.filter((x) => x.id !== id);
    saveRecords();
    render();
    markPageCards();
    toast('已删除');
  }

  function refreshApplyBtn() {
    // 非职位详情页（如 Job tracker、搜索列表）没有「当前职位」，按钮无意义
    $applyBt.hidden = !isJobPage();
    // 会话操作按钮只在「真的有一个会话开着」时出现。
    // 只看 URL 的话，SPA 从别的页面切进站内信、线程还没渲染出来的那段时间里
    // 按钮就已经在了，点下去只能报错。
    const msg = isMessagingPage() && hasOpenThread();
    $otherBt.hidden = !msg;
    $archiveBt.hidden = !msg;

    const rec = currentRecorded();
    if (rec) {
      $applyBt.textContent = '已递交 ✓';
      $applyBt.classList.add('done');
      $applyBt.title = '已于 ' + fmtTs(rec.ts) + ' 记录（' + rec.status + '）\n点击可删除这条记录';
    } else {
      $applyBt.textContent = '已递交投递';
      $applyBt.classList.remove('done');
      $applyBt.title = '点击记录本职位到「已递交清单」';
    }
  }

  function flashRow(id) {
    const tr = $tbody.querySelector('tr[data-id="' + id + '"]');
    if (!tr) return;
    tr.classList.remove('flash');
    void tr.offsetWidth;
    tr.classList.add('flash');
    tr.scrollIntoView({ block: 'nearest' });
  }

  const pendingNew = [];        // 已记录但还没同步成功的新条目

  /** 写完之后回读一次，确认这条真的落进存储里了 */
  function storedHas(id) {
    const list = store.get(K_REC, []);
    return Array.isArray(list) && list.some((x) => x && x.id === id);
  }

  function addRecord() {
    const rec = collectJobInfo();
    if (!rec.title && !rec.company) {
      // 以前这里只弹个 1.9 秒的 toast，很容易错过，事后就成了「点了却没进清单」。
      // 改成必须手动关掉的确认框。
      confirmDialog({
        title: '没有记录成功',
        body: '未能从当前页面识别出公司名与岗位名，所以没有加进清单。\n'
            + '请等职位详情完全加载出来（或先点开某个职位）再试一次。',
        okText: '知道了', cancelText: '关闭', danger: true,
      });
      return null;
    }
    records.push(rec);
    pendingNew.push({ id: rec.id, company: rec.company, title: rec.title });
    saveRecords();

    // 回读校验：存储写失败（配额满、被别的标签页覆盖…）时必须让人看见，
    // 否则就是「以为记下了，其实没有」。重试一次仍不行才报错。
    if (!storedHas(rec.id)) {
      saveRecords();
      if (!storedHas(rec.id)) {
        records = records.filter((x) => x.id !== rec.id);
        confirmDialog({
          title: '记录没有保存成功',
          body: (rec.company || '?') + ' / ' + (rec.title || '?') + '\n\n'
              + '写入本地存储失败，这条没有加进清单。请刷新页面后重试；'
              + '若反复失败，先「导出 JSON」备份，再检查浏览器存储是否已满。',
          okText: '知道了', cancelText: '关闭', danger: true,
        });
        render();
        return null;
      }
    }

    render();
    flashRow(rec.id);
    markPageCards();

    // EP 行业：缓存里有就是秒填，没有才去问模型；失败也不打扰
    if (gh.aiAuto && aiReady()) fillSectors([rec], true);

    const miss = [];
    if (!rec.hirers.length) miss.push('Hiring team');
    if (!rec.employees)    miss.push('总员工数');
    if (!rec.tenure)       miss.push('Median tenure');
    toast('已记录：' + (rec.company || '?') + ' / ' + (rec.title || '?') +
          (miss.length ? '（未抓到 ' + miss.join('、') + '）' : ''));
    return rec;
  }

  /** 悬浮按钮的点击行为：已记录 → 问是否删除；未记录 → 直接记录 */
  function onApplyButton() {
    const rec = currentRecorded();
    if (!rec) { addRecord(); return; }

    flashRow(rec.id);
    confirmDialog({
      title: '这个职位已经记录过了，要删除吗？',
      body: (rec.company || '') + ' / ' + (rec.title || '') + '\n'
          + '投递于 ' + fmtTs(rec.ts) + '\n当前状态：' + rec.status,
      okText: '删除记录', cancelText: '保留', danger: true,
    }).then((ok) => { if (ok) deleteRecord(rec.id); });
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function stamp() {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function exportCSV() {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['投递时间', '公司名', '岗位名', 'Hiring team 姓名', 'Hiring team URL',
                  '总员工数', '要求年限', 'Job match', 'Median employee tenure',
                  '状态', '重要度', '跟进提醒', '人事主动 scout 的',
                  'MEMO', 'EP 所属行业', '最低月 base', '年总所需', '职位链接', 'Job ID'];
    const lines = [head.map(q).join(',')];
    records.slice().sort((a, b) => b.ts - a.ts).forEach((r) => {
      lines.push([
        fmtTs(r.ts), r.company, r.title,
        (r.hirers || []).map((h) => h.name).join(' | '),
        (r.hirers || []).map((h) => h.url).join(' | '),
        r.employees, r.years, r.jobMatch, r.tenure,
        r.status, r.priority ? '★'.repeat(r.priority) : '',
        r.followUpAt ? fmtDate(r.followUpAt) : '',
        r.scout ? 'YES' : '', r.memo,
        r.sector || '', c1Monthly(r.sector, ageFrom(gh.birthday)) || '',
        c1Annual(c1Monthly(r.sector, ageFrom(gh.birthday))) || '', r.jobUrl, r.jobId,
      ].map(q).join(','));
    });
    download('linkedin-applied-' + stamp() + '.csv', '﻿' + lines.join('\r\n'), 'text/csv');
    toast('已导出 CSV（' + records.length + ' 条）');
  }

  function exportJSON() {
    download('linkedin-applied-' + stamp() + '.json', JSON.stringify(records, null, 2), 'application/json');
    toast('已导出 JSON（' + records.length + ' 条）');
  }

  function importJSON() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const fr = new FileReader();
      fr.onload = () => {
        let data;
        try { data = JSON.parse(String(fr.result)); } catch (e) { toast('JSON 解析失败'); return; }
        if (!Array.isArray(data)) { toast('格式不正确：应为数组'); return; }
        const have = Object.create(null);
        records.forEach((r) => { have[r.id] = 1; });
        let n = 0;
        data.forEach((r) => {
          if (!r || typeof r !== 'object') return;
          if (!r.id) r.id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          if (have[r.id]) return;
          if (!r.ts) r.ts = Date.now();
          r.status = canonStatus(r.status);
          if (!Array.isArray(r.hirers)) r.hirers = [];
          records.push(r); have[r.id] = 1; n++;
        });
        saveRecords();
        render();
        toast('已导入 ' + n + ' 条');
      };
      fr.readAsText(file);
    });
    input.click();
  }

  /* =========================================================================
   * 6.2 监听 LinkedIn 自己的 Apply 按钮
   *     点击后不拦截原本的投递流程，只在页面上弹一个非阻塞提示条问要不要入库。
   *     用满屏遮罩会挡住 LinkedIn 的 Easy Apply 弹窗，所以这里刻意做成非模态。
   * ========================================================================= */

  const APPLY_TEXT = /^(easy\s+)?(quick\s+)?apply(\s+now)?$/i;
  const APPLY_LABEL = /\bapply\s+to\s+this\s+job\b|\beasy\s+apply\b|\bapply\s+on\b|\bapply\s+for\b/i;

  function isApplyControl(node) {
    const ctl = node && node.closest && node.closest('button, a[role="button"], a');
    if (!ctl) return null;
    // Jobstreet 的投递按钮有自己的锚点，最准
    if (ctl.closest('[data-automation="job-detail-apply"]')) return ctl;
    const label = ctl.getAttribute('aria-label') || '';
    if (APPLY_LABEL.test(label)) return ctl;
    if (APPLY_TEXT.test(norm(ctl))) return ctl;
    return null;
  }

  let askTimer = null;
  function showAskPrompt(rec) {
    $askDesc.textContent = (rec.company || '?') + ' / ' + (rec.title || '?');
    const r = $bar.getBoundingClientRect();
    $ask.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 340)) + 'px';
    $ask.style.top  = Math.min(r.bottom + 10, window.innerHeight - 150) + 'px';
    $ask.hidden = false;
    clearTimeout(askTimer);
    askTimer = setTimeout(() => { $ask.hidden = true; }, 45000);   // 45 秒没理它就自己收起
  }

  $askYes.addEventListener('click', () => {
    $ask.hidden = true;
    clearTimeout(askTimer);
    if (currentRecorded()) { toast('已经在清单里了'); return; }
    addRecord();
  });
  $askNo.addEventListener('click', () => { $ask.hidden = true; clearTimeout(askTimer); });

  // 捕获阶段监听，保证在 LinkedIn 自己的处理器之前拿到事件；全程不阻断默认行为
  document.addEventListener('click', (e) => {
    if (!isJobPage()) return;
    if (e.target === host) return;                    // 来自我们自己 shadow DOM 的点击
    const ctl = isApplyControl(e.target);
    if (!ctl) return;
    if (currentRecorded()) return;                    // 已纳入「已提交」的除外
    // 让出一帧，等 LinkedIn 的弹窗先渲染，避免位置计算被后续布局影响
    setTimeout(() => {
      if (currentRecorded()) return;
      showAskPrompt(collectJobInfo());
    }, 350);
  }, true);

  /* =========================================================================
   * 6.3 给页面上已递交过的职位卡片划线置灰
   *     Job tracker / 搜索列表 / 详情页底部的 More jobs 都适用。
   * ========================================================================= */

  const MARK_CLASS = 'lat-applied-strike';
  const CO_CLASS   = 'lat-applied-company';   // 清单里投过的公司，在列表里标红
  const SAME_CLASS = 'lat-same-position';     // 同名岗位投过，卡片灰底
  const CUR_CLASS  = 'lat-current-applied';   // 当前浏览的岗位与投过的同名，标题划线
  const HIDE_CLASS = 'lat-hidden-job';        // 点过「✕」的卡片，直接不显示
  const XCHIP_CLS  = 'lat-x-chip';            // 卡片上的「✕ 不看」按钮
  const OPS_CLASS  = 'lat-msg-ops';           // 站内信会话卡片上的快捷操作按钮组
  const OP_CLASS   = 'lat-msg-op';

  // 这段样式要作用在站点自己的元素上，只能注入到页面里（textContent 不是 TT 接收点）
  (function injectPageStyle() {
    if (IS_BOARD) return;        // 看板页没有职位卡片，别往人家页面里塞样式
    const st = document.createElement('style');
    st.id = 'lat-page-style';
    st.textContent =
      '.' + MARK_CLASS + '{opacity:.55;}' +
      '.' + MARK_CLASS + ',.' + MARK_CLASS + ' p,.' + MARK_CLASS + ' span,.' + MARK_CLASS + ' a,' +
      '.' + MARK_CLASS + ' h1,.' + MARK_CLASS + ' h2,.' + MARK_CLASS + ' h3,.' + MARK_CLASS + ' strong' +
      '{text-decoration:line-through !important;color:#8c949e !important;}' +
      '.' + MARK_CLASS + ' img,.' + MARK_CLASS + ' svg{filter:grayscale(1);opacity:.7;}' +
      // 标红优先级要高于上面的置灰，所以写在后面
      '.' + CO_CLASS + '{color:#d93025 !important;font-weight:700 !important;}' +
      '.' + SAME_CLASS + '{background:#e8e8e8 !important;border-radius:8px;}' +
      '@media (prefers-color-scheme:dark){.' + SAME_CLASS + '{background:#333 !important;}}' +
      '.' + CUR_CLASS + '{text-decoration:line-through !important;text-decoration-thickness:2px !important;}' +
      // 隐藏：整张卡片（连同外层的间距容器）不占位
      '.' + HIDE_CLASS + '{display:none !important;}' +
      // 「✕」按钮：跟在岗位名后面。z-index 要压过卡片上那层整块可点的透明链接
      '.' + XCHIP_CLS + '{display:inline-flex;align-items:center;justify-content:center;' +
      'position:relative;z-index:20;width:20px;height:20px;margin-left:8px;flex:0 0 auto;' +
      'border:1px solid #c9ccd1;border-radius:50%;background:#fff;color:#6b7280 !important;' +
      'font-size:12px;line-height:1;cursor:pointer;vertical-align:middle;' +
      'text-decoration:none !important;user-select:none;}' +
      '.' + XCHIP_CLS + ':hover{border-color:#d93025;background:#d93025;color:#fff !important;}' +
      '.' + XCHIP_CLS + '.corner{position:absolute;top:8px;right:8px;margin-left:0;}' +
      // 站内信会话卡片上的快捷操作（📥 移到 Other / 🗄 归档）
      '.' + OPS_CLASS + '{display:inline-flex;gap:2px;margin-left:4px;vertical-align:middle;' +
      'position:relative;z-index:5;}' +
      '.' + OPS_CLASS + '.corner{position:absolute;top:6px;right:6px;}' +
      '.' + OPS_CLASS + ' .' + OP_CLASS + '{display:inline-flex;align-items:center;justify-content:center;' +
      'width:22px;height:22px;padding:0;border:1px solid #c9ccd1;border-radius:50%;background:#fff;' +
      'font-size:11px;line-height:1;cursor:pointer;color:#6b7280;}' +
      '.' + OPS_CLASS + ' .' + OP_CLASS + ':hover{border-color:#0a66c2;background:#0a66c2;}' +
      '.' + OPS_CLASS + ' .' + OP_CLASS + '.busy{opacity:.45;cursor:progress;}';
    (document.head || document.documentElement).appendChild(st);
  })();

  /**
   * 记录属于哪个站点。老记录没有 site 字段，就按职位链接的域名推断，
   * 都对不上才算 LinkedIn —— 判定规则和看板 build.py 里的 site_of() 保持一致。
   */
  function recSite(r) {
    if (r && r.site) return r.site;
    return (r && /jobstreet\./i.test(r.jobUrl || '')) ? 'jobstreet' : 'linkedin';
  }

  /** 当前站点已投递过的职位 ID（职位 ID 只在本站内唯一，跨站不能混着比） */
  function recordedJobIds() {
    const set = Object.create(null);
    records.forEach((r) => { if (r.jobId && recSite(r) === SITE) set[r.jobId] = 1; });
    return set;
  }

  /** 岗位名比对用的键，规则同公司名 */
  function titleKey(t) {
    return String(t || '').toLowerCase()
      .replace(/[.,，、。·・&＆()（）\/|｜-]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  /** 清单里投过的岗位名集合 */
  function appliedTitles() {
    const set = Object.create(null);
    records.forEach((r) => {
      const k = titleKey(r.title);
      if (k && k.length >= 3) (set[k] = set[k] || []).push(r);
    });
    return set;
  }

  /** 公司名比对用的键：大小写、空白、常见标点差异都不算不同 */
  function companyKey(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[.,，、。·・&＆]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---- 「✕ 不看」隐藏掉的职位 ---- */

  // 两个站点的职位 ID 各自成体系，键里带上站点名，跨站不会互相误伤
  function hideKey(id, site) { return (site || SITE) + ':' + id; }
  function isHidden(id) { return !!hiddenJobs[hideKey(id)]; }

  function hideJob(card, id) {
    const title   = norm(card.querySelector('[data-automation="jobTitle"]'))
                 || norm(card.querySelector('a[href*="/jobs/view/"]'));
    const company = norm(card.querySelector('[data-automation="jobCompany"]'));
    hiddenJobs[hideKey(id)] = {
      site: SITE,
      jobId: id,
      title: title,
      company: company,
      url: IS_JS ? (JS_ORIGIN + '/job/' + id) : ('https://www.linkedin.com/jobs/view/' + id + '/'),
      ts: Date.now(),
    };
    saveHiddenJobs();
    cardShell(card).classList.add(HIDE_CLASS);
    if (!$hidMask.hidden) renderHiddenList();
    toast('已隐藏：' + (title || id) + '　（清单里「🙈 已隐藏」可恢复）');
  }

  function unhideJob(key) {
    const it = hiddenJobs[key];
    if (!it) return;
    delete hiddenJobs[key];
    saveHiddenJobs();
    unhideAllCards();
    toast('已恢复：' + (it.title || it.jobId));
  }

  /** 页面上所有被藏起来的卡片重新显示，再按当前数据重画一遍 */
  function unhideAllCards() {
    document.querySelectorAll('.' + HIDE_CLASS).forEach((n) => n.classList.remove(HIDE_CLASS));
    markPageCards();
  }

  /** 清单里出现过的公司 → { key: {name, count} } */
  function recordedCompanies() {
    const map = Object.create(null);
    records.forEach((r) => {
      const k = companyKey(r.company);
      if (!k) return;
      if (!map[k]) map[k] = { name: r.company, count: 0 };
      map[k].count++;
    });
    return map;
  }

  /** 从职位链接往上找到「一张卡片」：再往上就会包含第二个职位链接的那一层 */
  function findCardRoot(a) {
    let cur = a, best = a;
    for (let i = 0; i < 8 && cur.parentElement; i++) {
      cur = cur.parentElement;
      if (cur.querySelectorAll('a[href*="/jobs/view/"]').length > 1) break;
      if (cur === document.body) break;
      best = cur;
    }
    return best;
  }

  /**
   * 把卡片里与清单中同名的公司标红。
   * 只在卡片范围内找纯文本节点，避免误伤左侧导航、筛选器之类。
   */
  /**
   * 节点自身的直接文本（不含子元素里的）。
   * 页面开着翻译插件时，公司名节点会变成
   *   <p>Hubble.Build<span class="trancy-…">哈勃。建造中</span></p>
   * 译文在子元素里，只取直接文本才拿得到原始公司名。
   */
  function ownText(node) {
    let t = '';
    for (let i = 0; i < node.childNodes.length; i++) {
      const n = node.childNodes[i];
      if (n.nodeType === 3) t += n.nodeValue;
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  function markCompanyIn(card, companies) {
    const marked = [];

    card.querySelectorAll('p, span, h3, h4, div, strong, a').forEach((node) => {
      if (node.childElementCount > 3) return;        // 大容器不碰

      // 依次拿几种可能的写法去比：自身直接文本 > 整串文本，各自再取「公司 · 地点」的首段
      const own = ownText(node);
      const all = (node.textContent || '').replace(/\s+/g, ' ').trim();
      const cands = [];
      [own, all].forEach((raw) => {
        if (!raw || raw.length > 80) return;
        cands.push(companyKey(raw));
        cands.push(companyKey(raw.split(/[·•・|｜]/)[0]));
      });

      let hit = null;
      for (let i = 0; i < cands.length; i++) {
        const k = cands[i];
        if (k && k.length >= 2 && companies[k]) { hit = companies[k]; break; }
      }

      if (hit) {
        marked.push(node);
        if (!node.classList.contains(CO_CLASS)) {
          node.classList.add(CO_CLASS);
          node.title = '已投递过：' + hit.name + '（清单里 ' + hit.count + ' 条）';
        }
      } else if (node.classList.contains(CO_CLASS)) {
        node.classList.remove(CO_CLASS);             // 记录删了要能取消标红
        node.removeAttribute('title');
      }
    });

    // 父子都命中时只留最里层的那个，避免整块被染红
    marked.forEach((node) => {
      for (let i = 0; i < marked.length; i++) {
        if (marked[i] !== node && node.contains(marked[i])) {
          node.classList.remove(CO_CLASS);
          node.removeAttribute('title');
          break;
        }
      }
    });
  }

  /** 当前浏览的岗位若与投过的同名，把页面上的标题划掉 */
  function markCurrentTitle() {
    const titles = appliedTitles();
    const cur = getTitleAndCompany();
    const key = titleKey(cur.title);
    const jid = getJobId();
    // 「同名的别的记录」——当前这条自己不算
    const isSelf = (r) => recSite(r) === SITE && r.jobId === jid;
    const hit = key && titles[key] && titles[key].some((r) => !isSelf(r));

    document.querySelectorAll('h1, h2, p').forEach((n) => {
      if (n.childElementCount > 3) return;
      const own = ownText(n) || (n.textContent || '');
      if (titleKey(own) !== key || !key) {
        if (n.classList.contains(CUR_CLASS)) n.classList.remove(CUR_CLASS);
        return;
      }
      n.classList.toggle(CUR_CLASS, !!hit);
      if (hit) n.title = '这个岗位名你已经投过了';
    });
  }

  /**
   * 隐藏时要连卡片外面那层容器一起藏，否则列表里会留一条空白间距。
   * Jobstreet 每张卡片外面包了一层 data-search-sol-meta 的 div。
   */
  function cardShell(card) {
    return card.closest('[data-search-sol-meta]') || card;
  }

  /** 给卡片挂上「✕ 不看」按钮（同一张卡片只挂一次） */
  function mountHideChip(card, id) {
    if (card.querySelector('.' + XCHIP_CLS)) return;

    const chip = document.createElement('span');
    chip.className = XCHIP_CLS;
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('aria-label', '不看这个职位');
    chip.textContent = '✕';
    chip.title = '不看这个职位：从搜索结果里隐藏（可在清单「🙈 已隐藏」里恢复）';

    const doHide = (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideJob(card, id);
    };
    // 卡片上盖着一层整块可点的透明链接，按下就会跳转，所以按下阶段也要拦住
    ['mousedown', 'pointerdown', 'touchstart'].forEach((ev) => {
      chip.addEventListener(ev, (e) => { e.stopPropagation(); }, true);
    });
    chip.addEventListener('click', doHide);
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') doHide(e);
    });

    // 跟在岗位名后面最稳妥：绝对不会和站点自己的「收藏」按钮叠在一起
    const anchor = card.querySelector('[data-automation="jobTitle"]');
    if (anchor && anchor.parentElement) anchor.parentElement.appendChild(chip);
    else { chip.classList.add('corner'); card.appendChild(chip); }
  }

  /**
   * Jobstreet 搜索结果：
   *   点过「✕」的       → 整张卡片不显示
   *   已投递过这条职缺   → 划线置灰 + 灰底
   *   投过同名的 position → 灰底
   *   投过同一家公司     → 公司名标红
   */
  function markJobstreetCards() {
    const ids = recordedJobIds();
    const companies = recordedCompanies();
    const titles = appliedTitles();

    document.querySelectorAll('article[data-job-id]').forEach((card) => {
      const id = card.getAttribute('data-job-id') || '';
      if (!id) return;

      // 隐藏的直接收起来，剩下的标记都不用算了
      const shell = cardShell(card);
      const hide = isHidden(id);
      if (hide !== shell.classList.contains(HIDE_CLASS)) shell.classList.toggle(HIDE_CLASS, hide);
      if (hide) return;

      mountHideChip(card, id);
      markCompanyIn(card, companies);

      const applied = !!ids[id];
      const k = titleKey(norm(card.querySelector('[data-automation="jobTitle"]')));
      // 「已经投递过的相同 position」——这条自己投过、或同名岗位投过，都算
      const same = applied || !!(k && k.length >= 3 && titles[k] && titles[k].length);
      if (same !== card.classList.contains(SAME_CLASS)) card.classList.toggle(SAME_CLASS, same);
      if (applied !== card.classList.contains(MARK_CLASS)) card.classList.toggle(MARK_CLASS, applied);
    });
  }

  /** LinkedIn：Job tracker / 搜索列表 / More jobs 里的卡片 */
  function markLinkedInCards() {
    const ids = recordedJobIds();
    const companies = recordedCompanies();
    const titles = appliedTitles();
    const currentId = getJobId();

    document.querySelectorAll('a[href*="/jobs/view/"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/\/jobs\/view\/(\d{6,})/);
      if (!m) return;
      const id = m[1];
      const card = findCardRoot(a);
      if (norm(card).length < 8) return;         // 纯图标链接，跳过

      // 同名公司标红：当前正在看的这条也标，方便一眼看出投过同一家
      markCompanyIn(card, companies);

      // 同名岗位（不是同一条）已投过 → 整张卡片灰底
      let same = false;
      card.querySelectorAll('p, span, h3, h4, a, strong').forEach((n) => {
        if (same || n.childElementCount > 3) return;
        const k = titleKey(ownText(n) || n.textContent);
        if (k && k.length >= 3 && titles[k]
            && titles[k].some((r) => !(recSite(r) === SITE && r.jobId === id))) same = true;
      });
      if (same !== card.classList.contains(SAME_CLASS)) card.classList.toggle(SAME_CLASS, same);

      if (id === currentId) return;              // 当前正在看的职位不画删除线
      const want = !!ids[id];
      if (want !== card.classList.contains(MARK_CLASS)) {
        card.classList.toggle(MARK_CLASS, want);
      }
    });
  }

  let markTimer = null;
  function markPageCards() {
    if (IS_JS) markJobstreetCards();
    else markLinkedInCards();
  }

  function scheduleMark() {
    clearTimeout(markTimer);
    // 线程是异步渲染的，DOM 一变就顺手重算一次按钮的显隐
    markTimer = setTimeout(() => { markPageCards(); markCurrentTitle(); mountMsgOps(); refreshApplyBtn(); }, 400);
  }

  /* =========================================================================
   * 6.4 站内信：每张会话卡片旁边挂「📥 移到 Other / 🗄 归档」快捷按钮
   *     原本要点卡片上的「三点」再从菜单里选，这两个按钮替你走完这两步。
   * ========================================================================= */

  const MSG_OPS = [
    { kind: 'other',   text: '📥', title: '把这个会话移到 Other（不用再开三点菜单）' },
    { kind: 'archive', text: '🗄', title: '归档这个会话（不用再开三点菜单）' },
  ];

  function mountMsgOps() {
    if (!isMessagingPage()) return;

    document.querySelectorAll('.msg-conversation-card').forEach((card) => {
      if (card.querySelector('.' + OPS_CLASS)) return;                       // 挂过了
      if (!card.querySelector('button.msg-thread-actions__control')) return; // 没有菜单可驱动

      const wrap = document.createElement('span');
      wrap.className = OPS_CLASS;

      MSG_OPS.forEach((op) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = OP_CLASS;
        b.textContent = op.text;
        b.title = op.title;
        b.setAttribute('aria-label', op.title);

        // 按钮落在「点一下就打开会话」的区域里，按下阶段就得把事件截住
        ['mousedown', 'pointerdown', 'touchstart'].forEach((ev) => {
          b.addEventListener(ev, (e) => { e.stopPropagation(); }, true);
        });

        b.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (b.classList.contains('busy')) return;
          b.classList.add('busy');
          try {
            const res = await runCardAction(card, op.kind);
            toast(res.ok ? ('已执行「' + res.label + '」')
                         : ('执行失败：' + res.why + '，请手动操作'));
          } finally {
            b.classList.remove('busy');
          }
        });

        wrap.appendChild(b);
      });

      // 标题行里那块占位（时间戳旁边）是常驻可见的；LinkedIn 自己的「三点」
      // 要 hover 才出来，挂那里的话按钮也会跟着藏起来，所以优先用占位这一块。
      const slot = card.querySelector('.msg-conversation-card__inbox-shortcuts-placeholder')
                || card.querySelector('.msg-conversation-card__inbox-shortcuts');
      if (slot) {
        slot.appendChild(wrap);
      } else {
        wrap.classList.add('corner');
        if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
        card.appendChild(wrap);
      }
    });
  }

  let expandTimer = null;
  function scheduleExpand() {
    clearTimeout(expandTimer);
    expandTimer = setTimeout(expandMoreButtons, 600);
  }

  /* =========================================================================
   * 6.5 GitHub 同步
   *     用 Contents API 整文件覆盖写入 data/records.json。
   *     用 PAT 提交会触发仓库的 workflow，从而自动重建 Pages。
   * ========================================================================= */

  let syncTimer = null;
  let syncing = false;
  let syncQueued = false;
  let dirty = false;        // 本地有改动、还没成功推上去

  function ghReady() { return !!(gh.repo && gh.token); }

  /** 改动还没落到 GitHub 上（没配置同步的话无所谓，不算） */
  function syncPending() { return dirty && gh.auto && ghReady(); }

  /** 记录变化后的自动推送（合并 5 秒内的连续修改） */
  function scheduleSync() {
    dirty = true;
    updateGhBtn();
    if (!gh.auto || !ghReady()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { ghSync(false); }, 5000);
  }

  /* ---- 同步完成前别把页面关了 ------------------------------------------
   * 关闭 / 刷新 / 跳去别的站点都会触发 beforeunload，浏览器会弹自己的
   * 「离开此网站？」确认框（文案由浏览器决定，页面改不了）。
   * 顺手立刻发起一次同步，用户要是选了「留下」，几秒内就同步完了。
   * 站内 SPA 切页面不触发这个事件，但那种情况脚本还活着、同步照跑，不会丢。
   * ------------------------------------------------------------------- */
  window.addEventListener('beforeunload', (e) => {
    if (!syncPending() && !syncing) return;
    if (!syncing) { clearTimeout(syncTimer); ghSync(false); }   // 别等那 5 秒了
    e.preventDefault();
    e.returnValue = '还有改动没同步到 GitHub，等同步完成再离开。';
    return e.returnValue;
  });

  /** UTF-8 字符串 → base64（btoa 只吃 latin1，必须先编码） */
  function b64utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  /**
   * 发请求。优先 GM_xmlhttpRequest：它不受页面 CSP 的 connect-src 限制，
   * 也不需要 CORS 预检；没有该权限时退回 fetch。
   */
  function ghRequest(method, url, body, extraHeaders) {
    const headers = Object.assign({
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': 'Bearer ' + gh.token,
    }, extraHeaders || {});
    if (body) headers['Content-Type'] = 'application/json';
    const payload = body ? JSON.stringify(body) : undefined;

    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: method,
          url: url,
          headers: headers,
          data: payload,
          timeout: 30000,
          onload: (res) => {
            let json = null;
            try { json = JSON.parse(res.responseText); } catch (e) { /* 允许空响应体 */ }
            resolve({ status: res.status, json: json, text: res.responseText });
          },
          onerror: () => reject(new Error('网络请求失败')),
          ontimeout: () => reject(new Error('请求超时')),
        });
      });
    }

    // 和上面 GM 那条路一样给 30 秒上限：卡住不返回的话 syncing 会一直是 true，
    // 后续的改动就再也推不上去了（离开页面的拦截也会一直拦着）
    const ac = (typeof AbortController === 'function') ? new AbortController() : null;
    const killer = ac ? setTimeout(() => ac.abort(), 30000) : null;
    return fetch(url, { method: method, headers: headers, body: payload, signal: ac ? ac.signal : undefined })
      .then((res) => res.text().then((text) => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 同上 */ }
        return { status: res.status, json: json, text: text };
      }))
      .catch((e) => { throw new Error(e && e.name === 'AbortError' ? '请求超时' : (e.message || '网络请求失败')); })
      .finally(() => { if (killer) clearTimeout(killer); });
  }

  /**
   * 取文件当前的 sha。文件不存在返回 null。
   * Contents API 的 GET 走 CDN，刚 PUT 完再读常常拿到旧值，所以必须穿透缓存，
   * 否则下一次 PUT 必然 409。
   */
  async function ghFetchSha(api, branch) {
    const url = api + '?ref=' + encodeURIComponent(branch) + '&_=' + Date.now();
    const res = await ghRequest('GET', url, null, { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' });
    if (res.status === 200 && res.json) return res.json.sha;
    if (res.status === 404) return null;
    throw new Error(ghErrMsg(res));
  }

  function ghApiUrl() {
    const repo = gh.repo.trim().replace(/^\/+|\/+$/g, '');
    const path = (gh.path || 'data/records.json').trim().replace(/^\/+/, '');
    return 'https://api.github.com/repos/' + repo + '/contents/'
         + path.split('/').map(encodeURIComponent).join('/');
  }

  function ghErrMsg(res) {
    const m = res.json && res.json.message;
    if (res.status === 401) return '认证失败（401）：Token 无效或已过期';
    if (res.status === 403) return '被拒绝（403）：Token 没有该仓库的 Contents 写权限' + (m ? ' — ' + m : '');
    if (res.status === 404) return '找不到仓库或路径（404）：检查 owner/repo 是否正确、Token 是否勾选了这个仓库';
    if (res.status === 409) return '版本冲突（409）：远端文件已被改动，重试仍未成功 — ' + (m || '');
    if (res.status === 422) return '提交被拒（422）：分支名可能不存在 — ' + (m || '');
    return '第 ' + res.status + ' 号错误' + (m ? '：' + m : '');
  }

  /** 把当前清单整体写入仓库；manual=true 时给出更详细的反馈 */
  async function ghSync(manual) {
    if (!ghReady()) {
      if (manual) setGhStatus('err', '请先填写仓库和 Token');
      return false;
    }
    if (syncing) { syncQueued = true; return false; }

    syncing = true;
    clearTimeout(syncTimer);
    updateGhBtn('busy');
    if (manual) setGhStatus('', '同步中…');

    try {
      const branch = (gh.branch || 'main').trim();
      const api = ghApiUrl();

      const now = new Date();
      const content = {
        source: 'linkedin-applied-tracker',
        updatedAt: now.toISOString(),
        count: records.length,
        records: records.slice().sort((a, b) => b.ts - a.ts).map((r) => {
          const m = c1Monthly(r.sector, ageFrom(gh.birthday));
          const out = Object.assign({}, r, { epMonthly: m, epAnnual: c1Annual(m) });
          delete out.applicants;     // 这一项已经不再抓取，也不再上看板
          return out;
        }),
        messages: messages.slice().sort((a, b) => b.createdAt - a.createdAt),
        statusOrder: activeStatuses(),
        // 名字可以被改，所以「哪条算落选 / 哪条是默认值」不能让看板和 Worker
        // 再按名字猜，连定义一起推上去
        statusDefs: statusDefs().map((s) => ({
          id: s.id, name: s.name,
          closed: !!s.closed, rejected: !!s.rejected,
          advanced: !!s.advanced, waiting: !!s.waiting,
          role: s.role || '',
        })),
      };
      const body = {
        message: 'chore(records): ' + records.length + ' 条投递记录 / '
               + messages.length + ' 条留言 @ ' + fmtTs(now.getTime()),
        content: b64utf8(JSON.stringify(content, null, 1)),
        branch: branch,
      };

      // 上一次 PUT 回来的 sha 最可靠；没有就去问一次（带缓存穿透）
      let sha = gh.lastSha || await ghFetchSha(api, branch);

      let put = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        body.sha = sha || undefined;
        put = await ghRequest('PUT', api, body);
        if (put.status === 200 || put.status === 201) break;

        // 409 = 手里的 sha 不是最新的（CDN 缓存或别处改过）。重新取一次再试。
        if (put.status === 409 && attempt < 2) {
          sha = await ghFetchSha(api, branch);
          continue;
        }
        throw new Error(ghErrMsg(put));
      }

      // PUT 的响应里带着新文件的 sha，记下来给下次用，省掉一次会读到缓存的 GET
      gh.lastSha = (put.json && put.json.content && put.json.content.sha) || null;
      gh.lastSync = Date.now();
      dirty = false;                 // 推上去了，可以放心关页面
      showSyncBanner();
      gh.lastError = '';
      saveGh();
      updateGhBtn('ok');
      if (manual) {
        setGhStatus('ok', '已推送 ' + records.length + ' 条记录到 '
          + gh.repo + '（' + branch + '）\nGitHub Actions 会自动重建页面，约 1 分钟后生效。');
        toast('已同步到 GitHub');
      }
      return true;
    } catch (e) {
      gh.lastError = e.message || String(e);
      saveGh();
      updateGhBtn('err');
      if (manual) setGhStatus('err', '同步失败：' + gh.lastError);
      else toast('GitHub 同步失败：' + gh.lastError);
      return false;
    } finally {
      syncing = false;
      if (syncQueued) { syncQueued = false; scheduleSync(); }
    }
  }

  /** 同步成功后，把这次新推上去的记录列出来 */
  let syncBannerTimer = null;
  function showSyncBanner() {
    if (!pendingNew.length) return;
    const items = pendingNew.splice(0, pendingNew.length);
    $syncBanner.textContent = '';
    $syncBanner.appendChild(el('b', { text: '✅ 已同步 ' + items.length + ' 条新记录' }));
    items.slice(0, 6).forEach((x) => {
      $syncBanner.appendChild(el('div', { text: '· ' + (x.company || '?') + ' / ' + (x.title || '?') }));
    });
    if (items.length > 6) $syncBanner.appendChild(el('div', { text: '…还有 ' + (items.length - 6) + ' 条' }));
    $syncBanner.hidden = false;
    clearTimeout(syncBannerTimer);
    syncBannerTimer = setTimeout(() => { $syncBanner.hidden = true; }, 6000);
  }

  function setGhStatus(kind, msg) {
    $ghStatus.className = 'status' + (kind ? ' ' + kind : '');
    $ghStatus.textContent = msg || '';
  }

  function updateGhBtn(state) {
    $ghBtn.classList.remove('ok', 'err', 'busy');
    if (state) $ghBtn.classList.add(state);

    if (!ghReady()) {
      $ghBtn.textContent = '☁ 未配置';
      $ghBtn.title = '点击配置 GitHub 同步';
      return;
    }
    if (state === 'busy') { $ghBtn.textContent = '☁ 同步中…'; return; }
    if (state === 'err' || (!state && gh.lastError)) {
      $ghBtn.classList.add('err');
      $ghBtn.textContent = '☁ 失败';
      $ghBtn.title = gh.lastError + '\n点击打开设置';
      return;
    }
    if (!state && syncPending()) {
      $ghBtn.classList.add('busy');
      $ghBtn.textContent = '☁ 待同步';
      $ghBtn.title = '有改动还没推到 GitHub，几秒后自动同步；这期间关页面会被拦一下\n点击打开设置';
      return;
    }
    $ghBtn.classList.add('ok');
    $ghBtn.textContent = '☁ 已同步';
    $ghBtn.title = (gh.lastSync ? '最近同步：' + fmtTs(gh.lastSync) : '尚未同步')
      + '\n仓库：' + gh.repo + '\n点击打开设置';
  }

  function openGhDialog() {
    $ghRepo.value   = gh.repo;
    $ghBranch.value = gh.branch || 'main';
    $ghPath.value   = gh.path || 'data/records.json';
    $ghTg.value     = gh.tgEndpoint || '';
    $ghBoard.value  = gh.boardUrl || '';
    $ghBirth.value  = gh.birthday || '';
    $ghToken.value  = gh.token;
    $ghAuto.checked = !!gh.auto;
    $ghAiEp.value    = gh.aiEndpoint || '';
    $ghAiKey.value   = gh.aiKey || '';
    $ghAiMdl.value   = gh.aiModel || 'claude-opus-5';
    $ghAiAuto.checked = !!gh.aiAuto;
    setGhStatus(gh.lastError ? 'err' : '',
      gh.lastError ? ('上次同步失败：' + gh.lastError)
                   : (gh.lastSync ? '最近同步：' + fmtTs(gh.lastSync) : ''));
    $mask.hidden = false;
    $ghRepo.focus();
  }

  function readGhForm() {
    const before = gh.repo + '|' + gh.branch + '|' + gh.path;

    gh.repo   = $ghRepo.value.trim()
      .replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
    gh.branch = $ghBranch.value.trim() || 'main';
    gh.path   = $ghPath.value.trim() || 'data/records.json';
    gh.token  = $ghToken.value.trim();

    // 换了目标文件，缓存的 sha 就没意义了
    if (before !== (gh.repo + '|' + gh.branch + '|' + gh.path)) gh.lastSha = null;
    gh.tgEndpoint = $ghTg.value.trim().replace(/\/+$/, '');
    gh.boardUrl   = $ghBoard.value.trim();
    gh.birthday   = $ghBirth.value || '';
    gh.auto   = $ghAuto.checked;
    gh.aiEndpoint = $ghAiEp.value.trim().replace(/\/+$/, '');
    gh.aiKey      = $ghAiKey.value.trim();
    gh.aiModel    = $ghAiMdl.value.trim() || 'claude-opus-5';
    gh.aiAuto     = $ghAiAuto.checked;
    saveGh();
    updateGhBtn();
    render();                    // 生日变了，薪资档位要跟着重算
  }

  $ghBtn.addEventListener('click', (e) => { e.stopPropagation(); openGhDialog(); });
  $ghClose.addEventListener('click', () => { $mask.hidden = true; });
  $mask.addEventListener('click', (e) => { if (e.target === $mask) $mask.hidden = true; });
  $ghSaveOnly.addEventListener('click', () => {
    readGhForm();
    setGhStatus('ok', '已保存');
  });
  $ghSave.addEventListener('click', () => {
    readGhForm();
    if (!gh.repo || !gh.token) { setGhStatus('err', '仓库和 Token 都要填'); return; }
    ghSync(true);
  });
  $ghClear.addEventListener('click', () => {
    gh.token = '';
    $ghToken.value = '';
    saveGh();
    updateGhBtn();
    setGhStatus('', 'Token 已从本机清除，自动同步将停止');
  });

  $ghAiFill.addEventListener('click', async () => {
    readGhForm();                       // 先把刚填的中继/Key 存下来
    const blank = records.filter((r) => !r.sector && r.company).length;
    if (!blank) { setGhStatus('', '清单里没有空白的 EP 行业'); return; }
    $ghAiFill.disabled = true;
    setGhStatus('', '正在判定 ' + blank + ' 条…');
    try {
      const n = await fillAllSectors();
      setGhStatus(n ? 'ok' : '', n ? ('已填上 ' + n + ' 条，🤖 标记的记得核对') : '没有填上新的行业');
    } finally {
      $ghAiFill.disabled = false;
    }
  });

  /* =========================================================================
   * 6.6 🤖 用 Claude 判定公司的 EP 所属行业
   *     判定结果只当「预填」：填进去的会标上 🤖，你随时可以在下拉框里改，
   *     改过的会写回缓存，同一家公司之后不会再被模型覆盖。
   *     两条路：优先走 Cloudflare Worker 中继（Key 放在 Worker 的 Secret 里），
   *     没配中继就用本机存的 API Key 直连 api.anthropic.com。
   * ========================================================================= */

  const EP_SECTORS = Object.keys(C1_SALARY);
  const AI_BATCH = 20;          // 一次问多少家公司
  const AI_VERSION = '2023-06-01';

  function aiReady() { return !!(gh.aiEndpoint || gh.aiKey); }

  /** 缓存里已有的判定（手动改过的优先级最高） */
  function cachedSector(company) {
    const hit = sectorCache[companyKey(company)];
    return (hit && EP_SECTORS.indexOf(hit.sector) !== -1) ? hit : null;
  }

  function rememberSector(company, sector, by) {
    const k = companyKey(company);
    if (!k) return;
    if (!sector) { delete sectorCache[k]; saveSectorCache(); return; }
    sectorCache[k] = { sector: sector, by: by || 'ai', ts: Date.now(), name: company };
    saveSectorCache();
  }

  /** POST 一次 Messages API（走中继或直连），返回解析后的 JSON */
  function aiRequest(payload) {
    const viaWorker = !!gh.aiEndpoint;
    const url = viaWorker ? gh.aiEndpoint : 'https://api.anthropic.com/v1/messages';
    const headers = { 'Content-Type': 'application/json' };
    let body;

    if (viaWorker) {
      // Worker 只是个转发壳：Key 在它那边，浏览器这边什么密钥都不带
      if (gh.tgAppKey) headers['X-App-Key'] = gh.tgAppKey;
      body = JSON.stringify({ action: 'ai', payload: payload });
    } else {
      headers['x-api-key'] = gh.aiKey;
      headers['anthropic-version'] = AI_VERSION;
      // 浏览器直连必须显式声明，否则 API 会拒掉带 Origin 的请求
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      body = JSON.stringify(payload);
    }

    const parse = (status, text) => {
      let data = null;
      try { data = JSON.parse(text); } catch (e) { /* 下面统一报错 */ }
      if (status < 200 || status >= 300) {
        const msg = (data && ((data.error && data.error.message) || data.description)) || ('HTTP ' + status);
        throw new Error(msg);
      }
      if (!data) throw new Error('返回的不是 JSON');
      // 中继会把 Messages API 的响应原样放在 result 里
      return data.result || data;
    };

    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST', url: url, headers: headers, data: body, timeout: 60000,
          onload: (res) => {
            try { resolve(parse(res.status, res.responseText)); }
            catch (e) { reject(e); }
          },
          onerror: () => reject(new Error('网络请求失败')),
          ontimeout: () => reject(new Error('请求超时')),
        });
      });
    }
    return fetch(url, { method: 'POST', headers: headers, body: body })
      .then((res) => res.text().then((text) => parse(res.status, text)));
  }

  /**
   * 问一批公司分别属于哪个行业。
   * 用 structured outputs 把答案限死在这 22 个行业里（外加 UNKNOWN），
   * 免得模型自由发挥出一个下拉框里没有的名字。
   */
  async function askSectors(companies) {
    const schema = {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              company: { type: 'string' },
              sector: { type: 'string', enum: EP_SECTORS.concat(['UNKNOWN']) },
            },
            required: ['company', 'sector'],
            additionalProperties: false,
          },
        },
      },
      required: ['results'],
      additionalProperties: false,
    };

    const payload = {
      model: gh.aiModel || 'claude-opus-5',
      max_tokens: 4000,
      system:
        '你在帮人填新加坡 MOM COMPASS C1 的「EP 所属行业」。\n'
        + '给你一批公司名，判断每家公司在新加坡的主营业务落在哪个行业类别，'
        + '只能从给定的类别里选。判断依据是公司实际做什么生意，不是它招什么岗位——'
        + '比如银行招 IT 也算 Banking，猎头公司算 Professional Services。\n'
        + '拿不准、或者公司名太含糊认不出来，就填 UNKNOWN，不要猜。',
      messages: [{
        role: 'user',
        content: '公司名单：\n' + companies.map((c, i) => (i + 1) + '. ' + c).join('\n'),
      }],
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: schema },
      },
    };

    const res = await aiRequest(payload);
    const text = (res.content || [])
      .filter((b) => b && b.type === 'text').map((b) => b.text).join('');
    if (!text) throw new Error('模型没有返回内容');

    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('返回的 JSON 解析失败'); }
    return (data.results || []).filter((r) => r && EP_SECTORS.indexOf(r.sector) !== -1);
  }

  let aiBusy = false;

  /**
   * 给还没填行业的记录补上。
   * quiet=true 时只在真的填上了才吭声（新记录自动判定用）。
   */
  async function fillSectors(targets, quiet) {
    if (!aiReady()) {
      if (!quiet) { toast('先在 ☁ 设置里填 Claude 中继地址或 API Key'); openGhDialog(); }
      return 0;
    }
    if (aiBusy) { if (!quiet) toast('还在判定上一批，稍等'); return 0; }

    const todo = targets.filter((r) => r && !r.sector && r.company);
    if (!todo.length) { if (!quiet) toast('没有需要补的记录'); return 0; }

    // 缓存里已经有的直接用，不必再问模型
    let filled = 0;
    const ask = [];
    const seen = Object.create(null);
    todo.forEach((r) => {
      const hit = cachedSector(r.company);
      if (hit) { r.sector = hit.sector; r.sectorBy = hit.by; filled++; return; }
      const k = companyKey(r.company);
      if (k && !seen[k]) { seen[k] = 1; ask.push(r.company); }
    });

    if (!ask.length) {
      if (filled) { saveRecords(); render(); toast('按缓存补上了 ' + filled + ' 条'); }
      else if (!quiet) toast('没有需要补的记录');
      return filled;
    }

    aiBusy = true;
    if (!quiet) toast('正在判定 ' + ask.length + ' 家公司…');
    try {
      for (let i = 0; i < ask.length; i += AI_BATCH) {
        const batch = ask.slice(i, i + AI_BATCH);
        const out = await askSectors(batch);
        out.forEach((x) => rememberSector(x.company, x.sector, 'ai'));

        todo.forEach((r) => {
          if (r.sector) return;
          const hit = cachedSector(r.company);
          if (hit) { r.sector = hit.sector; r.sectorBy = hit.by; filled++; }
        });
      }
      if (filled) {
        saveRecords();
        render();
        toast('已填上 ' + filled + ' 条行业（🤖 标记的可以自己改）');
      } else if (!quiet) {
        toast('模型也没认出来，留空了');
      }
      return filled;
    } catch (e) {
      if (!quiet) toast('行业判定失败：' + (e.message || e));
      return filled;
    } finally {
      aiBusy = false;
    }
  }

  /** 一键补全清单里所有空白的行业 */
  function fillAllSectors() { return fillSectors(records.slice(), false); }

  /* =========================================================================
   * 6.7 Telegram —— 一键通知全部联系完
   *     和 FDA-TSK 一样：脚本不持有 Bot Token，只把正文 POST 给 Cloudflare Worker，
   *     Token 放在 Worker 的 Secret 里。
   * ========================================================================= */

  function tgSend(text) {
    if (!gh.tgEndpoint) {
      return Promise.reject(new Error('还没有配置 Telegram 中继（☁ GitHub 设置里填 Worker 地址）'));
    }
    const headers = {};
    if (gh.tgAppKey) headers['X-App-Key'] = gh.tgAppKey;

    // fetch 走的是页面自己的 CORS 通道；Worker 已放行 linkedin.com，所以两条路都可能通。
    const viaFetch = () =>
      fetch(gh.tgEndpoint, { method: 'POST', headers: headers, body: new URLSearchParams({ text: text }) })
        .then((res) => res.json().catch(() => ({ ok: false, description: 'HTTP ' + res.status })))
        .then((data) => { if (!data.ok) throw new Error(data.description || 'unknown error'); return data; });

    if (typeof GM_xmlhttpRequest !== 'function') return viaFetch();

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: gh.tgEndpoint,
        headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, headers),
        data: new URLSearchParams({ text: text }).toString(),
        timeout: 30000,
        onload: (res) => {
          let data = null;
          try { data = JSON.parse(res.responseText); } catch (e) { /* 下面统一处理 */ }
          if (data && data.ok) resolve(data);
          else reject(new Error((data && data.description) || ('HTTP ' + res.status)));
        },
        // GM_xmlhttpRequest 被 @connect 白名单挡下时也走这里，退回 fetch 再试一次
        onerror: () => viaFetch().then(resolve, (e) => reject(new Error(e.message || '网络请求失败'))),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  /* =========================================================================
   * 6.75 📢 请求更新状态
   *      发一条提醒到 Telegram；可选把填写内容写回这条记录的 MEMO。
   * ========================================================================= */

  let remindRec = null;
  let remindCloseTimer = null;

  /** 备注框上方那排模板按钮 */
  function renderTplBar() {
    $rmTplBar.textContent = '';
    templates.forEach((t) => {
      if (!t || !t.text) return;
      const chip = el('button', {
        class: 'tplchip', type: 'button',
        title: t.text.length > 120 ? (t.text.slice(0, 120) + '…') : t.text,
        text: t.name || t.text.slice(0, 10),
      });
      chip.addEventListener('click', () => {
        const cur = $rmMemo.value;
        // 已有内容就换行追加，不覆盖用户已经写的东西
        $rmMemo.value = cur.trim() ? (cur.replace(/\s+$/, '') + '\n' + t.text) : t.text;
        $rmMemo.dispatchEvent(new Event('input'));
        $rmMemo.focus();
        $rmMemo.selectionStart = $rmMemo.selectionEnd = $rmMemo.value.length;
      });
      $rmTplBar.appendChild(chip);
    });
    const gear = el('button', { class: 'tplchip gear', type: 'button', title: '编辑模板', text: '⚙ 模板' });
    gear.addEventListener('click', () => openTplManager(TPL_MEMO));
    $rmTplBar.appendChild(gear);
  }

  // 备注模板和推送模板共用这套管理界面，靠 tplTarget 区分
  const TPL_MEMO = {
    title: '🗂 备注模板',
    hint: '这些模板会显示在「请求更新状态」的备注框上方，点一下即可填入。只存在本机。',
    placeholder: '点击后填入备注框的内容',
    get: () => templates,
    set: (v) => { templates = v; saveTemplates(); },
    save: () => saveTemplates(),
    defaults: () => DEFAULT_TEMPLATES,
    onChange: () => renderTplBar(),
  };
  const TPL_PUSH = {
    title: '🗂 推送文字模板',
    hint: '这些模板会显示在「发消息」的输入框上方，点一下即可填入。只存在本机。',
    placeholder: '点击后填入消息框的内容',
    get: () => pushTemplates,
    set: (v) => { pushTemplates = v; savePushTemplates(); },
    save: () => savePushTemplates(),
    defaults: () => DEFAULT_PUSH_TEMPLATES,
    onChange: () => renderPushTplBar(),
  };
  const TPL_MSG = {
    title: '🗂 留言模板',
    hint: '这些模板会显示在「通知板」的输入框上方，点一下即可填入。只存在本机。',
    placeholder: '点击后填入留言框的内容',
    get: () => msgTemplates,
    set: (v) => { msgTemplates = v; saveMsgTemplates(); },
    save: () => saveMsgTemplates(),
    defaults: () => DEFAULT_MSG_TEMPLATES,
    onChange: () => renderMsgTplBar(),
  };
  let tplTarget = TPL_MEMO;

  function renderTplManager() {
    const list = tplTarget.get();
    $tplTitle.textContent = tplTarget.title;
    $tplHint.textContent = tplTarget.hint;
    $tplList.textContent = '';
    if (!list.length) {
      $tplList.appendChild(el('div', { class: 'mempty', text: '还没有模板，点下面的「新增一条」。' }));
      return;
    }
    list.forEach((t, i) => {
      const name = el('input', { type: 'text', class: 'tplname', placeholder: '按钮上显示的短名' });
      name.value = t.name || '';
      name.addEventListener('input', () => { t.name = name.value; tplTarget.save(); });

      const text = el('textarea', { class: 'tpltext', placeholder: tplTarget.placeholder });
      text.value = t.text || '';
      text.addEventListener('input', () => { t.text = text.value; tplTarget.save(); });

      const del = el('button', { class: 'op-btn', type: 'button', title: '删除这条', text: '🗑' });
      del.addEventListener('click', () => {
        list.splice(i, 1);
        tplTarget.save();
        renderTplManager();
        tplTarget.onChange();
      });

      $tplList.appendChild(el('div', { class: 'tplitem' }, [
        el('div', { class: 'tplrow' }, [name, del]),
        text,
      ]));
    });
  }

  function openTplManager(target) {
    tplTarget = target || TPL_MEMO;
    renderTplManager();
    $tplMask.hidden = false;
  }

  $tplAdd.addEventListener('click', () => {
    tplTarget.get().push({ name: '新模板', text: '' });
    tplTarget.save();
    renderTplManager();
    tplTarget.onChange();
    const boxes = $tplList.querySelectorAll('.tplname');
    if (boxes.length) boxes[boxes.length - 1].focus();
  });
  $tplReset.addEventListener('click', () => {
    confirmDialog({
      title: '恢复默认模板？',
      body: '当前的 ' + tplTarget.get().length + ' 条自定义模板会被覆盖。',
      okText: '恢复', danger: true,
    }).then((ok) => {
      if (!ok) return;
      tplTarget.set(tplTarget.defaults().map((t) => Object.assign({}, t)));
      renderTplManager();
      tplTarget.onChange();
    });
  });
  $tplClose.addEventListener('click', () => { $tplMask.hidden = true; tplTarget.onChange(); });
  $tplMask.addEventListener('click', (e) => {
    if (e.target === $tplMask) { $tplMask.hidden = true; tplTarget.onChange(); }
  });

  /**
   * 组装要发送的正文。预览和真正发送都走这里，
   * 免得预览和实际发出去的内容对不上。
   */
  function buildRemindText(rec, note) {
    const next = $rmNewStatus.value;
    const changed = next && next !== rec.status;

    const lines = [
      TG_PREFIX + ' 状态更新请求',
      '处理人：' + $rmWho.value,
    ];
    if ($rmPriority.value && $rmPriority.value !== '无') {
      lines.push('📍优先级：' + $rmPriority.value);
    }
    lines.push(
      '',
      '公司：' + (rec.company || '—'),
      '岗位：' + (rec.title || '—'),
      '投递时间：' + fmtTs(rec.ts),
      '链接：' + (rec.jobUrl || '—'),
      changed ? ('状态变更：' + rec.status + ' → ' + next) : ('当前状态：' + rec.status)
    );
    if ($rmLink.checked) {
      const url = boardLinkFor(rec);
      if (url) lines.push('看板：' + url);
    }
    if ($rmWith.checked && rec.memo) lines.push('', '现有 MEMO：' + rec.memo);
    lines.push('', '🟢 备注：' + (note || '(无)'));

    const text = lines.join('\n');
    if (text.length <= TG_LIMIT) return text;

    // 超长：MEMO 全文不塞进消息里，改成给一条指向该项目 MEMO 详情页的链接。
    // 没配看板地址就只能截断，至少别把消息发失败。
    const page = memoPageFor(rec);
    const trimmed = lines.filter((l) => l.indexOf('现有 MEMO：') !== 0);
    const blocks = memoBlocks(rec);
    if (page) {
      trimmed.push('', '📄 MEMO 共 ' + blocks.length + ' 条，太长放不下，点这里看全文：', page);
    } else if (blocks.length) {
      trimmed.push('', '📄 MEMO 最新一条：' + blocks[0].text.slice(0, 300)
                     + (blocks[0].text.length > 300 ? '…' : ''));
    }
    const out = trimmed.join('\n');
    return out.length <= TG_LIMIT ? out : (out.slice(0, TG_LIMIT - 20) + '\n…（已截断）');
  }

  /** 该记录的 MEMO 详情页（看板上打开就直接弹出这条的 MEMO 时间轴） */
  function memoPageFor(rec) {
    const base = (gh.boardUrl || '').trim();
    if (!base || !rec.jobId) return '';
    return base.replace(/\/+$/, '/').replace(/([^/])$/, '$1/') + '#memo-' + rec.jobId;
  }

  /** 看板上这一条的直达链接；没有 jobId 就没法定位，返回空 */
  function boardLinkFor(rec) {
    const base = (gh.boardUrl || '').trim();
    if (!base || !rec.jobId) return '';
    return base.replace(/\/+$/, '/') .replace(/([^/])$/, '$1/') + '#job-' + rec.jobId;
  }

  function updateRemindPreview() {
    if (!remindRec) return;
    const note = $rmMemo.value.trim();
    const text = buildRemindText(remindRec, note);
    $rmInfo.textContent = text;

    const over = text.length > TG_LIMIT;
    $rmCount.textContent = text.length + ' / ' + TG_LIMIT + ' 字';
    $rmCount.classList.toggle('over', over);

    // 提示这次操作会对这条记录做什么
    const hints = [];
    if ($rmNewStatus.value && $rmNewStatus.value !== remindRec.status) {
      hints.push('发送后状态将改为：' + $rmNewStatus.value);
    }
    if ($rmReplace.checked) {
      hints.push(note ? ('发送后 MEMO 将变为：' + note) : '勾了替换就必须填备注');
    } else if ($rmAppend.checked) {
      hints.push(note ? ('发送后这段会追加到 MEMO 末尾：' + memoStamp() + note) : '勾了追加就必须填备注');
    }
    let hint = hints.join('\n');
    // 超长时 buildRemindText 已经自动改成「发 MEMO 详情页链接」，这里只说明一下
    if (text.indexOf('📄 MEMO 共') !== -1) {
      hint = (hint ? hint + '\n' : '')
           + '内容超过 Telegram 单条上限，已自动改为发送 MEMO 详情页的链接。';
    } else if (over) {
      hint = (hint ? hint + '\n' : '')
           + '超过 Telegram 单条上限，发不出去 —— 取消勾选「附上 MEMO」或把备注写短一些。';
    }
    $rmHint.textContent = hint;
    $rmHint.classList.toggle('warn', over || (($rmAppend.checked || $rmReplace.checked) && !note));

    $rmSend.disabled = over;
  }

  function openRemind(rec) {
    clearTimeout(remindCloseTimer);   // 上一次发送成功后的延时关闭，别把新开的窗关掉
    remindRec = rec;
    $rmWho.value = 'XR ball';
    $rmPriority.value = '无';
    $rmNewStatus.textContent = '';     // 顺序可能被改过，每次重建
    activeStatuses().forEach((x) => $rmNewStatus.appendChild(el('option', { value: x, text: x })));
    $rmNewStatus.value = rec.status;   // 默认保持原状态
    $rmMemo.value = '';
    $rmAppend.checked = false;
    $rmReplace.checked = false;
    $rmWith.checked = false;           // 默认不带 MEMO，与看板一致
    $rmLink.checked = !!boardLinkFor(rec);   // 能定位就默认带上
    $rmState.className = 'status';
    $rmState.textContent = '';
    $rmSend.disabled = false;
    renderTplBar();
    updateRemindPreview();
    $rmMask.hidden = false;
    $rmMemo.focus();
  }

  // 追加与替换是互斥的
  $rmAppend.addEventListener('change', () => { if ($rmAppend.checked) $rmReplace.checked = false; });
  $rmReplace.addEventListener('change', () => { if ($rmReplace.checked) $rmAppend.checked = false; });

  // 任何输入都要让预览跟着变
  [$rmWho, $rmPriority, $rmNewStatus, $rmAppend, $rmReplace, $rmWith, $rmLink].forEach((n) => n.addEventListener('change', updateRemindPreview));
  $rmMemo.addEventListener('input', updateRemindPreview);

  $rmCancel.addEventListener('click', () => { $rmMask.hidden = true; });
  $rmMask.addEventListener('click', (e) => { if (e.target === $rmMask) $rmMask.hidden = true; });

  $rmSend.addEventListener('click', async () => {
    if (!remindRec) return;
    const rec = remindRec;
    const note = $rmMemo.value.trim();

    if (($rmAppend.checked || $rmReplace.checked) && !note) {
      $rmState.className = 'status err';
      $rmState.textContent = '要写回 MEMO 的话，备注不能为空';
      return;
    }

    $rmSend.disabled = true;
    $rmState.className = 'status';
    $rmState.textContent = '发送中…';
    try {
      await tgSend(buildRemindText(rec, note));   // 与预览完全同一份内容

      // 发送成功后才写回记录，避免发失败却改了数据
      const done = [];
      const next = $rmNewStatus.value;
      if (next && next !== rec.status) {
        rec.status = next;
        done.push('状态已改为「' + next + '」');
      }
      if ($rmReplace.checked) {
        setMemoBlocks(rec, [{ ts: Date.now(), text: note }]);
        done.push('MEMO 已替换');
      } else if ($rmAppend.checked) {
        addMemoBlock(rec, note);
        done.push('MEMO 已追加');
      }
      if (done.length) {
        touch(rec);
        saveRecords();
        render();               // 状态变了会影响排序与划线
        flashRow(rec.id);
        markPageCards();
      }

      const changed = done.join('，');
      $rmState.className = 'status ok';
      $rmState.textContent = '已发送到 Telegram 群' + (changed ? ('，' + changed) : '');
      toast('提醒已发送' + (changed ? ('（' + changed + '）') : ''));
      remindCloseTimer = setTimeout(() => { $rmMask.hidden = true; }, 900);
    } catch (e) {
      $rmState.className = 'status err';
      $rmState.textContent = '发送失败：' + (e.message || e);
      $rmSend.disabled = false;
    }
  });

  /* =========================================================================
   * 6.77 📝 MEMO 编辑（弹窗）
   * ========================================================================= */

  let memoRec = null;
  let memoCloseTimer = null;

  /**
   * 输入框随内容长高：先归零再按 scrollHeight 撑开。
   * 撑到视口一半多就打住，改成框内滚动，免得弹窗高过屏幕。
   * 元素处于 display:none 时量不到 scrollHeight，所以要在弹窗显示之后再调。
   */
  function autoGrow(ta) {
    const max = Math.max(140, Math.round(window.innerHeight * 0.55));
    ta.style.height = 'auto';
    const h = Math.min(ta.scrollHeight + 2, max);
    ta.style.height = h + 'px';
    ta.style.overflowY = (ta.scrollHeight + 2 > max) ? 'auto' : 'hidden';
  }

  $meText.addEventListener('input', () => autoGrow($meText));

  /** 把已有的 MEMO 按时间从新到旧铺成一块块 */
  function renderMemoLog(rec) {
    $meLog.textContent = '';
    const blocks = memoBlocks(rec);
    if (!blocks.length) {
      $meLog.appendChild(el('div', { class: 'mempty', text: '还没有 MEMO。' }));
      return;
    }
    blocks.forEach((b, i) => {
      const del = el('button', { class: 'op-btn', type: 'button', title: '删掉这一条', text: '🗑' });
      del.addEventListener('click', () => {
        confirmDialog({
          title: '删掉这一条 MEMO？',
          body: memoStamp(b.ts) + '\n' + b.text,
          okText: '删除', danger: true,
        }).then((ok) => {
          if (!ok) return;
          setMemoBlocks(rec, memoBlocks(rec).filter((x) => !(x.ts === b.ts && x.text === b.text)));
          touch(rec);
          saveRecords();
          render();
          renderMemoLog(rec);
          toast('已删掉一条 MEMO');
        });
      });
      $meLog.appendChild(el('div', { class: 'memoitem' + (i === 0 ? ' latest' : '') }, [
        el('div', { class: 'memohd' }, [
          el('span', { class: 'memots', text: fmtTs(b.ts) }),
          i === 0 ? el('span', { class: 'memotag', text: '最新' }) : null,
          del,
        ]),
        el('div', { class: 'memobody', text: b.text }),
      ]));
    });
  }

  function openMemoDialog(rec) {
    clearTimeout(memoCloseTimer);
    memoRec = rec;
    $meText.value = '';
    renderMemoLog(rec);
    $mePush.checked = false;
    $meState.className = 'status';
    $meState.textContent = '';
    $meInfo.textContent = (rec.company || '—') + ' / ' + (rec.title || '—')
      + '\n投递时间：' + fmtTs(rec.ts) + '　当前状态：' + rec.status;
    $meSave.disabled = false;
    $meMask.hidden = false;
    autoGrow($meText);           // 已有的长备注一打开就是展开的
    $meText.focus();
  }

  $meCancel.addEventListener('click', () => { $meMask.hidden = true; });
  // 刻意不监听遮罩上的点击：MEMO 写到一半点到背景就没了太亏，
  // 只有「取消」（和保存成功）才关。
  $meMask.addEventListener('click', (e) => { e.stopPropagation(); });

  $meSave.addEventListener('click', async () => {
    if (!memoRec) return;
    const rec = memoRec;
    const text = $meText.value.trim();
    if (!text) {
      $meState.className = 'status err';
      $meState.textContent = '先写点内容再追加（想删旧的用每条右边的 🗑）';
      return;
    }

    addMemoBlock(rec, text);
    touch(rec);
    saveRecords();
    render();
    flashRow(rec.id);
    $meText.value = '';
    renderMemoLog(rec);
    autoGrow($meText);

    if (!$mePush.checked) {
      $meMask.hidden = true;
      toast('MEMO 已追加');
      return;
    }

    $meSave.disabled = true;
    $meState.className = 'status';
    $meState.textContent = '推送中…';
    try {
      await tgSend([
        TG_PREFIX + ' MEMO 更新',
        '',
        '公司：' + (rec.company || '—'),
        '岗位：' + (rec.title || '—'),
        '链接：' + (rec.jobUrl || '—'),
        '当前状态：' + rec.status,
        '',
        'MEMO：' + text,
      ].join('\n'));
      $meState.className = 'status ok';
      $meState.textContent = 'MEMO 已追加并推送到 Telegram';
      toast('MEMO 已追加并推送');
      memoCloseTimer = setTimeout(() => { $meMask.hidden = true; }, 900);
    } catch (e) {
      $meState.className = 'status err';
      $meState.textContent = 'MEMO 已追加，但推送失败：' + (e.message || e);
      $meSave.disabled = false;
    }
  });

  /* =========================================================================
   * 6.78 🕐 跟进提醒
   *      给某条记录挑一个日期，到了那天打开页面就弹一个必须手动关掉的全屏提示，
   *      同时尽量发一条 Chrome 通知。日期存在记录上，会跟着同步到看板。
   * ========================================================================= */

  let fuRec = null;
  // 已经弹过并被手动关掉的：{ '<记录id>@<提醒日期>': 关掉的时间 }
  let fuDone = store.get(K_FUD, null);
  if (!fuDone || typeof fuDone !== 'object' || Array.isArray(fuDone)) fuDone = {};
  const saveFuDone = () => store.set(K_FUD, fuDone);
  const fuKey = (r) => r.id + '@' + (r.followUpAt || 0);

  /** <input type="date"> 要的 YYYY-MM-DD；空值就是没设过 */
  function fuDateValue(ts) { return ts ? fmtDate(ts) : ''; }

  /** 日期字符串 → 当天 0 点的毫秒（本地时区） */
  function fuParseDate(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
    if (!m) return 0;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function renderFuQuick() {
    $fuQuick.textContent = '';
    [['明天', 1], ['3 天后', 3], ['1 周后', 7], ['2 周后', 14], ['1 个月后', 30]].forEach(([label, days]) => {
      const chip = el('button', { class: 'tplchip', type: 'button', text: label });
      chip.addEventListener('click', () => {
        $fuDate.value = fmtDate(startOfToday() + days * 86400000);
      });
      $fuQuick.appendChild(chip);
    });
  }

  function openFollowUp(rec) {
    fuRec = rec;
    $fuInfo.textContent = (rec.company || '—') + ' / ' + (rec.title || '—')
      + '\n投递时间：' + fmtTs(rec.ts) + '　当前状态：' + rec.status;
    $fuDate.value = fuDateValue(rec.followUpAt);
    $fuNote.value = rec.followUpNote || '';
    $fuState.className = 'status';
    $fuState.textContent = '';
    $fuClear.hidden = !rec.followUpAt;
    renderFuQuick();
    $fuMask.hidden = false;
    $fuDate.focus();
  }

  $fuSave.addEventListener('click', () => {
    if (!fuRec) return;
    const at = fuParseDate($fuDate.value);
    if (!at) {
      $fuState.className = 'status err';
      $fuState.textContent = '请先选一个日期';
      return;
    }
    fuRec.followUpAt = at;
    fuRec.followUpNote = $fuNote.value.trim();
    // 改了日期就当成新的一次提醒，之前关掉的记录不影响它
    touch(fuRec);
    saveRecords();
    render();
    flashRow(fuRec.id);
    $fuMask.hidden = true;
    toast('跟进提醒已设为 ' + fmtDate(at));
  });

  $fuClear.addEventListener('click', () => {
    if (!fuRec) return;
    fuRec.followUpAt = 0;
    fuRec.followUpNote = '';
    touch(fuRec);
    saveRecords();
    render();
    $fuMask.hidden = true;
    toast('已清除跟进提醒');
  });

  $fuCancel.addEventListener('click', () => { $fuMask.hidden = true; });
  $fuMask.addEventListener('click', (e) => { if (e.target === $fuMask) $fuMask.hidden = true; });

  /** 今天（或更早）该跟进、且这一轮还没被关掉的记录 */
  function dueFollowUps() {
    const today = startOfToday();
    return records.filter((r) => r && r.followUpAt && r.followUpAt <= today && !fuDone[fuKey(r)])
      .sort((a, b) => a.followUpAt - b.followUpAt);
  }

  let fuNotified = false;
  function checkFollowUps() {
    const due = dueFollowUps();
    if (!due.length) { $fuAlert.hidden = true; return; }

    $fuAlertList.textContent = '';
    due.forEach((r) => {
      const job = r.jobUrl
        ? el('a', { class: 'fujob', href: r.jobUrl, target: '_blank', rel: 'noopener',
                    text: (r.company || '—') + ' / ' + (r.title || '—') })
        : el('span', { class: 'fujob', text: (r.company || '—') + ' / ' + (r.title || '—') });
      const kids = [job, el('div', { class: 'fumeta',
        text: '提醒日期：' + fmtDate(r.followUpAt)
            + '　当前状态：' + r.status
            + '　投递于 ' + fmtTs(r.ts).slice(0, 10) })];
      if (r.followUpNote) kids.push(el('div', { class: 'funote', text: r.followUpNote }));
      $fuAlertList.appendChild(el('div', { class: 'fuitem' }, kids));
    });
    $fuAlert.hidden = false;

    // Chrome 通知：只在这次加载里发一条，权限没给就算了
    if (!fuNotified && typeof Notification !== 'undefined') {
      fuNotified = true;
      const fire = () => {
        try {
          const n = new Notification('到了跟进提醒时间（' + due.length + ' 项）', {
            body: due.map((r) => (r.company || '—') + ' / ' + (r.title || '—')).join('\n').slice(0, 200),
            tag: 'lat-followup',
          });
          n.onclick = () => { window.focus(); n.close(); };
        } catch (e) { /* 通知失败不影响页面上的全屏提示 */ }
      };
      if (Notification.permission === 'granted') fire();
      else if (Notification.permission === 'default') {
        try { Notification.requestPermission().then((p) => { if (p === 'granted') fire(); }); }
        catch (e) { /* 老浏览器的回调式 API */ }
      }
    }
  }

  // 只有这个按钮能关掉；关掉就记下来，同一天不再反复弹
  $fuAlertOk.addEventListener('click', () => {
    dueFollowUps().forEach((r) => { fuDone[fuKey(r)] = Date.now(); });
    saveFuDone();
    $fuAlert.hidden = true;
  });

  /* =========================================================================
   * 6.79 ✉ 直接发一条文字消息到 Telegram 群
   * ========================================================================= */

  function buildPushText(note) {
    // Worker 只放行以 TG_PREFIX 开头的正文，所以前缀是必须的
    return TG_PREFIX + ' 消息\n\n' + (note || '');
  }

  function updatePushPreview() {
    const text = buildPushText($pshText.value.trim());
    $pshInfo.textContent = text;
    const over = text.length > TG_LIMIT;
    $pshCount.textContent = text.length + ' / ' + TG_LIMIT + ' 字';
    $pshCount.classList.toggle('over', over);
    $pshSend.disabled = over || !$pshText.value.trim();
  }

  function renderPushTplBar() {
    $pshTplBar.textContent = '';
    pushTemplates.forEach((t) => {
      if (!t || !t.text) return;
      const chip = el('button', {
        class: 'tplchip', type: 'button',
        title: t.text.length > 120 ? (t.text.slice(0, 120) + '…') : t.text,
        text: t.name || t.text.slice(0, 10),
      });
      chip.addEventListener('click', () => {
        const cur = $pshText.value;
        $pshText.value = cur.trim() ? (cur.replace(/\s+$/, '') + '\n' + t.text) : t.text;
        updatePushPreview();
        $pshText.focus();
        $pshText.selectionStart = $pshText.selectionEnd = $pshText.value.length;
      });
      $pshTplBar.appendChild(chip);
    });
    const gear = el('button', { class: 'tplchip gear', type: 'button', title: '编辑模板', text: '⚙ 模板' });
    gear.addEventListener('click', () => openTplManager(TPL_PUSH));
    $pshTplBar.appendChild(gear);
  }

  function openPushDialog() {
    $pshText.value = '';
    $pshState.className = 'status';
    $pshState.textContent = '';
    renderPushTplBar();
    updatePushPreview();
    $pshMask.hidden = false;
    $pshText.focus();
  }

  $pshText.addEventListener('input', updatePushPreview);
  $pshCancel.addEventListener('click', () => { $pshMask.hidden = true; });
  $pshMask.addEventListener('click', (e) => { if (e.target === $pshMask) $pshMask.hidden = true; });

  $pshSend.addEventListener('click', async () => {
    const note = $pshText.value.trim();
    if (!note) return;
    $pshSend.disabled = true;
    $pshState.className = 'status';
    $pshState.textContent = '发送中…';
    try {
      await tgSend(buildPushText(note));
      $pshState.className = 'status ok';
      $pshState.textContent = '已发送到 Telegram 群';
      toast('已发送');
      setTimeout(() => { $pshMask.hidden = true; }, 900);
    } catch (e) {
      $pshState.className = 'status err';
      $pshState.textContent = '发送失败：' + (e.message || e);
      $pshSend.disabled = false;
    }
  });

  /* =========================================================================
   * 6.8 通知板 —— 写给 index.html 看板的留言
   *     和投递记录一起推送到 records.json 的 messages 字段。
   * ========================================================================= */

  /** 留言框上方那排模板按钮 */
  function renderMsgTplBar() {
    $msgTplBar.textContent = '';
    msgTemplates.forEach((t) => {
      if (!t || !t.text) return;
      const chip = el('button', {
        class: 'tplchip', type: 'button',
        title: t.text.length > 120 ? (t.text.slice(0, 120) + '…') : t.text,
        text: t.name || t.text.slice(0, 10),
      });
      chip.addEventListener('click', () => {
        const cur = $msgInput.value;
        $msgInput.value = cur.trim() ? (cur.replace(/\s+$/, '') + '\n' + t.text) : t.text;
        $msgInput.focus();
        $msgInput.selectionStart = $msgInput.selectionEnd = $msgInput.value.length;
      });
      $msgTplBar.appendChild(chip);
    });
    const gear = el('button', { class: 'tplchip gear', type: 'button', title: '编辑模板', text: '⚙ 模板' });
    gear.addEventListener('click', () => openTplManager(TPL_MSG));
    $msgTplBar.appendChild(gear);
  }

  /** 某条留言在看板上的直达链接（看板会滚过去并高亮它） */
  function msgLinkFor(m) {
    const base = (gh.boardUrl || '').trim();
    if (!base || !m.id) return '';
    return base.replace(/\/+$/, '/').replace(/([^/])$/, '$1/') + '#msg-' + m.id;
  }

  function renderMessages() {
    $msgList.textContent = '';
    $msgCount.textContent = '(' + messages.length + ')';
    if (!messages.length) {
      $msgList.appendChild(el('div', { class: 'mempty', text: '还没有留言。写一条，同步后会出现在看板的通知板里。' }));
      return;
    }
    const sorted = messages.slice().sort((a, b) => b.createdAt - a.createdAt);
    const frag = document.createDocumentFragment();
    sorted.forEach((m) => {
      const body = el('div', { class: 'mtext', text: m.text });
      let meta = '追加于 ' + fmtTs(m.createdAt);
      if (m.editedAt) meta += ' · 编辑于 ' + fmtTs(m.editedAt);

      const link = el('button', { class: 'op-btn', type: 'button',
                                  title: '复制这条留言的直达链接', text: '🔗' });
      const push = el('button', { class: 'op-btn', type: 'button', title: '推送这条到 Telegram', text: '📢' });
      const edit = el('button', { class: 'op-btn', type: 'button', title: '编辑', text: '✎' });
      const del  = el('button', { class: 'op-btn', type: 'button', title: '删除', text: '🗑' });
      const item = el('div', { class: 'mitem' }, [
        body,
        el('div', { class: 'mmeta' }, [
          el('span', { text: meta }),
          el('span', { class: 'mops' }, [link, push, edit, del]),
        ]),
      ]);

      link.addEventListener('click', () => {
        const url = msgLinkFor(m);
        if (!url) { toast('先在 ☁ GitHub 设置里填看板地址'); return; }
        copyToClipboard(url).then((ok) => toast(ok ? ('已复制链接：' + url) : '复制失败'));
      });

      push.addEventListener('click', async () => {
        if (!gh.tgEndpoint) { toast('先在 ☁ GitHub 设置里填 Telegram 中继地址'); return; }
        push.disabled = true;
        const stamp = m.editedAt ? (fmtTs(m.createdAt) + '（编辑于 ' + fmtTs(m.editedAt) + '）') : fmtTs(m.createdAt);
        try {
          await tgSend(TG_PREFIX + ' 通知板\n' + stamp + '\n\n' + m.text);
          toast('已推送到 Telegram');
        } catch (e) {
          toast('推送失败：' + (e.message || e));
        } finally {
          push.disabled = false;
        }
      });

      edit.addEventListener('click', () => {
        const ta = el('textarea', { class: 'medit' });
        ta.value = m.text;
        const save   = el('button', { class: 'op-btn', type: 'button', title: '保存', text: '✔' });
        const cancel = el('button', { class: 'op-btn', type: 'button', title: '取消', text: '✕' });
        item.textContent = '';
        item.appendChild(ta);
        item.appendChild(el('div', { class: 'mmeta' }, [
          el('span', { text: meta }),
          el('span', { class: 'mops' }, [save, cancel]),
        ]));
        ta.focus();
        save.addEventListener('click', () => {
          const t = ta.value.trim();
          if (!t) { toast('内容不能为空'); return; }
          if (t !== m.text) { m.text = t; m.editedAt = Date.now(); saveMessages(); toast('留言已更新'); }
          renderMessages();
        });
        cancel.addEventListener('click', renderMessages);
      });

      del.addEventListener('click', () => {
        confirmDialog({
          title: '删除这条留言？', body: m.text.slice(0, 120), okText: '删除', danger: true,
        }).then((ok) => {
          if (!ok) return;
          deleted[m.id] = Date.now();     // 立墓碑，否则合并时会被别的标签页收回来
          saveDeleted();
          messages = messages.filter((x) => x.id !== m.id);
          saveMessages();
          renderMessages();
          toast('已删除');
        });
      });

      frag.appendChild(item);
    });
    $msgList.appendChild(frag);
  }

  function addMessage() {
    const t = $msgInput.value.trim();
    if (!t) { toast('先写点什么'); return; }
    const now = Date.now();
    const msg = {
      id: 'g' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      text: t, createdAt: now, editedAt: 0, author: '',
    };
    messages.push(msg);
    saveMessages();
    $msgInput.value = '';
    renderMessages();

    if (!$msgAutoLink.checked) { toast('已追加留言，同步后会出现在看板上'); return; }
    const url = msgLinkFor(msg);
    if (!url) { toast('已追加留言（没填看板地址，链接复制不了）'); return; }
    copyToClipboard(url).then((ok) => {
      toast(ok ? ('已追加留言，链接已复制：' + url) : '已追加留言，但链接复制失败');
    });
  }

  function openMsgPanel() {
    renderMsgTplBar();
    renderMessages();
    $msgMask.hidden = false;
    $msgInput.focus();
  }

  $msgAdd.addEventListener('click', addMessage);
  $msgClose.addEventListener('click', () => { $msgMask.hidden = true; });
  $msgMask.addEventListener('click', (e) => { if (e.target === $msgMask) $msgMask.hidden = true; });

  /* =========================================================================
   * 6.9 自动展开页面里的 more 按钮
   * ========================================================================= */

  // LinkedIn 自己的「展开长文本」控件，这些是明确安全的
  const EXPAND_SELECTORS = [
    'button[data-testid="expandable-text-button"]',
    'button.inline-show-more-text__button',
    'button.show-more-less-html__button',
  ].join(',');

  // 通用兜底只认这几种写法，且必须整串匹配。
  // 刻意不收「more」「More …」——「More like this」「More from …」这类是导航，
  // 点下去会直接跳到 feed 动态页，之前就是这么误跳的。
  const MORE_EXACT = /^(…\s*)?(see\s+more|show\s+more|…\s*more|显示更多|查看更多|展开全文|もっと見る|続きを読む)$/i;

  /**
   * 这个按钮点下去只会展开正文，不会导航吗？
   * 判定从严：宁可少展开，也不能把页面点走。
   */
  function isSafeExpandButton(b) {
    if (b.tagName !== 'BUTTON') return false;        // 绝不点 a，链接必然跳转
    if (b.closest('a')) return false;                // 套在链接里的按钮，冒泡上去照样跳
    // 不写 type 的 <button> 默认就是 submit，只有在表单里才真会提交，
    // 所以判表单即可；照 type 判会把绝大多数正常按钮也误挡掉。
    if (b.closest('form')) return false;
    if (b.getAttribute('aria-haspopup')) return false;   // 菜单/弹窗触发器
    if (b.matches(EXPAND_SELECTORS)) return true;

    if (!MORE_EXACT.test(norm(b))) return false;
    // aria-label 更能说明真实意图，它要是别的意思就别碰
    const label = (b.getAttribute('aria-label') || '').trim();
    if (label && !MORE_EXACT.test(label)) return false;
    return true;
  }

  /**
   * 替脚本自己发起的点击兜底：这一下点击期间，任何链接的默认跳转都拦掉。
   * click() 是同步派发的，所以装/卸监听器包住它就够了。
   * 用户自己的点击不经过这里，不受影响。
   */
  function safeClick(node) {
    const guard = (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (a) e.preventDefault();
    };
    document.addEventListener('click', guard, true);
    try {
      node.click();
      return true;
    } catch (e) {
      return false;
    } finally {
      document.removeEventListener('click', guard, true);
    }
  }

  function expandMoreButtons() {
    if (!isJobPage()) return 0;
    let clicked = 0;
    document.querySelectorAll('button').forEach((b) => {
      if (b.dataset.latExpanded === '1') return;
      if (b.getAttribute('aria-hidden') === 'true' && !b.offsetParent) return;
      if (!isSafeExpandButton(b)) return;
      b.dataset.latExpanded = '1';
      if (safeClick(b)) clicked++;
    });
    return clicked;
  }

  /* =========================================================================
   * 7. 事件绑定
   * ========================================================================= */

  $applyBt.addEventListener('click', (e) => {
    e.stopPropagation();
    if ($bar.dataset.dragged === '1') return;   // 刚才是拖拽，不当作点击
    onApplyButton();
  });

  $toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if ($bar.dataset.dragged === '1') return;
    setPanelHidden(!ui.panel.hidden);
  });

  $syncBt.addEventListener('click', (e) => {
    e.stopPropagation();
    if ($bar.dataset.dragged === '1') return;
    if (!ghReady()) { openGhDialog(); return; }   // 没配置就先让人配置
    ghSync(true);
  });

  $boardBt.addEventListener('click', (e) => {
    e.stopPropagation();
    if ($bar.dataset.dragged === '1') return;
    openMsgPanel();
  });

  $pushBt.addEventListener('click', (e) => {
    e.stopPropagation();
    if ($bar.dataset.dragged === '1') return;
    if (!gh.tgEndpoint) { toast('先在 ☁ GitHub 设置里填 Telegram 中继地址'); openGhDialog(); return; }
    openPushDialog();
  });

  // 直接执行 LinkedIn 上的操作，不弹窗、不推 Telegram
  [[$otherBt, 'other'], [$archiveBt, 'archive']].forEach(([btn, kind]) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if ($bar.dataset.dragged === '1') return;
      const label = THREAD_ACTIONS[kind].label;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '执行中…';
      try {
        const res = await runThreadAction(kind);
        toast(res.ok ? ('已执行「' + res.label + '」') : ('执行失败：' + res.why + '，请手动操作'));
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });

  root.querySelectorAll('.hdr .act').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'order')  openOrderDialog();
      else if (act === 'hidden') openHiddenDialog();
      else if (act === 'sector') fillAllSectors();
      else if (act === 'csv')    exportCSV();
      else if (act === 'json')   exportJSON();
      else if (act === 'import') importJSON();
      else if (act === 'hide')   setPanelHidden(true);
    });
  });

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('显示 / 隐藏「已递交清单」', () => setPanelHidden(!ui.panel.hidden));
    GM_registerMenuCommand('GitHub 同步设置', () => { setPanelHidden(false); openGhDialog(); });
    GM_registerMenuCommand('立即同步到 GitHub', () => { setPanelHidden(false); openGhDialog(); ghSync(true); });
    GM_registerMenuCommand('已隐藏的职位（✕ 不看）', () => { setPanelHidden(false); openHiddenDialog(); });
    GM_registerMenuCommand('🤖 补全空白的 EP 行业', () => { setPanelHidden(false); fillAllSectors(); });
    GM_registerMenuCommand('导出 CSV', exportCSV);
    GM_registerMenuCommand('导出 JSON', exportJSON);
    GM_registerMenuCommand('导入 JSON', importJSON);
    GM_registerMenuCommand('重置悬浮位置', () => {
      ui = JSON.parse(JSON.stringify(DEFAULT_UI));
      applyBarPos(); applyPanelBox(); saveUI();
    });
    GM_registerMenuCommand('清空全部记录', () => {
      confirmDialog({
        title: '清空全部记录？',
        body: '共 ' + records.length + ' 条，此操作不可撤销。',
        okText: '全部清空', danger: true,
      }).then((ok) => {
        if (!ok) return;
        const now = Date.now();
        records.forEach((r) => { if (r && r.id) deleted[r.id] = now; });
        saveDeleted();
        records = [];
        saveRecords();
        render();
        markPageCards();
        toast('已清空');
      });
    });
  }

  /* =========================================================================
   * 7.5 🌉 看板页回写桥
   *     index.html 是 GitHub Pages 上的静态页，手里没有 PAT，改不了 records.json。
   *     所以它把「设置跟进提醒」这类操作写进自己的 localStorage 待办队列，
   *     由这个脚本（在看板页也会跑）取出来合并进本地记录，再走原有的同步推回去。
   * ========================================================================= */

  /** 看板页排队的操作 → 本地记录。返回实际改动的条数 */
  function drainBoardOutbox() {
    let ops = [];
    try { ops = JSON.parse(localStorage.getItem(BOARD_OUTBOX) || '[]'); } catch (e) { ops = []; }
    if (!Array.isArray(ops) || !ops.length) return 0;

    const done = [];
    let changed = 0;
    ops.forEach((op) => {
      if (!op || !op.jobId) { done.push(op && op.opId); return; }
      // 看板上的一条对应本地哪条：职位 ID 只在本站内唯一，所以要连站点一起比
      const rec = records.find((r) => String(r.jobId) === String(op.jobId)
                                   && recSite(r) === (op.site || recSite(r)));
      if (!rec) { done.push(op.opId); return; }        // 本地没有这条，丢掉这个操作
      // 队列里的操作可能比本地还旧（比如已经在 LinkedIn 上改过了），旧的就不覆盖
      if (op.ts && rec.updatedAt && op.ts < rec.updatedAt) { done.push(op.opId); return; }

      if (op.op === 'followUp') {
        rec.followUpAt = Number(op.at) || 0;
        rec.followUpNote = String(op.note || '');
        rec.updatedAt = op.ts || Date.now();
        changed++;
      }
      done.push(op.opId);
    });

    if (changed) { store.set(K_REC, records); }
    // 处理过的从队列里摘掉，并留一份回执让看板知道已经落地
    try {
      const rest = ops.filter((op) => done.indexOf(op && op.opId) === -1);
      localStorage.setItem(BOARD_OUTBOX, JSON.stringify(rest));
      localStorage.setItem(BOARD_ACK, JSON.stringify({ at: Date.now(), applied: changed }));
    } catch (e) { /* 存不下就下次再说 */ }
    return changed;
  }

  if (IS_BOARD) {
    // @match 只能写 *.github.io，别的 Pages 站点也会命中；这里再确认一次
    // 「这确实是我们的看板」——有数据注入点，或者地址就是设置里填的那个。
    const looksLikeBoard = !!document.getElementById('payload')
      || (gh.boardUrl && gh.boardUrl.indexOf(location.origin) === 0);
    if (!looksLikeBoard) { host.remove(); return; }

    // 看板上不建任何界面，宿主整个藏起来，只留桥接
    host.style.display = 'none';
    const runBridge = () => {
      const n = drainBoardOutbox();
      if (n) {
        render();
        if (ghReady()) ghSync(false);
        else console.warn('[applied-tracker] 看板改了 ' + n + ' 条，但没配 GitHub Token，推不上去');
      }
    };
    runBridge();
    setInterval(runBridge, 4000);       // 看板上现改的，几秒内就回写
    window.addEventListener('storage', (e) => { if (e.key === BOARD_OUTBOX) runBridge(); });
    return;                             // 后面那套 LinkedIn / Jobstreet 的启动流程全部跳过
  }

  /* =========================================================================
   * 8. 启动 + SPA 兼容
   * ========================================================================= */

  ui.panel.hidden = true;      // 每次加载都收起，要看清单得手动展开
  applyNoNewsTimeout();        // 先把超期的记录落位，再画清单
  applyBarPos();
  applyPanelBox();
  render();
  updateGhBtn();
  markPageCards();
  markCurrentTitle();
  mountMsgOps();
  refreshStats();
  checkFollowUps();            // 到期的跟进提醒，一进页面就弹
  setTimeout(() => { refreshStats(); checkCompanyAlert(); markCurrentTitle(); }, 1500);   // 内容异步渲染，晚一点再来一次
  setTimeout(expandMoreButtons, 800);       // 首屏渲染完再展开一次
  // 页面开一整天的情况：跨过零点后新到期的也要弹出来
  setInterval(checkFollowUps, 5 * 60000);

  /* ---- 多标签页：别的页面改了记录，这边跟着刷新 ----
   * localStorage 的 storage 事件只在「其它标签页」写入时触发，正好是要的语义。
   * 用油猴存储时这个事件收不到，但 store.set 两边都会写，所以仍然有效。
   */
  window.addEventListener('storage', (e) => {
    if (e.key !== K_REC && e.key !== K_MSG) return;
    if (e.key === K_REC) {
      if (mergeStored()) { render(); markPageCards(); }
    } else {
      let stored = [];
      try { stored = JSON.parse(e.newValue || '[]'); } catch (err) { stored = []; }
      if (!Array.isArray(stored)) return;
      const seen = Object.create(null);
      messages.forEach((m) => { if (m && m.id) seen[m.id] = 1; });
      let add = 0;
      stored.forEach((s) => {
        if (!s || !s.id || seen[s.id] || deleted[s.id]) return;
        messages.push(s); seen[s.id] = 1; add++;
      });
      if (add && !$msgMask.hidden) renderMessages();
    }
  });

  // 列表是 SPA 增量渲染的，DOM 变了要重新画划线 / 展开新出现的 more
  const mo = new MutationObserver(() => { scheduleMark(); scheduleExpand(); scheduleStats(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  let lastHref = location.href;
  const guard = setInterval(() => {
    // 有更新的实例接管了 → 本实例退休
    if (document.documentElement.dataset.latGen !== GEN) {
      clearInterval(guard);
      host.remove();
      return;
    }
    // LinkedIn 是 SPA，页面重绘可能把宿主节点摘掉
    if (!document.documentElement.contains(host)) {
      (document.body || document.documentElement).appendChild(host);
    }
    if (location.href !== lastHref) {
      lastHref = location.href;
      $ask.hidden = true;                        // 换页了，旧提示条作废
      $coMask.hidden = true;
      setTimeout(() => { refreshApplyBtn(); markPageCards(); markCurrentTitle(); mountMsgOps(); refreshStats(); checkCompanyAlert(); }, 600);
    }
  }, 1000);
})();