#!/usr/bin/env python3
"""Deploy muse-chatroom Worker with wrangler.

Usage: python3 deploy.py   (run from ~/workspace/muse-chatroom)
Gets the API token surrogate via dynamic_credentials (never printed),
sets CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, runs `wrangler deploy`.
"""
import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

ACCOUNT = "25b109c9ccd092e08e9c0d412ce0bda7"


def main() -> int:
    token = dynamic_credential_entry("custom.cloudflare")["surrogate"]
    env = dict(os.environ)
    env["CLOUDFLARE_API_TOKEN"] = token
    env["CLOUDFLARE_ACCOUNT_ID"] = ACCOUNT
    print("deploying muse-chatroom worker ...", flush=True)
    r = subprocess.run(["npx", "-y", "wrangler@4", "deploy"],
                       cwd=os.path.dirname(os.path.abspath(__file__)),
                       env=env, text=True, timeout=300)
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
