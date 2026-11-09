#!/usr/bin/env python3
"""Live bridge simulation tests (no real Telegram/WeChat messages sent).

- TG: fake private message "聊：..." -> handle_private -> room history;
  pump with a recording send_fn (nothing is actually sent to Telegram).
- WeChat: fake inbox file -> forward_inbox -> room history; pump with a
  fake recipient id (iLink rejects it, logged) so no real WeChat message.
Cleans up its test messages and bridge state afterwards.
Usage: python3 bridges/test_bridges.py
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import chatroom_client as cc
import telegram_bridge as tg

BASE = "https://muse-chatroom.luluo.workers.dev"
OWNER = open(os.path.join(os.path.dirname(HERE), ".owner-token")).read().strip()
passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra if not cond else ''}")


def api(method, path, body=None):
    cmd = ["curl", "-s", "-m", "30", "-X", method, BASE + path,
           "-H", "Content-Type: application/json",
           "-H", "Authorization: Bearer " + OWNER]
    if body is not None:
        cmd += ["-d", json.dumps(body, ensure_ascii=False)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
    try:
        return json.loads(out.stdout or "{}")
    except Exception:
        return {"error": out.stdout[:200]}


def history():
    return api("GET", "/api/rooms/general/messages?limit=50").get("messages", [])


def delete_msg(mid):
    api("POST", "/api/admin/delete-message", {"room": "general", "message_id": mid})


def main():
    # --- Telegram forward ---
    fake = {"chat": {"id": 854331334, "type": "private"},
            "from": {"id": 854331334, "username": "dissipator", "first_name": "luo"},
            "text": "聊：TG 桥接测试"}
    check("TG 私聊 聊： 转发", tg.handle_private(fake) is True)
    time.sleep(1)
    msgs = history()
    tg_msg = next((m for m in msgs if m.get("text") == "TG 桥接测试"), None)
    check("TG 消息进房且 platform=telegram",
          tg_msg is not None and tg_msg.get("platform") == "telegram"
          and tg_msg.get("sender_id", "").startswith("ext_telegram_"),
          str(tg_msg))
    # --- Telegram pump (recording send_fn only) ---
    q = api("POST", "/api/rooms/general/messages",
            {"text": "@dissipator 收到 TG 桥接测试了吗"})
    check("房里 @TG 用户提问发出", "message" in q, str(q))
    sent = []

    def recorder(chat_id, text):
        sent.append((chat_id, text))

    tg.pump(recorder)
    hit = [s for s in sent if s[0] == 854331334 and "收到 TG 桥接测试" in s[1]]
    check("TG pump 回推到 luo 私聊（录制，未真发）", len(hit) >= 1, str(sent))
    # clear bridge private-chat state so the real poller sends nothing
    st = cc.load_state()
    st.pop("telegram:last_private_chat", None)
    st.pop("telegram:last_private_name", None)
    cc.save_state(st)
    if tg_msg:
        delete_msg(tg_msg["id"])
    if "message" in q:
        delete_msg(q["message"]["id"])

    # --- WeChat forward (fake inbox file) ---
    import wechat_bridge as wb
    inbox_dir = os.path.expanduser("~/workspace/wechat-bridge/inbox")
    fake_path = os.path.join(inbox_dir, "bridge-test-1.json")
    with open(fake_path, "w", encoding="utf-8") as f:
        json.dump({"message_id": 999900001, "from_user_id": "test_user@im.wechat",
                   "context_token": "test",
                   "item_list": [{"type": 1, "text_item": {"text": "聊：微信桥接测试"}}]},
                  f, ensure_ascii=False)
    st = cc.load_state()
    st = wb.forward_inbox(st)
    cc.save_state(st)
    time.sleep(1)
    msgs = history()
    wc_msg = next((m for m in msgs if m.get("text") == "微信桥接测试"), None)
    check("微信 inbox 聊： 转发进房且 platform=wechat",
          wc_msg is not None and wc_msg.get("platform") == "wechat"
          and wc_msg.get("sender_id", "").startswith("ext_wechat_"),
          str(wc_msg))
    # --- WeChat pump (fake recipient: iLink rejects, logged, nothing real sent) ---
    st = cc.load_state()
    st["wechat:last_from"] = "test_user@im.wechat"
    st["wechat:last_context"] = "test"
    cc.save_state(st)
    q2 = api("POST", "/api/rooms/general/messages", {"text": "@微信访客 收到微信桥接测试了吗"})
    check("房里 @微信访客提问发出", "message" in q2, str(q2))
    st = cc.load_state()
    st = wb.pump(st)
    cc.save_state(st)
    log = ""
    try:
        with open(os.path.join(HERE, "wechat_bridge.log"), encoding="utf-8") as f:
            log = f.read()
    except Exception:
        pass
    check("微信 pump 尝试回推（被 iLink 拒绝，已记日志，未真发）",
          "pump send" in log, log[-300:])
    # cleanup
    st = cc.load_state()
    st.pop("wechat:last_from", None)
    st.pop("wechat:last_context", None)
    cc.save_state(st)
    if wc_msg:
        delete_msg(wc_msg["id"])
    if "message" in q2:
        delete_msg(q2["message"]["id"])
    try:
        os.remove(fake_path)
    except Exception:
        pass

    print(f"\n通过 {len(passed)} 项，失败 {len(failed)} 项：{failed if failed else '无'}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
