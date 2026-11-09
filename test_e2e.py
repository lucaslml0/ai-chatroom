#!/usr/bin/env python3
"""End-to-end tests for ai-chatroom v2.6. Prints PASS/FAIL only, no tokens.

Usage: python3 test_e2e.py
Reads tokens from .owner-token / .moderator-token / bridges-config.json (0600).
"""
import json
import os
import subprocess
import sys
import time

BASE = "https://muse-chatroom.luluo.workers.dev"
HERE = os.path.dirname(os.path.abspath(__file__))
passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra if not cond else ''}")


def curl(method, path, body=None, token=None):
    cmd = ["curl", "-s", "-m", "60", "-X", method, BASE + path,
           "-H", "Content-Type: application/json"]
    if token:
        cmd += ["-H", "Authorization: Bearer " + token]
    if body is not None:
        cmd += ["-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=70)
    try:
        return json.loads(out.stdout or "{}")
    except Exception:
        return {"_raw": out.stdout, "_err": out.stderr}


def read(p):
    with open(os.path.join(HERE, p)) as f:
        return f.read().strip()


def main():
    owner = read(".owner-token")
    mod = read(".moderator-token")
    with open(os.path.join(HERE, "bridges-config.json")) as f:
        bridges = json.load(f)
    tg_bridge = bridges["telegram"]["token"]

    # 1. health + 准入
    h = curl("GET", "/api/health")
    check("health v2.6", h.get("version") == "2.6")
    check("无 Token 读消息被 401", curl("GET", "/api/rooms/general/messages").get("error") is not None)
    check("无 Token 发消息被 401", curl("POST", "/api/rooms/general/messages", {"text": "x"}).get("error") is not None)

    # 2. 房主身份 + 建 key
    me = curl("GET", "/api/identities/me", token=owner)
    check("房主身份 role=owner", me.get("role") == "owner" and me.get("name") == "luo", str(me))
    atlas = curl("POST", "/api/admin/create-key",
                 {"name": "Atlas", "type": "agent", "platform": "api", "purpose": "e2e 测试"}, token=owner)
    check("房主建 Atlas key", "token" in atlas, str(atlas))
    atlas_tok = atlas.get("token", "")
    testbot = curl("POST", "/api/admin/create-key",
                   {"name": "TestBot", "type": "bot", "platform": "api", "purpose": "e2e 测试"}, token=owner)
    check("房主建 TestBot key", "token" in testbot, str(testbot))
    testbot_tok = testbot.get("token", "")
    # Moderator 建 key → 进私信箱
    modkey = curl("POST", "/api/admin/create-key",
                  {"name": "Grok", "type": "agent", "platform": "api", "purpose": "e2e 测试"}, token=mod)
    check("Moderator 建 key", "token" in modkey and "私信箱" in (modkey.get("note") or ""), str(modkey))
    grok_tok = modkey.get("token", "")
    inbox = curl("GET", "/api/admin/key-inbox", token=owner)
    check("房主私信箱有待分发 key", len(inbox.get("inbox", [])) >= 3, str(inbox))

    # 3. 发言 + 历史
    m1 = curl("POST", "/api/rooms/general/messages", {"text": "大家好，我是 Atlas"}, token=atlas_tok)
    check("Atlas 发言", "message" in m1 and m1["message"].get("platform") == "api", str(m1))
    m2 = curl("POST", "/api/rooms/general/messages", {"text": "hi，我是 luo"}, token=owner)
    check("房主发言", "message" in m2, str(m2))
    hist = curl("GET", "/api/rooms/general/messages?limit=10", token=owner)
    check("历史能读到两人消息", len(hist.get("messages", [])) >= 2, str(len(hist.get("messages", []))))

    # 3b. v2.6 在线 + 保留期：历史返回 pruned 字段；在线名单含刚活动的身份
    check("历史返回 pruned 字段（保留期清理在跑）", "pruned" in hist, str(sorted(hist.keys())))
    mem_ids = {m.get("id") for m in hist.get("members", [])}
    check("在线名单含刚发言的 Atlas", atlas.get("id") in mem_ids, str(mem_ids))
    check("在线名单含刚读历史的房主", me.get("id") in mem_ids, str(mem_ids))
    # 只轮询不发言的 REST Bot：一次 GET 历史就刷 last_seen，出现在 /api/agents 里
    pollbot = curl("POST", "/api/admin/create-key",
                   {"name": "PollBot", "type": "bot", "platform": "api", "purpose": "e2e 测试在线"}, token=owner)
    check("房主建 PollBot key", "token" in pollbot, str(pollbot))
    curl("GET", "/api/rooms/general/messages?limit=5", token=pollbot.get("token", ""))
    agents = curl("GET", "/api/agents")
    pb = next((a for a in agents.get("agents", []) if a.get("name", "").startswith("PollBot")), {})
    check("只轮询的 PollBot 有新鲜 last_seen（在线）",
          bool(pb.get("last_seen")) and time.time() * 1000 - pb["last_seen"] < 60000, str(pb))

    # 4. evaluate 规则
    ev1 = curl("POST", "/api/evaluate",
               {"sender_name": "luo", "sender_type": "human", "text": "你好"}, token=atlas_tok)
    check("evaluate：人类消息应回", ev1.get("should_reply") is True, str(ev1))
    grok_msg = curl("POST", "/api/rooms/general/messages", {"text": "我是 Grok"}, token=grok_tok)
    check("Grok 发言", "message" in grok_msg, str(grok_msg))
    ev2 = curl("POST", "/api/evaluate",
               {"sender_name": "Grok", "sender_type": "agent", "sender_id": grok_msg.get("message", {}).get("sender_id", ""),
                "text": "我是 Grok"}, token=atlas_tok)
    check("evaluate：Agent 消息默认忽略", ev2.get("should_reply") is False, str(ev2))
    ev3 = curl("POST", "/api/evaluate",
               {"sender_name": "luo", "sender_type": "human", "text": "@Atlas 邀请码怎么换？"}, token=atlas_tok)
    check("evaluate：@提及应回", ev3.get("should_reply") is True, str(ev3))

    # 4b. 房主代设成员回复规则（PUT /api/admin/identities/:id/rules，仅房主）
    ids = curl("GET", "/api/admin/identities", token=owner)
    tb = next((i for i in ids.get("identities", []) if i.get("name") == "TestBot"), {})
    check("成员列表带 rules", isinstance(tb.get("rules"), dict) and "mode" in tb.get("rules", {}), str(tb.get("rules")))
    denied = curl("PUT", f"/api/admin/identities/{tb.get('id', 'u_x')}/rules",
                  {"rules": {"mode": "all"}}, token=mod)
    check("Moderator 代设规则被 403", "error" in denied, str(denied))
    setr = curl("PUT", f"/api/admin/identities/{tb.get('id', 'u_x')}/rules",
                {"rules": {"mode": "mentions_only", "cooldown_seconds": 60}}, token=owner)
    check("房主代设 TestBot 规则", setr.get("rules", {}).get("mode") == "mentions_only", str(setr))
    ids2 = curl("GET", "/api/admin/identities", token=owner)
    tb2 = next((i for i in ids2.get("identities", []) if i.get("name") == "TestBot"), {})
    check("代设后列表读到新规则", tb2.get("rules", {}).get("mode") == "mentions_only"
          and tb2.get("rules", {}).get("cooldown_seconds") == 60, str(tb2.get("rules")))

    # 5. 审批流：Moderator 申请禁言 TestBot → 房主批准 → 禁言生效 → 解禁
    direct = curl("POST", "/api/admin/mute", {"target_id": "u_x", "minutes": 10}, token=mod)
    check("Moderator 直接禁言被 403", "error" in direct, str(direct))
    tb_me = curl("GET", "/api/identities/me", token=testbot_tok)
    ap = curl("POST", "/api/admin/request-action",
              {"action": "mute", "target_id": tb_me.get("id"), "target_name": "TestBot",
               "reason": "e2e 测试禁言", "minutes": 10}, token=mod)
    check("Moderator 发起禁言审批", "id" in ap, str(ap))
    ap_id = ap.get("id", "")
    send_before = curl("POST", "/api/rooms/general/messages", {"text": "禁言前"}, token=testbot_tok)
    check("批准前 TestBot 还能发言", "message" in send_before, str(send_before))
    ok = curl("POST", "/api/admin/approve", {"approval_id": ap_id}, token=owner)
    check("房主批准禁言", ok.get("ok") is True, str(ok))
    send_muted = curl("POST", "/api/rooms/general/messages", {"text": "禁言中"}, token=testbot_tok)
    check("禁言后 TestBot 发言被拒", "error" in send_muted, str(send_muted))
    un = curl("POST", "/api/admin/unmute", {"target_id": tb_me.get("id")}, token=owner)
    check("房主解禁", un.get("ok") is True, str(un))
    send_after = curl("POST", "/api/rooms/general/messages", {"text": "解禁后"}, token=testbot_tok)
    check("解禁后 TestBot 能发言", "message" in send_after, str(send_after))

    # 6. 吊销审批：Moderator 申请吊销 TestBot → 房主批准 → key 失效
    ap2 = curl("POST", "/api/admin/request-action",
               {"action": "revoke-key", "target_id": tb_me.get("id"), "target_name": "TestBot",
                "reason": "e2e 测试吊销"}, token=mod)
    check("Moderator 发起吊销审批", "id" in ap2, str(ap2))
    ok2 = curl("POST", "/api/admin/approve", {"approval_id": ap2.get("id")}, token=owner)
    check("房主批准吊销", ok2.get("ok") is True, str(ok2))
    dead = curl("GET", "/api/identities/me", token=testbot_tok)
    check("吊销后 TestBot key 失效", "error" in dead, str(dead))

    # 7. 桥接
    b1 = curl("POST", "/api/rooms/general/bridge-message",
              {"sender_name": "tguser", "sender_type": "human", "platform": "telegram",
               "text": "你好，我从 TG 来"}, token=tg_bridge)
    check("TG 桥接写入", "message" in b1 and b1["message"].get("platform") == "telegram"
          and b1["message"].get("sender_id", "").startswith("ext_telegram_"), str(b1))
    b2 = curl("POST", "/api/rooms/general/bridge-message",
              {"sender_name": "x", "sender_type": "human", "platform": "wechat", "text": "x"}, token=tg_bridge)
    check("桥接 platform 不符被 403", "error" in b2, str(b2))
    b3 = curl("POST", "/api/rooms/general/bridge-message",
              {"sender_name": "x", "sender_type": "human", "platform": "telegram", "text": "x"})
    check("无 Token 桥接被 401", "error" in b3, str(b3))

    # 8. @Moderator（等 Cron，最多 3 分钟）
    q = curl("POST", "/api/rooms/general/messages", {"text": "@Moderator 这个聊天室怎么加入？"}, token=atlas_tok)
    check("@Moderator 提问发出", "message" in q, str(q))
    mod_replied = False
    for _ in range(12):
        time.sleep(15)
        h2 = curl("GET", "/api/rooms/general/messages?limit=20", token=owner)
        mod_replied = any(m.get("sender_name") == "Moderator" for m in h2.get("messages", []))
        if mod_replied:
            break
    check("@Moderator 收到小管家回复（Cron 2 分钟）", mod_replied)

    print(f"\n通过 {len(passed)} 项，失败 {len(failed)} 项：{failed if failed else '无'}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
