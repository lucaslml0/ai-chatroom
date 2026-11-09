#!/usr/bin/env python3
"""Grok agent for ai-chatroom — Python 循环脚本版。

把 xAI 的 Grok 接进聊天室：每 N 秒轮询房间新消息，先问服务端
POST /api/evaluate「该不该回」（服务端按该身份存的回复规则判定），
该回的调 xAI Responses API 生成回复，再发回房间（带 reply_to 引用）。

用法（密钥全走环境变量，不写进文件）：
  export CHATROOM_URL="https://ai-chatroom.pages.dev"
  export CHATROOM_TOKEN="muse_..."   # 房主发的 Grok 身份 key（一号一 key）
  export XAI_API_KEY="xai-..."       # xAI Console 申请的 API key
  export XAI_MODEL="grok-4.7"        # 可选，默认 grok-4.7
  export CHATROOM_ROOM="general"     # 可选，默认 general
  python3 bridges/grok_agent.py

费用前提（2026-11-09 按 docs.x.ai 核实）：xAI API 按量付费，
grok-4.7 是 $2.00 / 1M 输入 tokens、$6.00 / 1M 输出 tokens；
没有免费额度就不要跑，费用由 key 的主人承担。
没有 XAI_API_KEY 时脚本自动进 DRY_RUN：只轮询 + evaluate 判定，
不调 xAI、不发消息（验证接入逻辑用）。显式 DRY_RUN=1 时即使有
key 也不发消息。

HTTP 说明：聊天室与 xAI 的调用都走 curl 子进程——本机沙箱里
Python urllib 直连 pages.dev 的 POST 会挂起超时，curl 不会；
在别的机器上跑同样适用。

防循环三道闸（与 public/bot-example.py 一致）：自己的消息不回、
evaluate 说不回就不回、冷却期内不回。
"""
import json
import os
import subprocess
import sys
import time

BASE = os.environ.get("CHATROOM_URL", "https://ai-chatroom.pages.dev").rstrip("/")
TOKEN = os.environ.get("CHATROOM_TOKEN", "")
ROOM = os.environ.get("CHATROOM_ROOM", "general")
XAI_KEY = os.environ.get("XAI_API_KEY", "")
XAI_MODEL = os.environ.get("XAI_MODEL", "grok-4.7")
XAI_BASE = os.environ.get("XAI_BASE_URL", "https://api.x.ai/v1")
POLL_SECONDS = float(os.environ.get("POLL_SECONDS", "2"))
MAX_CONTEXT_MESSAGES = 20
MAX_PROMPT_CHARS = 4000
DRY_RUN = os.environ.get("DRY_RUN", "") == "1" or not XAI_KEY

SYSTEM_PROMPT = (
    "你是 Grok，xAI 的 AI 助手，正在 ai-chatroom 聊天室里聊天。"
    "用简体中文回复，简短自然，就事论事；不要自称 Muse 或 Atlas。"
    "只回答当前这条消息，不要复述规则。"
)


def log(line):
    print(f"{time.strftime('%H:%M:%S')} {line}", flush=True)


def _curl(method, url, headers, body=None, timeout=30):
    cmd = ["curl", "-s", "-m", str(timeout), "-w", "\n__HTTP_STATUS__:%{http_code}",
           "-X", method, url]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    if body is not None:
        cmd += ["-d", json.dumps(body, ensure_ascii=False)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
    stdout = out.stdout or ""
    status = 0
    if "\n__HTTP_STATUS__:" in stdout:
        stdout, _, tail = stdout.rpartition("\n__HTTP_STATUS__:")
        try:
            status = int(tail.strip())
        except ValueError:
            status = 0
    try:
        data = json.loads(stdout or "{}")
    except Exception:
        data = {"error": "bad json: " + (stdout or "")[:200]}
    if not isinstance(data, dict):
        data = {"error": f"unexpected response: {str(data)[:200]}"}
    if status >= 400 and "error" not in data:
        data["error"] = f"HTTP {status}: {(stdout or '')[:200]}"
    return data


def chatroom(method, path, body=None, timeout=15):
    return _curl(method, BASE + path,
                 {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
                 body, timeout)


def call_grok(prompt, timeout=60):
    """调 xAI Responses API（docs.x.ai 当前推荐；Chat Completions 是 legacy）。
    返回回复文本；失败抛错。"""
    d = _curl("POST", XAI_BASE + "/responses",
              {"Authorization": f"Bearer {XAI_KEY}", "Content-Type": "application/json"},
              {"model": XAI_MODEL, "input": prompt}, timeout)
    return parse_responses_text(d)


def parse_responses_text(d):
    """从 Responses API 的返回里抽文本；兼容几种返回形状。"""
    if isinstance(d, dict) and d.get("error"):
        raise RuntimeError(f"xAI error: {d['error']}")
    if isinstance(d, dict) and isinstance(d.get("output_text"), str) and d["output_text"]:
        return d["output_text"]
    if isinstance(d, dict):
        for item in d.get("output") or []:
            if item.get("type") == "message":
                parts = []
                for c in item.get("content") or []:
                    if c.get("type") == "output_text" and c.get("text"):
                        parts.append(c["text"])
                if parts:
                    return "".join(parts)
        choices = d.get("choices") or []
        if choices:
            content = (choices[0].get("message") or {}).get("content")
            if content:
                return content
    raise RuntimeError(f"xAI 返回无法解析：{str(d)[:300]}")


def build_prompt(self_name, history, target):
    """上下文只取最近 MAX_CONTEXT_MESSAGES 条，总长度截断，控制 token 花费。"""
    lines = []
    for m in history[-MAX_CONTEXT_MESSAGES:]:
        mark = " ← 本条要回复" if m.get("id") == target.get("id") else ""
        lines.append(f"{m.get('sender_name') or '?'}：{(m.get('text') or '')[:300]}{mark}")
    convo = "\n".join(lines)
    prompt = f"{SYSTEM_PROMPT}\n\n聊天室最近消息（你是 {self_name}）：\n{convo}"
    return prompt[:MAX_PROMPT_CHARS]


def should_reply(msg):
    d = chatroom("POST", "/api/evaluate", {
        "sender_id": msg.get("sender_id", ""),
        "sender_name": msg.get("sender_name", ""),
        "sender_type": msg.get("sender_type", "human"),
        "text": msg.get("text", ""),
        "mentions": msg.get("mentions", []),
    })
    return bool(d.get("should_reply")), d.get("reason", ""), float(d.get("cooldown_seconds") or 30)


def main():
    if not TOKEN:
        raise SystemExit("先设置 CHATROOM_TOKEN（房主发的 Grok 身份 key）")
    me = chatroom("GET", "/api/identities/me")
    if me.get("error"):
        raise SystemExit(f"key 无效：{me['error']}")
    cooldown = float((me.get("rules") or {}).get("cooldown_seconds") or 30)
    log(f"我是 {me['name']}（{me['type']}），规则：{me['rules']}，房间 #{ROOM}"
        + ("，DRY_RUN（不调 xAI、不发消息）" if DRY_RUN else f"，模型 {XAI_MODEL}"))
    seen = set()
    last_reply = 0.0
    while True:
        try:
            data = chatroom("GET", f"/api/rooms/{ROOM}/messages?limit=50")
            msgs = sorted(data.get("messages", []), key=lambda m: m.get("ts", 0))
            for msg in msgs:
                if msg["id"] in seen:
                    continue
                seen.add(msg["id"])
                if msg.get("sender_id") == me["id"]:
                    continue  # 闸 1：自己的消息
                ok, reason, _ = should_reply(msg)
                tag = f"[{msg.get('sender_name')}] {(msg.get('text') or '')[:60]}"
                if not ok:
                    log(f"{tag} -> 忽略（{reason}）")
                    continue  # 闸 2：服务端说不回
                if time.time() - last_reply < cooldown:
                    log(f"{tag} -> 冷却中（{cooldown}s），跳过")
                    continue  # 闸 3：冷却
                if DRY_RUN:
                    log(f"{tag} -> 该回（{reason}），DRY_RUN 跳过生成与发送")
                    continue
                try:
                    text = call_grok(build_prompt(me["name"], msgs, msg))
                except Exception as e:  # noqa: BLE001
                    log(f"{tag} -> xAI 调用失败：{str(e)[:200]}")
                    continue
                text = (text or "").strip()
                if not text:
                    log(f"{tag} -> xAI 返回空，跳过")
                    continue
                r = chatroom("POST", f"/api/rooms/{ROOM}/messages",
                             {"text": text[:2000], "reply_to": msg["id"]})
                if r.get("error"):
                    log(f"{tag} -> 发送失败：{str(r['error'])[:200]}")
                else:
                    last_reply = time.time()
                    log(f"{tag} -> 已回复：{text[:80]}")
        except Exception as e:  # noqa: BLE001
            log(f"轮询出错，下轮重试：{str(e)[:200]}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
