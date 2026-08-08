#!/usr/bin/env python3
"""
把别人发来的 iMessage 同步到看板（channel.html）和 Telegram。

    Mac（常开）── 轮询 chat.db ──▶ Worker(action=inbox_push) ──▶ 收件箱 DO
                                            └──▶ Telegram（可选，手机上有推送）

为什么不直接「发给 Telegram，靠 webhook 回流到频道页」：
**bot 收不到自己发的消息** —— 实测收件箱里以 #SGJOB 开头的一条都没有，
而那些正是 bot 自己发出去的。所以要让频道页看到，必须直接写收件箱。

三件必须知道的事：
  1. 需要「完全磁盘访问权限」。系统设置 → 隐私与安全性 → 完全磁盘访问权限，
     把跑这个脚本的那个程序（终端 / launchd 用的话是 /usr/bin/python3）加进去，
     否则连 chat.db 都打不开（报 authorization denied）。
  2. Mac 必须开着并登录着 iMessage，睡眠时收不到。
  3. 新版 macOS 把正文塞进 attributedBody（typedstream 归档），text 字段是空的，
     所以要解一层，见 decode_attributed_body()。

只依赖标准库。

    python3 tools/imessage-bridge.py --once      # 跑一轮就退出（先用这个试）
    python3 tools/imessage-bridge.py --dry-run   # 只打印会发什么，不真发
    python3 tools/imessage-bridge.py             # 常驻，按 interval 轮询
    python3 tools/imessage-bridge.py --reset     # 把游标挪到最新，忽略所有历史
"""

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "imessage-bridge.config.json")
STATE = os.path.join(HERE, ".imessage-bridge.state.json")
CHAT_DB = os.path.expanduser("~/Library/Messages/chat.db")

# Cloudflare 会按浏览器签名拦掉 urllib 的默认 UA（见 push() 里的说明）
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) sgjob-imessage-bridge"

# Apple 的纪元是 2001-01-01 UTC
APPLE_EPOCH = 978307200

# 出门前的字符串替换，和油猴脚本 / tools/redact.py 用同一套规则
try:
    sys.path.insert(0, HERE)
    from redact import redact as _redact
except Exception:                                    # noqa: BLE001
    def _redact(v):
        return v


DEFAULT_CONFIG = {
    "endpoint": "",
    "ingestKey": "",
    "source": "iMessage",
    "toTelegram": True,
    "intervalSec": 20,
    "maxPerRound": 30,
    # 空 = 收所有人发来的；填了就只收这些（手机号 / Apple ID，支持后缀匹配）
    "onlyFrom": [],
    # 这些一律不收
    "ignoreFrom": [],
    "includeGroupChats": True,
    # 「赞了xxx」这类 tapback 默认不转发
    "includeReactions": False,
}


def load_config():
    if not os.path.exists(CONFIG):
        with open(CONFIG, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
        sys.exit(
            "已生成 %s —— 先把 endpoint 和 ingestKey 填上再跑。\n"
            "  endpoint  : Worker 地址（和看板用的同一个）\n"
            "  ingestKey : wrangler secret put INGEST_KEY 时设的那个值" % CONFIG
        )
    with open(CONFIG, encoding="utf-8") as f:
        cfg = dict(DEFAULT_CONFIG)
        cfg.update(json.load(f))
    if not cfg["endpoint"] or not cfg["ingestKey"]:
        sys.exit("%s 里的 endpoint / ingestKey 还是空的" % CONFIG)
    return cfg


def load_state():
    if os.path.exists(STATE):
        try:
            with open(STATE, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            pass
    return {"lastRowId": 0}


def save_state(st):
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f)
    os.replace(tmp, STATE)


def open_db():
    """
    chat.db 是 WAL 模式，而 Messages 一直在写。直接以只读方式打开时，
    读 -wal 需要能建 -shm，常常失败（database is locked）。
    所以整份复制到临时目录再读 —— 慢一点，但不会和 Messages 抢锁。
    """
    if not os.path.exists(CHAT_DB):
        sys.exit("找不到 %s —— 这台机器登录 iMessage 了吗？" % CHAT_DB)
    tmpdir = tempfile.mkdtemp(prefix="imsg-")
    dst = os.path.join(tmpdir, "chat.db")
    try:
        shutil.copy2(CHAT_DB, dst)
        for ext in ("-wal", "-shm"):
            src = CHAT_DB + ext
            if os.path.exists(src):
                shutil.copy2(src, dst + ext)
    except PermissionError:
        shutil.rmtree(tmpdir, ignore_errors=True)
        sys.exit(
            "打不开 chat.db：缺「完全磁盘访问权限」。\n"
            "系统设置 → 隐私与安全性 → 完全磁盘访问权限，把终端（或 launchd 用的\n"
            "那个 python3）加进去并勾上，然后重开终端再试。"
        )
    return sqlite3.connect(dst), tmpdir


def decode_attributed_body(blob):
    """
    新版 macOS 的正文在 attributedBody 里，是 NSAttributedString 的
    typedstream 归档。格式大意：… NSString 之后跟一个 0x2b（'+'）标记，
    再跟长度，再跟 UTF-8 字节。长度 >= 0x81 时改用后面 2/4/8 字节表示。

    这是启发式解析，不是完整的 typedstream 解码器 —— 认不出来就返回空串，
    让调用方退回 text 字段，绝不抛异常。
    """
    if not blob:
        return ""
    if isinstance(blob, str):
        blob = blob.encode("utf-8", "replace")
    try:
        i = blob.find(b"NSString")
        if i == -1:
            return ""
        p = blob.find(b"\x2b", i)
        if p == -1:
            return ""
        p += 1
        n = blob[p]
        p += 1
        if n == 0x81:
            n = int.from_bytes(blob[p:p + 2], "little"); p += 2
        elif n == 0x82:
            n = int.from_bytes(blob[p:p + 4], "little"); p += 4
        elif n == 0x83:
            n = int.from_bytes(blob[p:p + 8], "little"); p += 8
        if n <= 0 or n > len(blob):
            return ""
        return blob[p:p + n].decode("utf-8", "replace").strip()
    except Exception:                                # noqa: BLE001
        return ""


def apple_ms(v):
    """message.date → 毫秒时间戳。10.13+ 是纳秒，更早是秒。"""
    try:
        n = int(v or 0)
    except (TypeError, ValueError):
        return 0
    if n <= 0:
        return 0
    if n > 10 ** 11:                                  # 纳秒
        return int(APPLE_EPOCH * 1000 + n / 1e6)
    return int((APPLE_EPOCH + n) * 1000)


QUERY = """
SELECT m.ROWID, m.guid, m.date, m.is_from_me, m.text, m.attributedBody,
       m.cache_has_attachments, m.associated_message_type, m.service,
       h.id  AS handle,
       c.display_name, c.chat_identifier, c.style
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.ROWID > ?
ORDER BY m.ROWID ASC
LIMIT ?
"""


def matches(handle, patterns):
    """手机号写法五花八门（+65…/65…/本地格式），所以用「后缀或包含」来比。"""
    h = (handle or "").strip().lower()
    if not h:
        return False
    for p in patterns:
        p = str(p).strip().lower()
        if not p:
            continue
        if h == p or h.endswith(p) or p in h:
            return True
    return False


def fetch_new(cfg, since):
    conn, tmpdir = open_db()
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(QUERY, (since, int(cfg["maxPerRound"]))).fetchall()
    finally:
        conn.close()
        shutil.rmtree(tmpdir, ignore_errors=True)

    out = []
    top = since
    for r in rows:
        top = max(top, r["ROWID"])

        if r["is_from_me"]:
            continue                                  # 只要别人发来的
        if not cfg["includeReactions"] and (r["associated_message_type"] or 0) != 0:
            continue                                  # tapback / 编辑之类
        is_group = (r["style"] or 0) == 43
        if is_group and not cfg["includeGroupChats"]:
            continue

        handle = r["handle"] or ""
        if cfg["onlyFrom"] and not matches(handle, cfg["onlyFrom"]):
            continue
        if cfg["ignoreFrom"] and matches(handle, cfg["ignoreFrom"]):
            continue

        text = (r["text"] or "").strip()
        if not text:
            text = decode_attributed_body(r["attributedBody"])
        kind = ""
        if not text and r["cache_has_attachments"]:
            kind = "📎 附件（正文为空）"
        if not text and not kind:
            continue                                  # 认不出来的空消息，跳过

        who = handle
        room = (r["display_name"] or "").strip()
        if is_group:
            who = (who or "?") + "（" + (room or r["chat_identifier"] or "群聊") + "）"

        out.append({
            "rowid": r["ROWID"],
            "id": r["guid"] or ("row%d" % r["ROWID"]),
            "ts": apple_ms(r["date"]),
            "author": who,
            "text": text,
            "kind": kind,
            "service": r["service"] or "",
        })
    return out, top


def push(cfg, item, dry=False):
    body = {
        "action": "inbox_push",
        "id": item["id"],
        "ts": str(item["ts"] or int(time.time() * 1000)),
        "author": _redact(item["author"]),
        "text": _redact(item["text"]),
        "kind": item["kind"],
        "source": cfg["source"],
        "tg": "1" if cfg["toTelegram"] else "0",
    }
    if dry:
        print("  [dry-run] %s | %s" % (body["author"], body["text"][:60].replace("\n", " ")))
        return True

    data = urllib.parse.urlencode(body).encode()
    req = urllib.request.Request(
        cfg["endpoint"], data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "X-Ingest-Key": cfg["ingestKey"],
                 # 必须盖掉 urllib 默认的 "Python-urllib/3.x"：Cloudflare 的
                 # Browser Integrity Check 认得这个签名，会在请求到达 Worker
                 # 之前就回一个 403（页面是 "error code: 1010"，不是我们的 JSON）。
                 # 症状是每条推送都失败，而且看起来像密钥不对 —— 其实根本没进 Worker。
                 "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            d = json.loads(res.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        print("  ! HTTP %s %s" % (e.code, detail), file=sys.stderr)
        return False
    except Exception as e:                            # noqa: BLE001
        print("  ! 发送失败: %s" % e, file=sys.stderr)
        return False
    if not d.get("ok"):
        print("  ! Worker 拒绝: %s" % d.get("description"), file=sys.stderr)
        return False
    return True


def round_once(cfg, st, dry=False):
    items, top = fetch_new(cfg, st["lastRowId"])
    if not items:
        # 没有可转发的也要推进游标，否则每轮都在重扫同一批被过滤掉的行
        if top > st["lastRowId"] and not dry:
            st["lastRowId"] = top
            save_state(st)
        return 0

    sent = 0
    last_ok = st["lastRowId"]
    for it in items:
        if not push(cfg, it, dry):
            # 发失败就停在这里，下一轮从同一条重试，不跳过、也不重复
            break
        sent += 1
        last_ok = it["rowid"]

    if not dry:
        # 全部发完了才敢跳到 top（那之间可能还有被过滤掉的行）；
        # 中途失败就只推进到「确实发出去的最后一条」。
        st["lastRowId"] = top if sent == len(items) else last_ok
        save_state(st)
    print("本轮转发 %d / %d 条" % (sent, len(items)))
    return sent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="跑一轮就退出")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不真发")
    ap.add_argument("--reset", action="store_true", help="游标挪到最新，忽略所有历史")
    args = ap.parse_args()

    cfg = load_config()
    st = load_state()

    if args.reset:
        conn, tmpdir = open_db()
        try:
            top = conn.execute("SELECT MAX(ROWID) FROM message").fetchone()[0] or 0
        finally:
            conn.close()
            shutil.rmtree(tmpdir, ignore_errors=True)
        st["lastRowId"] = top
        save_state(st)
        print("游标已挪到 ROWID=%d，之后只同步新消息" % top)
        return

    if st["lastRowId"] == 0:
        # 首次运行不要把几年的历史一次灌进去
        conn, tmpdir = open_db()
        try:
            top = conn.execute("SELECT MAX(ROWID) FROM message").fetchone()[0] or 0
        finally:
            conn.close()
            shutil.rmtree(tmpdir, ignore_errors=True)
        st["lastRowId"] = top
        save_state(st)
        print("首次运行：游标设为 ROWID=%d，只同步之后收到的消息" % top)
        if args.once:
            return

    if args.once or args.dry_run:
        round_once(cfg, st, args.dry_run)
        return

    print("iMessage 桥已启动，每 %d 秒查一次。Ctrl-C 退出。" % cfg["intervalSec"])
    while True:
        try:
            round_once(cfg, st)
        except SystemExit:
            raise
        except Exception as e:                        # noqa: BLE001
            print("! 这一轮出错（下一轮继续）: %s" % e, file=sys.stderr)
        time.sleep(max(5, int(cfg["intervalSec"])))


if __name__ == "__main__":
    main()
