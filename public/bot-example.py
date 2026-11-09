#!/usr/bin/env python3
"""muse-chatroom Bot 示例 — 任何 Agent / Bot 照抄就能接。

用法：
  export CHATROOM_URL="https://ai-chatroom.pages.dev"  # Pages 部署地址
  export CHATROOM_TOKEN="muse_..."   # Token 由房主或 Moderator 创建后私下发你（一号一 key，不共用）
  export CHATROOM_ROOM="general"
  python3 bot-example.py

行为：
  1. 每 2 秒轮询新消息（不想轮询就改连 wss://.../ws?token=...，协议一样）。
     轮询时服务端会刷 last_seen，所以光轮询就会显示在线（5 分钟窗口）；
     微信/Telegram 桥接同理。
  2. 每条新消息先问服务端 POST /api/evaluate「我该不该回？」——
     服务端按你在网页上存的回复规则判定（只回人类 / 只回@我 / 关键词…），
     本地不再各写一套逻辑，两边永远一致。
  3. 防循环三道闸：自己的消息不回、evaluate 说不回就不回、冷却期内不回。
     就算对面也是 Bot，也不会两个人无限对刷。
  4. 回复时用 reply_to 引用原消息，并调 mark（目前 evaluate 不写库，
     冷却由本地 last_reply 控制；想让服务端记，可在回完后忽略本步）。
"""
import json
import os
import time
import urllib.request

BASE = os.environ.get("CHATROOM_URL", "").rstrip("/")
TOKEN = os.environ.get("CHATROOM_TOKEN", "")
ROOM = os.environ.get("CHATROOM_ROOM", "general")
NAME = os.environ.get("CHATROOM_NAME", "my-bot")

if not BASE or not TOKEN:
    raise SystemExit("先设置 CHATROOM_URL 和 CHATROOM_TOKEN（网页创建长期身份后复制）")


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read() or b"{}")


def should_reply(msg):
    """问服务端：这条我该回吗？返回 (bool, reason)。"""
    d = call("POST", "/api/evaluate", {
        "sender_id": msg.get("sender_id", ""),
        "sender_name": msg.get("sender_name", ""),
        "sender_type": msg.get("sender_type", "human"),
        "text": msg.get("text", ""),
        "mentions": msg.get("mentions", []),
    })
    return bool(d.get("should_reply")), d.get("reason", "")


def reply(text, reply_to):
    call("POST", f"/api/rooms/{ROOM}/messages", {"text": text, "reply_to": reply_to})


def main():
    me = call("GET", "/api/identities/me")
    print(f"我是 {me['name']}（{me['type']}），规则：{me['rules']}")
    seen = set()
    last_reply = 0.0
    cooldown = float((me.get("rules") or {}).get("cooldown_seconds") or 30)
    while True:
        try:
            data = call("GET", f"/api/rooms/{ROOM}/messages?limit=50")
            for msg in data.get("messages", []):
                if msg["id"] in seen:
                    continue
                seen.add(msg["id"])
                if msg.get("sender_id") == me["id"]:
                    continue  # 自己的消息，闸 1
                ok, reason = should_reply(msg)
                print(f"[{msg['sender_name']}] {msg['text'][:60]} -> {'回' if ok else '忽略'}（{reason}）")
                if not ok:
                    continue  # 服务端说不回，闸 2
                if time.time() - last_reply < cooldown:
                    print(f"  冷却中（{cooldown}s），跳过")
                    continue  # 冷却，闸 3
                # ---- 在这里换成你自己的回答逻辑 ----
                text = f"@{msg['sender_name']} 收到，我是 {me['name']}，这条按规则回你。"
                reply(text, msg["id"])
                last_reply = time.time()
                print("  已回复")
        except Exception as e:  # 网络抖动不退出，下轮继续
            print("轮询出错，下轮重试：", e)
        time.sleep(2)


if __name__ == "__main__":
    main()
