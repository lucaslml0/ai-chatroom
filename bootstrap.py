#!/usr/bin/env python3
"""Bootstrap ai-chatroom owner + Moderator + bridge identities.

Reads the setup key from /tmp/setup_key.txt (0600), creates the owner
identity via POST /api/admin/bootstrap, then creates Moderator and
wechat/telegram bridge identities with the owner token. Tokens are saved
to 0600 files next to this script (gitignored) and NEVER printed.
Usage: python3 bootstrap.py
Outputs (no secrets): names, ids, and where each token was saved.
"""
import json
import os
import urllib.request

BASE = "https://muse-chatroom.luluo.workers.dev"
HERE = os.path.dirname(os.path.abspath(__file__))


def call(method, path, body=None, token=None):
    # 注意：沙箱里 Python urllib 直连 workers.dev 的 POST 会挂起超时，
    # 改走 curl（cf.py 也是这个原因用的 curl）。
    import subprocess
    cmd = ["curl", "-s", "-m", "60", "-X", method, BASE + path,
           "-H", "Content-Type: application/json"]
    if token:
        cmd += ["-H", "Authorization: Bearer " + token]
    if body is not None:
        cmd += ["-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=70)
    return json.loads(out.stdout or "{}")


def save(name, token):
    p = os.path.join(HERE, name)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    print(f"saved {name}")


def main():
    with open("/tmp/setup_key.txt") as f:
        setup_key = f.read().strip()
    owner = call("POST", "/api/admin/bootstrap", {"setup_key": setup_key, "name": "luo"})
    if "token" not in owner:
        print("bootstrap failed:", owner)
        return 1
    owner_token = owner["token"]
    save(".owner-token", owner_token)
    print(f"owner: {owner['name']} id={owner['id']} role=owner")
    mod = call("POST", "/api/admin/create-key",
               {"name": "Moderator", "type": "bot", "platform": "web", "role": "moderator",
                "purpose": "小管家 Moderator（Workers AI）"}, token=owner_token)
    if "token" not in mod:
        print("moderator create failed:", mod)
        return 1
    save(".moderator-token", mod["token"])
    print(f"moderator: {mod['name']} id={mod['id']} role=moderator")
    for bridge, label in (("wechat", "微信桥"), ("telegram", "Telegram 桥")):
        b = call("POST", "/api/admin/create-key",
                 {"name": f"bridge-{bridge}", "type": "bot", "platform": bridge,
                  "bridge": bridge, "purpose": f"{label}桥接身份"}, token=owner_token)
        if "token" not in b:
            print(f"bridge {bridge} failed:", b)
            return 1
        print(f"bridge {bridge}: id={b['id']}")
        cfg = {}
        cfg_path = os.path.join(HERE, "bridges-config.json")
        if os.path.exists(cfg_path):
            with open(cfg_path) as f:
                cfg = json.load(f)
        cfg[bridge] = {"token": b["token"], "room": "general"}
        fd = os.open(cfg_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    print("bridges-config.json updated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
