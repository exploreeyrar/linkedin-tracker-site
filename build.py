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
OUTDIR = os.path.join(ROOT, "dist")

# 顺序即看板的默认排序顺位，必须和油猴脚本里的 STATUSES 保持一致
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
_LOOSE = {s.translate(_PUNCT).replace("対", "对"): s for s in STATUSES}


def canon_status(value):
    if not value:
        return DEFAULT_STATUS
    if value in STATUSES:
        return value
    if value in STATUS_ALIAS:
        return STATUS_ALIAS[value]
    return _LOOSE.get(value.translate(_PUNCT).replace("対", "对"), value)

# 只允许指向招聘站本身的链接进入公开页面，避免脏数据把页面变成任意跳转。
# jobstreet 各国站都是子域（sg./my./ph.…），另有 jobstreet.com.sg 这种老域名。
SAFE_URL = re.compile(
    r"^https://([a-z0-9-]+\.)*(linkedin\.com|jobstreet\.com(\.[a-z]{2})?)/", re.I
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
    job_id = re.sub(r"\D", "", s(raw.get("jobId"), 24))[:24]
    return {
        "ts": ts,
        "jobId": job_id,                          # 看板锚点用（#job-<id>）
        "updatedAt": to_ms(raw.get("updatedAt")),  # 最后一次改 MEMO / 状态的时间
        "company": s(raw.get("company"), 120),
        "title": s(raw.get("title"), 200),
        "jobUrl": url(raw.get("jobUrl")),
        "hirers": hirers,
        "applicants": s(raw.get("applicants"), 20),
        "tenure": s(raw.get("tenure"), 30),
        "status": status,
        "memo": s(raw.get("memo"), 1000),
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


def load():
    if not os.path.exists(DATA):
        print(f"! 找不到 {DATA}，按空清单构建", file=sys.stderr)
        return [], "", [], list(STATUSES)
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
    elif isinstance(blob, list):
        raw, updated, raw_msgs, order = blob, "", [], []
    else:
        sys.exit("data/records.json 顶层必须是数组或对象")

    # 油猴脚本里可以拖动调整状态优先级，推上来就以它为准；
    # 只认已知状态，缺的按内置顺序补在后面，脏数据不会打乱排序。
    statuses = [x for x in order if isinstance(x, str) and x in STATUSES]
    seen = set(statuses)
    statuses += [x for x in STATUSES if x not in seen]

    records = [r for r in (normalize(x) for x in raw) if r]
    # 先按状态顺位，同状态再按投递时间从新到旧
    rank = {name: i for i, name in enumerate(statuses)}
    records.sort(key=lambda r: (rank.get(r["status"], len(statuses)), -r["ts"]))

    messages = [m for m in (normalize_message(x) for x in raw_msgs) if m]
    messages.sort(key=lambda m: m["createdAt"], reverse=True)

    if not updated and records:
        newest = max(r["ts"] for r in records)      # 已不按时间排序，要取最大值
        updated = datetime.fromtimestamp(newest / 1000, timezone.utc).isoformat()
    return records, updated, messages, statuses


def main():
    records, updated, messages, statuses = load()
    cfg = load_config()

    with open(TEMPLATE, encoding="utf-8") as f:
        html = f.read()

    payload = {
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "updatedAt": updated,
        "count": len(records),
        "records": records,
        "messages": messages,
        "statuses": statuses,
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
