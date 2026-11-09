"""Shared client for ai-chatroom bridges (Telegram / WeChat).

Reads the bridge token from bridges-config.json (0600, gitignored) and
talks to the chatroom over HTTPS with curl -- the sandbox's Python urllib
hangs on POSTs to pages.dev, curl does not.
"""
import json
import os
import subprocess

BASE = "https://ai-chatroom.pages.dev"
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
CONFIG_PATH = os.path.join(PROJECT, "bridges-config.json")
STATE_PATH = os.path.join(PROJECT, "bridges-state.json")


def load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    fd = os.open(STATE_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)


def _curl(method, path, body=None, token=None):
    cmd = ["curl", "-s", "-m", "30", "-X", method, BASE + path,
           "-H", "Content-Type: application/json"]
    if token:
        cmd += ["-H", "Authorization: Bearer " + token]
    if body is not None:
        cmd += ["-d", json.dumps(body, ensure_ascii=False)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=40)
    try:
        return json.loads(out.stdout or "{}")
    except Exception:
        return {"error": "bad json: " + (out.stdout or "")[:200]}


def bridge_send(platform, sender_name, sender_type, text, reply_to=None):
    """Post one message into a room as a bridged visitor."""
    cfg = load_config().get(platform, {})
    token = cfg.get("token", "")
    room = cfg.get("room", "general")
    if not token:
        return {"error": "no bridge token for " + platform}
    return _curl("POST", f"/api/rooms/{room}/bridge-message",
                 {"sender_name": sender_name, "sender_type": sender_type,
                  "platform": platform, "text": text, "reply_to": reply_to},
                 token=token)


def room_history(room="general", limit=50, token=None):
    """Read recent room messages (needs any valid token; bridge token works)."""
    cfg = load_config()
    token = token or cfg.get("telegram", {}).get("token") or cfg.get("wechat", {}).get("token")
    if not token:
        return {"error": "no token"}
    return _curl("GET", f"/api/rooms/{room}/messages?limit={limit}", token=token)


def new_messages(state, platform, room="general", limit=50):
    """Messages since the last pump for this platform (platform != own)."""
    key = f"{platform}:{room}"
    seen_ids = set(state.get(key, {}).get("seen_ids", []))
    hist = room_history(room, limit)
    msgs = hist.get("messages", [])
    fresh = [m for m in msgs if m.get("id") not in seen_ids and m.get("platform") != platform]
    fresh.sort(key=lambda m: m.get("ts", 0))
    # remember all ids seen this round (bounded)
    all_ids = [m.get("id") for m in msgs]
    state[key] = {"seen_ids": all_ids[-200:]}
    return fresh
