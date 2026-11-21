#!/usr/bin/env python3
"""Set a Cloudflare Pages secret from a file (value never printed).

Usage: python3 set_pages_secret.py <NAME> <file-with-secret>
Runs `wrangler pages secret put` from pages-config/ so the project
config is picked up. Value is piped via stdin (no trailing newline in file).
"""
import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

ACCOUNT = "25b109c9ccd092e08e9c0d412ce0bda7"
HERE = os.path.dirname(os.path.abspath(__file__))


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: set_pages_secret.py <NAME> <file>", file=sys.stderr)
        return 2
    name, path = sys.argv[1], sys.argv[2]
    token = dynamic_credential_entry("custom.cloudflare")["surrogate"]
    env = dict(os.environ)
    env["CLOUDFLARE_API_TOKEN"] = token
    env["CLOUDFLARE_ACCOUNT_ID"] = ACCOUNT
    with open(path, "rb") as f:
        value = f.read()
    print(f"setting pages secret {name} ...", flush=True)
    r = subprocess.run(
        ["npx", "-y", "wrangler@4", "pages", "secret", "put", name,
         "--project-name", "ai-chatroom"],
        cwd=os.path.join(HERE, "pages-config"),
        env=env, input=value, timeout=120)
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
