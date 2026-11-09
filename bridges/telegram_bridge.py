"""Telegram bridge for ai-chatroom (bridges/telegram_bridge.py).

Imported by ~/workspace/telegram-bot/poller.py (plan A: merge into the
existing poller, so there is only ONE getUpdates consumer).

Rules (group-safe, matches the poller's own rules):
- Private chat: only messages starting with the prefix (default "聊：")
  are forwarded into the room. Everything else stays on the Atlas
  command channel and is handled by the poller as before.
- Group / supergroup: only luo's non-command messages, and only in chats
  listed in bridges-config.json telegram.chats {chat_id: room}.
- Return path (pump): room messages from other platforms go back to
  configured group chats in full; to luo's private chat only when they
  @mention him / @all, or are system messages.

The bridge token is the bridge-telegram identity's key (bridges-config.json,
0600, gitignored). It never appears in the room or in logs.
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import chatroom_client as cc
except Exception:  # noqa: BLE001
    cc = None

OWNER_ID = 854331334
PREFIXES = ("聊：", "聊:")
LOG_PATH = os.path.join(HERE, "telegram_bridge.log")


def log(line):
    try:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{ts} {line}\n")
    except Exception:
        pass


def _cfg():
    if not cc:
        return {}
    return cc.load_config().get("telegram", {}) or {}


def _display_name(msg):
    frm = msg.get("from") or {}
    name = frm.get("username") or frm.get("first_name") or "tguser"
    if frm.get("last_name"):
        name = f"{frm.get('first_name', '')} {frm['last_name']}".strip()
    return name[:30]


def _strip_prefix(text):
    for p in PREFIXES:
        if text.startswith(p):
            return text[len(p):].strip()
    return None


def handle_private(msg):
    """Private-chat message. Returns True if forwarded to the room."""
    if not cc:
        return False
    text = (msg.get("text") or "").strip()
    body = _strip_prefix(text)
    if body is None:
        return False
    res = cc.bridge_send("telegram", _display_name(msg), "human", body)
    if res.get("error"):
        log(f"forward failed: {res['error'][:200]}")
        return False
    st = cc.load_state()
    st["telegram:last_private_chat"] = msg.get("chat", {}).get("id")
    st["telegram:last_private_name"] = _display_name(msg)
    cc.save_state(st)
    return True


def handle_group(msg):
    """Group message. Returns True if forwarded to the room."""
    if not cc:
        return False
    chat = msg.get("chat") or {}
    chats = _cfg().get("chats") or {}
    room = chats.get(str(chat.get("id")))
    if not room:
        return False
    if (msg.get("from") or {}).get("id") != OWNER_ID:
        return False
    text = (msg.get("text") or "").strip()
    if not text or text.startswith("/"):
        return False
    res = cc.bridge_send("telegram", _display_name(msg), "human", text)
    if res.get("error"):
        log(f"group forward failed: {res['error'][:200]}")
        return False
    return True


def pump(send_fn):
    """Send new non-telegram room messages back to Telegram."""
    if not cc:
        return
    cfg = _cfg()
    st = cc.load_state()
    rooms = {cfg.get("room", "general")} | set((cfg.get("chats") or {}).values())
    for room in sorted(rooms):
        fresh = cc.new_messages(st, "telegram", room)
        for m in fresh:
            text = m.get("text") or ""
            name = m.get("sender_name") or "?"
            line = f"【聊天室 #{room}】{name}：{text}"
            for chat_id, target_room in (cfg.get("chats") or {}).items():
                if target_room == room:
                    try:
                        send_fn(int(chat_id), line[:4000])
                    except Exception as e:  # noqa: BLE001
                        log(f"pump to group {chat_id} failed: {e}")
            private_chat = st.get("telegram:last_private_chat")
            private_name = st.get("telegram:last_private_name") or ""
            mentions = m.get("mentions") or []
            if private_chat and (private_name in mentions or "all" in mentions
                                 or "所有人" in mentions or m.get("sender_name") == "系统"):
                try:
                    send_fn(int(private_chat), line[:4000])
                except Exception as e:  # noqa: BLE001
                    log(f"pump to private failed: {e}")
    cc.save_state(st)
