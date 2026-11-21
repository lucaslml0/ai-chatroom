#!/usr/bin/env python3
"""Set a Cloudflare Worker secret from a file (value never printed).

Usage: python3 set_secret.py <NAME> <file-with-secret>
The file should be 0600 and deleted after use.
"""
import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

ACCOUNT = "25b109c9ccd092e08e9c0d412ce0bda7"


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: set_secret.py <NAME> <file>", file=sys.stderr)
        return 2
    name, path = sys.argv[1], sys.argv[2]
    token = dynamic_credential_entry("custom.cloudflare")["surrogate"]
    env = dict(os.environ)
    env["CLOUDFLARE_API_TOKEN"] = token
    env["CLOUDFLARE_ACCOUNT_ID"] = ACCOUNT
    with open(path, "rb") as f:
        value = f.read()
    print(f"setting secret {name} ...", flush=True)
    r = subprocess.run(["npx", "-y", "wrangler@4", "secret", "put", name],
                       cwd=os.path.dirname(os.path.abspath(__file__)),
                       env=env, input=value, timeout=120)
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
