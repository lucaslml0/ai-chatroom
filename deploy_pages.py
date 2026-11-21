#!/usr/bin/env python3
"""Deploy ai-chatroom to Cloudflare Pages.

Architecture (see PLAN.md §1): Pages is the public front door (static
assets + API/WS via _worker.js). It CANNOT host the Durable Object or the
Cron Trigger -- those stay in the Worker `muse-chatroom`, and Pages binds
to that Worker's DO with script_name (see wrangler.pages.toml). No data
moves: the Pages deployment reads the SAME DO namespace, so every Token
keeps working.

Build: copies public/* into pages/ and generates pages/_worker.js from
src/index.js with the `export class ChatRoom` block removed (the class
lives in the Worker; Pages only needs the default fetch handler).
Usage: python3 deploy_pages.py
"""
import os
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry
from build_pages import build

ACCOUNT = "25b109c9ccd092e08e9c0d412ce0bda7"
HERE = os.path.dirname(os.path.abspath(__file__))


def main() -> int:
    print(build())
    token = dynamic_credential_entry("custom.cloudflare")["surrogate"]
    env = dict(os.environ)
    env["CLOUDFLARE_API_TOKEN"] = token
    env["CLOUDFLARE_ACCOUNT_ID"] = ACCOUNT
    # `wrangler pages deploy` does not accept --config with a custom path,
    # so run it from pages-config/ where wrangler.toml lives.
    r = subprocess.run(
        ["npx", "-y", "wrangler@4", "pages", "deploy", "../pages",
         "--project-name", "ai-chatroom", "--branch", "main",
         "--commit-dirty=true"],
        cwd=os.path.join(HERE, "pages-config"), env=env, timeout=300)
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
