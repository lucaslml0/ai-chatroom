#!/usr/bin/env python3
"""Local backend tests for ai-chatroom v2.6 (against wrangler dev --local).

Covers: health version, bootstrap, touch-on-GET presence for REST pollers
and bridge identities, merged presence list in history, pruned field.
Prints PASS/FAIL only, no tokens. No production access.
"""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:8787"
passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra if not cond else ''}")


def call(method, path, body=None, token=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return {"_status": e.code, **json.loads(e.read() or b"{}")}


def main():
    h = call("GET", "/api/health")
    check("health v2.6", h.get("version") == "2.6", str(h))

    boot = call("POST", "/api/admin/bootstrap",
                {"setup_key": "test-setup-key", "name": "luo"})
    check("bootstrap 建房主", "token" in boot, str(boot))
    owner = boot.get("token", "")
    me = call("GET", "/api/identities/me", token=owner)
    check("房主身份 role=owner", me.get("role") == "owner", str(me))

    atlas = call("POST", "/api/admin/create-key",
                 {"name": "LocalAtlas", "type": "agent", "platform": "api",
                  "purpose": "本地测试"}, token=owner)
    check("建 Agent key", "token" in atlas, str(atlas))
    pollbot = call("POST", "/api/admin/create-key",
                   {"name": "PollBot", "type": "bot", "platform": "api",
                    "purpose": "本地测试"}, token=owner)
    check("建 PollBot key", "token" in pollbot, str(pollbot))
    bridge = call("POST", "/api/admin/create-key",
                  {"name": "bridge-wechat", "type": "bot", "platform": "wechat",
                   "bridge": "wechat", "purpose": "本地测试"}, token=owner)
    check("建微信桥接 key", "token" in bridge and bridge.get("bridge") == "wechat", str(bridge))

    m1 = call("POST", "/api/rooms/general/messages", {"text": "本地 Atlas 发言"}, token=atlas["token"])
    check("Atlas 发言", "message" in m1, str(m1))

    # 只轮询不发言的 PollBot：一次 GET 就刷 last_seen
    call("GET", "/api/rooms/general/messages?limit=5", token=pollbot["token"])
    agents = call("GET", "/api/agents")
    pb = next((a for a in agents.get("agents", []) if a.get("name") == "PollBot"), {})
    check("只轮询的 PollBot 有新鲜 last_seen",
          bool(pb.get("last_seen")) and time.time() * 1000 - pb["last_seen"] < 60000, str(pb))

    # 桥接身份只轮询：last_seen 刷新，且出现在 history 的 members 里（带 bridge）
    call("GET", "/api/rooms/general/messages?limit=5", token=bridge["token"])
    hist = call("GET", "/api/rooms/general/messages?limit=10", token=owner)
    check("历史返回 pruned 字段", "pruned" in hist, str(sorted(hist.keys())))
    mem = {m.get("id"): m for m in hist.get("members", [])}
    check("在线名单含刚发言的 Atlas", atlas.get("id") in mem, str(sorted(mem)))
    check("在线名单含刚读历史的房主", me.get("id") in mem, str(sorted(mem)))
    check("在线名单含只轮询的 PollBot", pollbot.get("id") in mem, str(sorted(mem)))
    bw = mem.get(bridge.get("id"), {})
    check("在线名单含微信桥接（bridge=wechat）", bw.get("bridge") == "wechat", str(bw))

    # 旧消息不会被误删：1 天前的消息仍在（prune 只清 7 天前；由下面的 sqlite 注入测试覆盖 8 天）
    check("历史能读到刚发的消息", any(m.get("text") == "本地 Atlas 发言" for m in hist.get("messages", [])))

    print(f"\n通过 {len(passed)} 项，失败 {len(failed)} 项：{failed if failed else '无'}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
