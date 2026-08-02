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
TEMPLATE = os.path.join(ROOT, "template.html")
OUTDIR = os.path.join(ROOT, "dist")

STATUSES = [
    "已投递等联络", "对方来联络了", "已安排面试",
    "书类落了", "面试落了", "人事 Offer Call", "内定",
]

# 只允许指向 LinkedIn 的链接进入公开页面，避免脏数据把页面变成任意跳转
SAFE_URL = re.compile(r"^https://([a-z0-9-]+\.)*linkedin\.com/", re.I)


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

    status = s(raw.get("status"), 40) or STATUSES[0]
    return {
        "ts": ts,
        "company": s(raw.get("company"), 120),
        "title": s(raw.get("title"), 200),
        "jobUrl": url(raw.get("jobUrl")),
        "hirers": hirers,
        "applicants": s(raw.get("applicants"), 20),
        "tenure": s(raw.get("tenure"), 30),
        "status": status,
        "memo": s(raw.get("memo"), 1000),
    }


def load():
    if not os.path.exists(DATA):
        print(f"! 找不到 {DATA}，按空清单构建", file=sys.stderr)
        return [], ""
    with open(DATA, encoding="utf-8") as f:
        try:
            blob = json.load(f)
        except json.JSONDecodeError as e:
            sys.exit(f"data/records.json 不是合法 JSON: {e}")

    if isinstance(blob, dict):
        raw, updated = blob.get("records") or [], s(blob.get("updatedAt"), 40)
    elif isinstance(blob, list):
        raw, updated = blob, ""
    else:
        sys.exit("data/records.json 顶层必须是数组或对象")

    records = [r for r in (normalize(x) for x in raw) if r]
    records.sort(key=lambda r: r["ts"], reverse=True)

    if not updated and records:
        updated = datetime.fromtimestamp(records[0]["ts"] / 1000, timezone.utc).isoformat()
    return records, updated


def main():
    records, updated = load()

    with open(TEMPLATE, encoding="utf-8") as f:
        html = f.read()

    payload = {
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "updatedAt": updated,
        "count": len(records),
        "records": records,
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
    print(f"✓ dist/index.html — {len(records)} 条记录，数据更新于 {updated or '未知'}")
    for k in STATUSES:
        if by_status.get(k):
            print(f"    {k}: {by_status[k]}")
    extra = [k for k in by_status if k not in STATUSES]
    for k in extra:
        print(f"    {k}（非预设状态）: {by_status[k]}")


if __name__ == "__main__":
    main()
