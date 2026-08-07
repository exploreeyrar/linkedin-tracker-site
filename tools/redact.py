#!/usr/bin/env python3
"""
把 data/records.json 里的敏感字符串换掉（隐私）。

油猴脚本从 v1.9.0 起会在**推送前**自动替换，所以以后同步上来的就是干净的。
这个脚本处理的是「已经推上去的那份」—— 跑一次，把仓库里现存的数据洗一遍。

规则和脚本里的 DEFAULT_REDACT 保持一致；改了那边记得也改这里。
大小写不敏感：目标是隐私，漏掉「Okuma」就白做了。

刻意不碰 jobUrl / jobId / site / id / 时间戳 —— 换了链接就废了。

    python3 tools/redact.py            # 就地改写 data/records.json
    python3 tools/redact.py --dry-run  # 只报告会改多少处，不写文件
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "records.json")

# 和 linkedin-applied-tracker.user.js 的 DEFAULT_REDACT 一致
RULES = [
    ("OKUMA", "O"),
    ("WAKATSUKI", "W"),
    ("XR", "胖"),
    ("Cohesity", "CO"),
    ("Dell", "DL"),
]

# 状态改名：XR → 胖，顺手把之前手改出来的带空格写法 normalize 掉
STATUS_RENAME = {
    "等己方处理(XR ball)": "等己方处理(胖 ball)",
    "等己方 处理(XR ball)": "等己方处理(胖 ball)",
}

# 要替换的自由文本字段
TEXT_FIELDS = ("memo", "followUpNote", "company", "title", "sector")

_counter = {"n": 0}


def redact(v):
    """长规则先套用，免得短规则把长规则的目标切碎。"""
    if not isinstance(v, str) or not v:
        return v
    out = v
    for frm, to in sorted(RULES, key=lambda r: -len(r[0])):
        new = re.sub(re.escape(frm), lambda _m: to, out, flags=re.I)
        if new != out:
            _counter["n"] += len(re.findall(re.escape(frm), out, flags=re.I))
            out = new
    return out


def fix_status(v):
    if not isinstance(v, str):
        return v
    if v in STATUS_RENAME:
        _counter["n"] += 1
        return STATUS_RENAME[v]
    # 去空白后再对一次，涵盖手改出来的各种写法
    loose = re.sub(r"[，,、･·・\s]", "", v)
    if loose == "等己方处理(XRball)":
        _counter["n"] += 1
        return "等己方处理(胖 ball)"
    return redact(v)


def main():
    dry = "--dry-run" in sys.argv
    if not os.path.exists(DATA):
        sys.exit("找不到 " + DATA)
    with open(DATA, encoding="utf-8") as f:
        d = json.load(f)
    if not isinstance(d, dict):
        sys.exit("data/records.json 顶层不是对象，这个脚本只处理油猴脚本推上来的格式")

    before = json.dumps(d, ensure_ascii=False)

    for r in d.get("records") or []:
        if not isinstance(r, dict):
            continue
        for k in TEXT_FIELDS:
            if k in r:
                r[k] = redact(r[k])
        if "status" in r:
            r["status"] = fix_status(r["status"])
        for b in r.get("memos") or []:
            if isinstance(b, dict) and "text" in b:
                b["text"] = redact(b["text"])
        for h in r.get("hirers") or []:
            if isinstance(h, dict):
                h["name"] = redact(h.get("name"))
                h["role"] = redact(h.get("role"))

    for m in d.get("messages") or []:
        if isinstance(m, dict):
            m["text"] = redact(m.get("text"))
            m["author"] = redact(m.get("author"))

    if isinstance(d.get("statusOrder"), list):
        d["statusOrder"] = [fix_status(x) for x in d["statusOrder"]]
    for sd in d.get("statusDefs") or []:
        if isinstance(sd, dict) and "name" in sd:
            sd["name"] = fix_status(sd["name"])

    after = json.dumps(d, ensure_ascii=False, indent=1)

    # 复核：只看「应该被替换的那些字段」。
    # 内部 id（statusDefs[].id 是 self_xr）本来就不该动，扫全文会误报。
    def redacted_values(blob):
        for r in blob.get("records") or []:
            if not isinstance(r, dict):
                continue
            for k in TEXT_FIELDS + ("status",):
                if isinstance(r.get(k), str):
                    yield r[k]
            for b in r.get("memos") or []:
                if isinstance(b, dict) and isinstance(b.get("text"), str):
                    yield b["text"]
            for h in r.get("hirers") or []:
                if isinstance(h, dict):
                    for k in ("name", "role"):
                        if isinstance(h.get(k), str):
                            yield h[k]
        for m in blob.get("messages") or []:
            if isinstance(m, dict):
                for k in ("text", "author"):
                    if isinstance(m.get(k), str):
                        yield m[k]
        for x in blob.get("statusOrder") or []:
            if isinstance(x, str):
                yield x
        for sd in blob.get("statusDefs") or []:
            if isinstance(sd, dict) and isinstance(sd.get("name"), str):
                yield sd["name"]

    joined = "\n".join(redacted_values(d))
    leftover = {}
    for frm, _ in RULES:
        n = len(re.findall(re.escape(frm), joined, flags=re.I))
        if n:
            leftover[frm] = n

    print("替换了 %d 处" % _counter["n"])
    if leftover:
        print("! 仍然残留：", leftover, file=sys.stderr)
    else:
        print("✓ 规则里的字符串已全部不在文件中")

    if dry:
        print("(--dry-run，没有写文件)")
        return
    if after == json.dumps(json.loads(before), ensure_ascii=False, indent=1):
        print("内容没有变化，不写文件")
        return
    with open(DATA, "w", encoding="utf-8") as f:
        f.write(after)
    print("已写回 " + DATA)


if __name__ == "__main__":
    main()
