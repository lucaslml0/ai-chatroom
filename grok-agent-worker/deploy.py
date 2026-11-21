#!/usr/bin/env python3
"""Deploy / set secrets for the ai-chatroom-grok Worker.

Local deploy helper (NOT pushed to GitHub — same rule as deploy.py).
Usage (run from ~/workspace/muse-chatroom/grok-agent-worker):
  python3 deploy.py deploy                  deploy the Worker
  python3 deploy.py secret <NAME> <file>    set a Worker secret from a file
Gets the API token surrogate via dynamic_credentials (never printed).
"""
import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

ACCOUNT = "25b109c9ccd092e08e9c0d412ce0bda7"


def _env():
    token = dynamic_credential_entry("custom.cloudflare")["surrogate"]
    env = dict(os.environ)
    env["CLOUDFLARE_API_TOKEN"] = token
    env["CLOUDFLARE_ACCOUNT_ID"] = ACCOUNT
    return env


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    if len(sys.argv) >= 2 and sys.argv[1] == "deploy":
        print("deploying ai-chatroom-grok worker ...", flush=True)
        r = subprocess.run(["npx", "-y", "wrangler@4", "deploy"],
                           cwd=here, env=_env(), text=True, timeout=300)
        return r.returncode
    if len(sys.argv) == 4 and sys.argv[1] == "secret":
        name, path = sys.argv[2], sys.argv[3]
        with open(path, "rb") as f:
            value = f.read()
        print(f"setting secret {name} ...", flush=True)
        r = subprocess.run(["npx", "-y", "wrangler@4", "secret", "put", name],
                           cwd=here, env=_env(), input=value, timeout=120)
        return r.returncode
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
