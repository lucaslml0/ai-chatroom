#!/usr/bin/env python3
"""Live chatroom-side tests for the WeChat binding feature.

Hits the real Pages API (no real WeChat messages sent; the bridge token
stands in for the Worker). Creates a throwaway wechat key + binding with a
fake wechat_id, verifies identity resolution, then cleans everything up:
test messages deleted, binding removed, test key revoked.

Usage: python3 wechat-bridge-worker/test_chatroom_wechat.py
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
BASE = "https://ai-chatroom.pages.dev"
OWNER = open(os.path.join(PROJECT, ".owner-token")).read().strip()
BRIDGE = json.load(open(os.path.join(PROJECT, "bridges-config.json")))["wechat"]["token"]

passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {extra if not cond else ''}")


def api(method, path, body=None, token=None):
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
        return {"error": out.stdout[:200]}


def history():
    return api("GET", "/api/rooms/general/messages?limit=50", token=OWNER).get("messages", [])


def delete_msg(mid):
    api("POST", "/api/admin/delete-message", {"room": "general", "message_id": mid}, token=OWNER)


def main():
    test_msgs = []
    test_key_id = None
    fake_wx = "test-wechat-bridge@im.wechat"
    try:
        # 1. 建一个一次性微信 key
        k = api("POST", "/api/admin/create-key",
                {"name": "微信桥测试", "type": "human", "platform": "wechat",
                 "purpose": "微信桥绑定测试，测完吊销"}, token=OWNER)
        check("建微信 key", "token" in k and k.get("platform") == "wechat", str(k))
        if "token" not in k:
            print("建 key 失败，停止")
            return 1
        test_key_id = k["id"]
        test_key_name = k["name"]  # uniqueName 可能加 #2 后缀（如上次测试的同名 key 还在）
        # 2. 生成绑定码
        c = api("POST", "/api/admin/wechat-bind-code", {"token": k["token"]}, token=OWNER)
        check("生成绑定码（6 位大写字母数字）", isinstance(c.get("code"), str) and len(c.get("code", "")) == 6
              and c["code"].isalnum() and c["code"].isupper(), str(c))
        check("绑定码带 join_url", isinstance(c.get("join_url"), str) and c["join_url"].startswith("https://ai-chatroom.pages.dev/wechat-join?code="), str(c))
        code = c.get("code", "")
        # 3. 错码绑定失败
        bad = api("POST", "/api/bridge/bind-wechat",
                  {"code": "XXXXXX", "wechat_id": fake_wx, "wechat_name": fake_wx}, token=BRIDGE)
        check("错码绑定被拒", "error" in bad, str(bad))
        # 4. 正确绑定
        b = api("POST", "/api/bridge/bind-wechat",
                {"code": code, "wechat_id": fake_wx, "wechat_name": fake_wx}, token=BRIDGE)
        check("绑定成功，返回身份", (b.get("identity") or {}).get("id") == test_key_id, str(b))
        # 5. 同一码再用失败（单次有效）
        again = api("POST", "/api/bridge/bind-wechat",
                    {"code": code, "wechat_id": "other@im.wechat", "wechat_name": "other"}, token=BRIDGE)
        check("已用的码再绑被拒", "error" in again, str(again))
        # 6. 已绑定身份发言：名字/类型/id 都是该 key 的
        r = api("POST", "/api/rooms/general/bridge-message",
                {"platform": "wechat", "sender_name": "微信访客", "sender_type": "human",
                 "text": "微信绑定身份测试", "wechat_id": fake_wx}, token=BRIDGE)
        check("已绑定 bridge-message 成功", "message" in r, str(r))
        time.sleep(1)
        msgs = history()
        m = next((x for x in msgs if x.get("text") == "微信绑定身份测试"), None)
        check("已绑定消息以 key 的名字出现",
              m is not None and m.get("sender_name") == test_key_name
              and m.get("sender_id") == test_key_id and m.get("platform") == "wechat", str(m))
        if m:
            test_msgs.append(m["id"])
        # 7. 无绑定时仍是访客
        r2 = api("POST", "/api/rooms/general/bridge-message",
                 {"platform": "wechat", "sender_name": "微信访客", "sender_type": "human",
                  "text": "微信访客身份测试"}, token=BRIDGE)
        check("未绑定 bridge-message 成功", "message" in r2, str(r2))
        time.sleep(1)
        msgs = history()
        m2 = next((x for x in msgs if x.get("text") == "微信访客身份测试"), None)
        check("未绑定消息显示微信访客",
              m2 is not None and m2.get("sender_name") == "微信访客"
              and (m2.get("sender_id") or "").startswith("ext_wechat_"), str(m2))
        if m2:
            test_msgs.append(m2["id"])
        # 8. 绑定列表里有这条
        lst = api("GET", "/api/bridge/wechat-bindings", token=OWNER)
        hit = [x for x in lst.get("bindings", []) if x.get("wechat_id") == fake_wx]
        check("绑定列表含测试绑定", len(hit) == 1 and hit[0].get("identity_name") == test_key_name, str(lst))
        # 9. 解绑后退回访客
        u = api("DELETE", f"/api/bridge/wechat-binding/{fake_wx}", token=OWNER)
        check("解绑成功", u.get("ok") is True, str(u))
        r3 = api("POST", "/api/rooms/general/bridge-message",
                 {"platform": "wechat", "sender_name": "微信访客", "sender_type": "human",
                  "text": "微信解绑后身份测试", "wechat_id": fake_wx}, token=BRIDGE)
        time.sleep(1)
        msgs = history()
        m3 = next((x for x in msgs if x.get("text") == "微信解绑后身份测试"), None)
        check("解绑后消息退回访客",
              m3 is not None and m3.get("sender_name") == "微信访客", str(m3))
        if m3:
            test_msgs.append(m3["id"])
        # 10. 重新生成绑定码（按 identity_id）并再绑一次
        c2 = api("POST", "/api/admin/wechat-bind-code", {"identity_id": test_key_id}, token=OWNER)
        check("按 identity_id 重新生成绑定码", isinstance(c2.get("code"), str) and c2.get("code") != code, str(c2))
        b2 = api("POST", "/api/bridge/bind-wechat",
                 {"code": c2.get("code", ""), "wechat_id": fake_wx, "wechat_name": fake_wx}, token=BRIDGE)
        check("新码可再次绑定", (b2.get("identity") or {}).get("id") == test_key_id, str(b2))
        # 11. 非桥接 token 调 bind-wechat 被拒
        nb = api("POST", "/api/bridge/bind-wechat",
                 {"code": "AAAAAA", "wechat_id": fake_wx}, token=OWNER)
        check("非桥接 token 调 bind-wechat 被拒", "error" in nb, str(nb))
    finally:
        for mid in test_msgs:
            delete_msg(mid)
        api("DELETE", f"/api/bridge/wechat-binding/{fake_wx}", token=OWNER)
        if test_key_id:
            api("POST", "/api/admin/revoke-key", {"target_id": test_key_id}, token=OWNER)
    print(f"\n通过 {len(passed)} 项，失败 {len(failed)} 项：{failed if failed else '无'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
