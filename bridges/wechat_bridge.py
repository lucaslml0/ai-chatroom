#!/usr/bin/env python3
"""WeChat bridge for ai-chatroom (bridges/wechat_bridge.py).

Standalone loop. It does NOT call getupdates itself -- the existing
~/workspace/wechat-bridge/poller.py already owns getupdates and writes
inbound messages to inbox/*.json. This bridge only watches that directory,
so there is no second getUpdates consumer stealing updates.

Rules:
- Forward path: only inbox messages starting with the prefix (default
  "聊：") go into the room. Everything else is an Atlas command and is
  left to the poller/hook as before.
- Return path: room messages from other platforms go back to WeChat only
  when they @mention the WeChat display name / @all, or are system
  messages (the WeChat side is a 1:1 private chat; flooding it with the
  whole room would be noise).
- Replies use ilink.send_text with the context_token from the newest
  inbox file (24h window). If the context expired, the send fails and
  is logged, not retried.

Run: python3 bridges/wechat_bridge.py  (log: bridges/wechat_bridge.log)
"""
import glob
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.expanduser("~/workspace/wechat-bridge"))

import chatroom_client as cc
import ilink

WECHAT_BRIDGE = os.path.expanduser("~/workspace/wechat-bridge")
INBOX_DIR = os.path.join(WECHAT_BRIDGE, "inbox")
LOG_PATH = os.path.join(HERE, "wechat_bridge.log")
PREFIXES = ("聊：", "聊:")


def log(line):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"{ts} {line}\n")


def _strip_prefix(text):
    for p in PREFIXES:
        if text.startswith(p):
            return text[len(p):].strip()
    return None


def _display_name():
    cfg = cc.load_config().get("wechat", {})
    return cfg.get("display_name") or "微信访客"


def forward_inbox(state):
    """Forward new prefixed inbox messages into the room."""
    processed = set(state.get("wechat:processed_inbox", []))
    files = sorted(glob.glob(os.path.join(INBOX_DIR, "*.json")))
    newest_ctx, newest_from = None, None
    for path in files:
        try:
            with open(path, encoding="utf-8") as f:
                msg = json.load(f)
        except Exception:
            continue
        mid = str(msg.get("message_id", os.path.basename(path)))
        if msg.get("context_token"):
            newest_ctx, newest_from = msg.get("context_token"), msg.get("from_user_id")
        if mid in processed:
            continue
        processed.add(mid)
        text = ilink.extract_text(msg).strip()
        body = _strip_prefix(text) if text else None
        if body is None:
            continue
        res = cc.bridge_send("wechat", _display_name(), "human", body)
        if res.get("error"):
            log(f"forward {mid} failed: {res['error'][:200]}")
        else:
            log(f"forwarded inbox {mid}: {body[:60]!r}")
    state["wechat:processed_inbox"] = sorted(processed)[-500:]
    if newest_ctx:
        state["wechat:last_context"] = newest_ctx
        state["wechat:last_from"] = newest_from
    return state


def pump(state):
    """Send @-mentions / system messages from the room back to WeChat."""
    cfg = cc.load_config().get("wechat", {})
    room = cfg.get("room", "general")
    fresh = cc.new_messages(state, "wechat", room)
    if not fresh:
        return state
    to_user = state.get("wechat:last_from")
    ctx = state.get("wechat:last_context")
    if not to_user:
        log("pump skipped: no wechat user seen yet")
        return state
    acct = ilink.load_account()
    if not acct:
        log("pump skipped: wechat not bound")
        return state
    token = acct["bot_token"]
    base = acct.get("baseurl", ilink.BASE_URL)
    name = _display_name()
    for m in fresh:
        mentions = m.get("mentions") or []
        if not (name in mentions or "all" in mentions or "所有人" in mentions
                or m.get("sender_name") == "系统"):
            continue
        text = f"【聊天室 #{room}】{m.get('sender_name') or '?'}：{m.get('text') or ''}"
        try:
            r = ilink.send_text(token, to_user, text[:1000], ctx, base)
            if r.get("ret") not in (0, None):
                log(f"pump send failed ret={r.get('ret')} errmsg={r.get('errmsg')}")
        except Exception as e:  # noqa: BLE001
            log(f"pump send error: {str(e)[:200]}")
    return state


def main():
    log("wechat bridge started")
    state = cc.load_state()
    while True:
        try:
            state = forward_inbox(state)
            state = pump(state)
            cc.save_state(state)
        except Exception as e:  # noqa: BLE001
            log(f"loop error: {str(e)[:200]}")
        time.sleep(5)


if __name__ == "__main__":
    main()
