#!/usr/bin/env python3
"""
把 data/records.json 渲染成 dist/index.html（GitHub Pages 用）。

只依赖标准库。数据源可以是两种形状：
  1. 数组:  [ {...}, {...} ]
  2. 对象:  { "updatedAt": "...", "records": [ {...} ] }   ← 油猴脚本推送的格式

设计取舍：页面里的「距今 N 天」「本周新投」等都在浏览器端实时算，
所以即使定时构建没跑，打开页面看到的时间信息也是准确的。
"""

import json
import os
import re
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data", "records.json")
CONFIG = os.path.join(ROOT, "config.json")
TEMPLATE = os.path.join(ROOT, "template.html")
# Telegram 群 / 频道消息的镜像页。数据是运行时从 Worker 拉的，
# 构建时只需要把中继地址塞进去。
CHANNEL_TEMPLATE = os.path.join(ROOT, "channel.html")
OUTDIR = os.path.join(ROOT, "dist")

# 内置状态清单，顺序即看板的默认排序顺位。
# 状态在油猴脚本里可以改名 / 新增 / 删除，改过之后脚本会把整份定义（statusDefs）
# 推上来，那时候以推上来的为准；这里这份只是「数据里没带定义」时的兜底。
STATUSES = [
    "等己方处理(XR ball)",
    "等己方处理(己 ball)",
    "已安排面试、面试准备中",
    "対方来联络了",
    "四次面试通过、等对方安排下一轮",
    "三次面试通过、等对方安排下一轮",
    "二次面试通过、等对方安排下一轮",
    "一次面试通过、等対方安排下一轮",
    "一次人事面谈结束、等对方联络",
    "内定",
    "人事 Offer Call",
    "已投递等联络",
    "面试落了",
    "书类落了",
    "对方招到人了",
    "无消息疑似书类落了",
]

# 新记录的初始状态（排序顺位与默认值是两回事，所以不取 STATUSES[0]）
DEFAULT_STATUS = "已投递等联络"

# 旧版本的状态值
STATUS_ALIAS = {
    "对方来联络了": "対方来联络了",
    "已安排面试": "已安排面试、面试准备中",
    "等己方处理": "等己方处理(XR ball)",
}

# 逐字匹配之外再做一次「去标点 + 対/对 统一」的模糊匹配，老数据不会落到未知状态
_PUNCT = str.maketrans("", "", "，,、･·・ \t")

# 当前生效的状态名（由 load() 按推上来的定义设置）。
# 必须以它为准而不是内置的 STATUSES：用户把状态改成了近似的写法时，
# 拿内置清单去模糊匹配会把改过的名字又「归一」回旧写法。
_ACTIVE_NAMES = list(STATUSES)
_ACTIVE_DEFAULT = DEFAULT_STATUS


def set_active_statuses(names, default_name):
    global _ACTIVE_NAMES, _ACTIVE_DEFAULT
    _ACTIVE_NAMES = list(names) or list(STATUSES)
    _ACTIVE_DEFAULT = default_name or _ACTIVE_NAMES[0]


def canon_status(value):
    if not value:
        return _ACTIVE_DEFAULT
    if value in _ACTIVE_NAMES:
        return value
    # 内置别名只在目标名字确实还在用时才生效（用户可能已经把它改名或删掉了）
    alias = STATUS_ALIAS.get(value)
    if alias and alias in _ACTIVE_NAMES:
        return alias
    loose = {n.translate(_PUNCT).replace("対", "对"): n for n in _ACTIVE_NAMES}
    return loose.get(value.translate(_PUNCT).replace("対", "对"), value)

# 只允许指向招聘站本身的链接进入公开页面，避免脏数据把页面变成任意跳转。
# jobstreet 各国站都是子域（sg./my./ph.…），另有 jobstreet.com.sg 这种老域名。
SAFE_URL = re.compile(
    r"^https://([a-z0-9-]+\.)*(linkedin\.com|jobstreet\.com(\.[a-z]{2})?|jora\.com)/", re.I
)


def s(v, limit=400):
    """转成干净的字符串：去掉控制字符、限长。"""
    if v is None:
        return ""
    t = str(v).replace("\r\n", "\n").replace("\r", "\n")
    t = "".join(ch for ch in t if ch == "\n" or ch >= " ")
    return t.strip()[:limit]


def url(v):
    t = s(v, 500)
    return t if SAFE_URL.match(t) else ""


# 有 site 字段就信它，没有（早期记录）就看链接域名，最后一律当 LinkedIn
SITES = ("linkedin", "jobstreet", "jora")


def site_of(raw, job_url):
    site = s(raw.get("site"), 20).lower()
    if site in SITES:
        return site
    u = job_url.lower()
    if "jobstreet." in u:
        return "jobstreet"
    if "jora." in u:
        return "jora"
    return "linkedin"


def to_ms(v):
    """时间戳统一成毫秒整数。接受数字或 ISO 字符串。"""
    if isinstance(v, (int, float)) and v > 0:
        n = int(v)
        return n * 1000 if n < 10_000_000_000 else n  # 秒 → 毫秒
    t = s(v, 40)
    if t:
        try:
            return int(datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            pass
    return 0


def clamp_int(v, lo, hi):
    """脏数据不该让构建失败：认不出来就当 lo。"""
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return lo
    return max(lo, min(hi, n))


def memo_blocks(raw):
    """
    MEMO 的时间轴。新脚本推上来的是 memos 数组（一次一条，带时间）；
    老记录只有一整段 memo，就当成一条，时间取最后改动时间。最多留 50 条。
    """
    out = []
    for b in (raw.get("memos") or [])[:50]:
        if not isinstance(b, dict):
            continue
        text = s(b.get("text"), 2000)
        ts = to_ms(b.get("ts"))
        if text and ts:
            out.append({"ts": ts, "text": text})
    if out:
        out.sort(key=lambda b: -b["ts"])
        return out
    memo = s(raw.get("memo"), 2000)
    if not memo:
        return []
    ts = to_ms(raw.get("updatedAt")) or to_ms(raw.get("ts"))
    return [{"ts": ts, "text": memo}] if ts else []


def normalize(raw):
    """清洗单条记录；返回 None 表示丢弃。"""
    if not isinstance(raw, dict):
        return None
    ts = to_ms(raw.get("ts") or raw.get("timestamp"))
    if not ts:
        return None

    hirers = []
    for h in (raw.get("hirers") or [])[:6]:
        if not isinstance(h, dict):
            continue
        name, link = s(h.get("name"), 80), url(h.get("url"))
        if not name and not link:
            continue
        hirers.append({"name": name or "(未知)", "url": link, "role": s(h.get("role"), 160)})

    status = canon_status(s(raw.get("status"), 40))
    # LinkedIn / Jobstreet 是纯数字，Jora 是 32 位十六进制，所以只能按
    # 「字母数字」清洗，不能像以前那样把非数字统统删掉（那会把 Jora 的 ID 毁掉）
    job_id = re.sub(r"[^0-9A-Za-z]", "", s(raw.get("jobId"), 48))[:48]
    job_url = url(raw.get("jobUrl"))
    return {
        "ts": ts,
        "site": site_of(raw, job_url),            # 'linkedin' | 'jobstreet'
        "jobId": job_id,                          # 看板锚点用（#job-<id>）
        "updatedAt": to_ms(raw.get("updatedAt")),  # 最后一次改 MEMO / 状态的时间
        "company": s(raw.get("company"), 120),
        "title": s(raw.get("title"), 200),
        "jobUrl": job_url,
        "hirers": hirers,
        # 记录时从职位页抓下来的几项，详情页显示（「申请数」已废弃，不再接收）
        "employees": s(raw.get("employees"), 20),
        "years": s(raw.get("years"), 40),
        "jobMatch": s(raw.get("jobMatch"), 40),
        "tenure": s(raw.get("tenure"), 30),
        "status": status,
        # 重要度：看板排序时压过状态顺位与时间新旧
        "priority": clamp_int(raw.get("priority"), 0, 3),
        # 跟进提醒（当天 0 点的毫秒）与备注
        "followUpAt": to_ms(raw.get("followUpAt")),
        "followUpNote": s(raw.get("followUpNote"), 300),
        # 处理期限：那一天 0 点（JST）的毫秒。看板倒计时到「前一日 21:00 JST」为止，
        # 也就是这个值减 3 小时。打过勾（deadlineDone）就不再倒计时。
        "deadlineAt": to_ms(raw.get("deadlineAt")),
        "deadlineDone": bool(raw.get("deadlineDone")),
        "memo": s(raw.get("memo"), 1000),
        "memos": memo_blocks(raw),                # 时间轴形式的 MEMO（新 → 旧）
        "scout": bool(raw.get("scout")),          # 人事主动 scout 的
        # EP 所属行业与按年龄算好的 C1 门槛，由油猴脚本算好后推上来
        "sector": s(raw.get("sector"), 120),
        "epMonthly": max(0, int(raw.get("epMonthly") or 0)),
        "epAnnual": max(0, int(raw.get("epAnnual") or 0)),
    }


def normalize_message(raw):
    """留言板的一条留言。"""
    if not isinstance(raw, dict):
        return None
    text = s(raw.get("text"), 4000)
    if not text:
        return None
    created = to_ms(raw.get("createdAt") or raw.get("ts"))
    if not created:
        return None
    edited = to_ms(raw.get("editedAt"))
    return {
        "id": s(raw.get("id"), 40) or ("m" + str(created)),
        "text": text,
        "createdAt": created,
        "editedAt": edited if edited and edited != created else 0,
        "author": s(raw.get("author"), 40),
    }


def load_config():
    """Telegram 中继地址等站点配置。缺文件就按未配置处理。"""
    cfg = {"tgEndpoint": "", "tgAppKey": ""}
    if os.path.exists(CONFIG):
        try:
            with open(CONFIG, encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                cfg["tgEndpoint"] = s(raw.get("tgEndpoint"), 300)
                cfg["tgAppKey"] = s(raw.get("tgAppKey"), 200)
        except (json.JSONDecodeError, OSError) as e:
            print(f"! config.json 读取失败（按未配置处理）: {e}", file=sys.stderr)
    if cfg["tgEndpoint"] and not cfg["tgEndpoint"].startswith("https://"):
        print("! config.json 的 tgEndpoint 必须是 https:// 开头，已忽略", file=sys.stderr)
        cfg["tgEndpoint"] = ""
    return cfg


def builtin_defs():
    """内置状态的完整定义；数据里没带 statusDefs 时用它兜底。"""
    closed = {"面试落了", "书类落了", "对方招到人了", "无消息疑似书类落了"}
    rejected = {"面试落了", "书类落了"}
    advanced = {
        "已安排面试、面试准备中", "一次面试通过、等対方安排下一轮",
        "二次面试通过、等对方安排下一轮", "三次面试通过、等对方安排下一轮",
        "四次面试通过、等对方安排下一轮", "人事 Offer Call", "内定",
    }
    waiting = {
        "已投递等联络", "等己方处理(XR ball)", "等己方处理(己 ball)",
        "一次人事面谈结束、等对方联络",
    }
    roles = {"已投递等联络": "default", "无消息疑似书类落了": "nonews"}
    return [
        {
            "id": f"b{i}", "name": n,
            "closed": n in closed, "rejected": n in rejected,
            "advanced": n in advanced, "waiting": n in waiting,
            "role": roles.get(n, ""),
        }
        for i, n in enumerate(STATUSES)
    ]


def normalize_defs(raw_defs, order):
    """
    状态定义。油猴脚本里状态可以改名 / 新增 / 删除，所以这里**不做名字白名单**——
    推上来的就是权威，否则用户自定义的状态会被整条丢掉。
    只做类型清洗；一条有效的都没有才退回内置定义。
    """
    out, seen = [], set()
    for i, d in enumerate(raw_defs or []):
        if not isinstance(d, dict):
            continue
        name = s(d.get("name"), 40)
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({
            "id": s(d.get("id"), 40) or f"s{i}",
            "name": name,
            "closed": bool(d.get("closed")),
            "rejected": bool(d.get("rejected")),
            "advanced": bool(d.get("advanced")),
            "waiting": bool(d.get("waiting")),
            "role": s(d.get("role"), 20),
        })
    if out:
        return out

    # 老版本只推了 statusOrder（纯名字数组）：按它排，属性从内置定义里认领
    by_name = {d["name"]: d for d in builtin_defs()}
    names = [x for x in (order or []) if isinstance(x, str) and x]
    if not names:
        return builtin_defs()
    out = []
    for i, n in enumerate(names):
        if n in seen:
            continue
        seen.add(n)
        out.append(by_name.get(n) or {
            "id": f"o{i}", "name": n, "closed": False, "rejected": False,
            "advanced": False, "waiting": False, "role": "",
        })
    return out


def load():
    if not os.path.exists(DATA):
        print(f"! 找不到 {DATA}，按空清单构建", file=sys.stderr)
        return [], "", [], builtin_defs()
    with open(DATA, encoding="utf-8") as f:
        try:
            blob = json.load(f)
        except json.JSONDecodeError as e:
            sys.exit(f"data/records.json 不是合法 JSON: {e}")

    if isinstance(blob, dict):
        raw = blob.get("records") or []
        updated = s(blob.get("updatedAt"), 40)
        raw_msgs = blob.get("messages") or []
        order = blob.get("statusOrder") or []
        raw_defs = blob.get("statusDefs") or []
    elif isinstance(blob, list):
        raw, updated, raw_msgs, order, raw_defs = blob, "", [], [], []
    else:
        sys.exit("data/records.json 顶层必须是数组或对象")

    defs = normalize_defs(raw_defs, order)
    statuses = [d["name"] for d in defs]
    # 记录清洗（canon_status）要按这份名字来，所以必须先设好
    default_name = next((d["name"] for d in defs if d["role"] == "default"), statuses[0])
    set_active_statuses(statuses, default_name)

    records = [r for r in (normalize(x) for x in raw) if r]
    # 重要度最优先（★ 多的排最上面，无视状态与时间），
    # 其次状态顺位，同状态再按投递时间从新到旧
    rank = {name: i for i, name in enumerate(statuses)}
    records.sort(key=lambda r: (-r["priority"], rank.get(r["status"], len(statuses)), -r["ts"]))

    messages = [m for m in (normalize_message(x) for x in raw_msgs) if m]
    messages.sort(key=lambda m: m["createdAt"], reverse=True)

    if not updated and records:
        newest = max(r["ts"] for r in records)      # 已不按时间排序，要取最大值
        updated = datetime.fromtimestamp(newest / 1000, timezone.utc).isoformat()
    return records, updated, messages, defs


def build_channel(cfg):
    """dist/channel.html —— Telegram 群 / 频道消息的实时镜像页。"""
    if not os.path.exists(CHANNEL_TEMPLATE):
        print("! 找不到 channel.html，跳过频道页", file=sys.stderr)
        return
    with open(CHANNEL_TEMPLATE, encoding="utf-8") as f:
        html = f.read()
    if "__CONFIG__" not in html:
        sys.exit("channel.html 里找不到 __CONFIG__ 占位符")
    blob = (json.dumps(cfg, ensure_ascii=False, separators=(",", ":"))
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))
    with open(os.path.join(OUTDIR, "channel.html"), "w", encoding="utf-8") as f:
        f.write(html.replace("__CONFIG__", blob))
    print(f"✓ dist/channel.html — Telegram 频道镜像"
          f"（{'已接中继' if cfg['tgEndpoint'] else '中继未配置'}）")


def main():
    records, updated, messages, defs = load()
    statuses = [d["name"] for d in defs]
    cfg = load_config()

    with open(TEMPLATE, encoding="utf-8") as f:
        html = f.read()

    payload = {
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "updatedAt": updated,
        "count": len(records),
        "records": records,
        "messages": messages,
        "statuses": statuses,       # 只要名字，顺序即显示顺位（页面排序用）
        "statusDefs": defs,         # 带 closed / advanced / waiting / role 的完整定义
        "config": cfg,
    }
    # 嵌进 <script type="application/json">，必须堵死提前闭合标签的可能
    blob = (json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026"))

    if "__DATA__" not in html:
        sys.exit("template.html 里找不到 __DATA__ 占位符")
    html = html.replace("__DATA__", blob)

    os.makedirs(OUTDIR, exist_ok=True)
    with open(os.path.join(OUTDIR, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    # 关掉 Jekyll，避免下划线开头的文件被吞掉
    open(os.path.join(OUTDIR, ".nojekyll"), "w").close()

    build_channel(cfg)

    by_status = {}
    for r in records:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    scouted = sum(1 for r in records if r["scout"])
    print(f"✓ dist/index.html — {len(records)} 条记录"
          f"（scout {scouted} 条）、留言 {len(messages)} 条，数据更新于 {updated or '未知'}")
    print(f"    Telegram 中继: {cfg['tgEndpoint'] or '未配置（config.json 的 tgEndpoint 为空）'}")
    for k in statuses:
        if by_status.get(k):
            print(f"    {k}: {by_status[k]}")
    extra = [k for k in by_status if k not in statuses]
    for k in extra:
        print(f"    {k}（非预设状态）: {by_status[k]}")


if __name__ == "__main__":
    main()
