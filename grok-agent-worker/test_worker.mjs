// ai-chatroom-grok 模拟测试（不调真实 xAI、不发真实房间消息）。
// 覆盖：Responses 返回解析（三种形状）、上下文截断、evaluate 说不回
// 则不调 xAI、冷却期内跳过、自己的消息跳过、无 XAI key 时 early
// return 且不拉房间、无 CHATROOM_TOKEN 时 early return、xAI 失败不崩。
// Usage: node test_worker.mjs
import {
  parseResponsesText,
  buildPrompt,
  runPollCycle,
  DEFAULT_MODEL,
  MAX_CONTEXT_MESSAGES,
} from "./src/index.js";

let passed = [];
let failed = [];
function check(name, cond, extra = "") {
  (cond ? passed : failed).push(name);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  ${cond ? "" : extra}`);
}

// ---------- Mock sys：内存 DO + 录制的聊天室/xAI 调用 ----------
class MockSys {
  constructor({ me, messages = [], evaluate = {}, grokText = "你好，我是 Grok。", grokError = null } = {}) {
    this.me = me || { id: "u_grok", name: "Grok（xAI）", type: "agent", rules: { cooldown_seconds: 30 } };
    this.messages = messages;
    this.evaluate = evaluate; // msg.id -> {should_reply, reason, cooldown_seconds}
    this.grokText = grokText;
    this.grokError = grokError;
    this.kv = {};
    this.grokCalls = [];
    this.chatroomGets = [];
    this.chatroomPosts = [];
  }
  async doCall(op, p = {}) {
    if (op === "get-state") {
      return {
        seen: this.kv.seen || [],
        last_reply: this.kv.last_reply || 0,
        last_poll_at: this.kv.last_poll_at || 0,
        last_result: this.kv.last_result || null,
      };
    }
    if (op === "set-state") {
      Object.assign(this.kv, p.patch || {});
      return { ok: true };
    }
    throw new Error("unknown op " + op);
  }
  async chatroomGet(path) {
    this.chatroomGets.push(path);
    if (path === "/api/identities/me") return this.me;
    if (path.startsWith("/api/rooms/")) return { messages: this.messages };
    return {};
  }
  async chatroomPost(path, body) {
    this.chatroomPosts.push({ path, body });
    if (path === "/api/evaluate") {
      const ev = this.evaluate[body.sender_id] || this.evaluate.__default || { should_reply: true, reason: "符合回复规则", cooldown_seconds: 30 };
      return ev;
    }
    if (path.startsWith("/api/rooms/")) return { message: { id: "m_reply" } };
    return {};
  }
  async callGrok(prompt) {
    this.grokCalls.push(prompt);
    if (this.grokError) throw new Error(this.grokError);
    return this.grokText;
  }
}

const humanMsg = (id, text, sender = "luo", type = "human", ts = 1000) => ({
  id, sender_id: "u_" + sender, sender_name: sender, sender_type: type, text, mentions: [], ts,
});

// ---------- 1. Responses 返回解析 ----------
check("parse: output_text 顶层字段", parseResponsesText({ output_text: "hi" }) === "hi");
check("parse: output[] walk", parseResponsesText({
  output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: "你好" }] }],
}) === "你好");
check("parse: choices 兼容形状", parseResponsesText({
  choices: [{ message: { content: "legacy" } }],
}) === "legacy");
let threw = false;
try { parseResponsesText({ output: [] }); } catch { threw = true; }
check("parse: 空返回抛错", threw);
threw = false;
try { parseResponsesText({ error: { message: "bad key" } }); } catch { threw = true; }
check("parse: error 字段抛错", threw);

// ---------- 2. 上下文截断 ----------
const many = Array.from({ length: 25 }, (_, i) => humanMsg("m" + i, "消息" + i, "luo", "human", 1000 + i));
const prompt = buildPrompt("Grok（xAI）", many, many[24]);
const kept = many.slice(-MAX_CONTEXT_MESSAGES);
check("prompt: 只取最近 20 条", kept.every((m) => prompt.includes(m.text)) && !prompt.includes("消息0") && !prompt.includes("消息4"));
check("prompt: 标出要回复的那条", prompt.includes("← 本条要回复"));
check("prompt: 长度截断", prompt.length <= 4000);
check("默认模型 grok-4.7", DEFAULT_MODEL === "grok-4.7");

// ---------- 3. runPollCycle ----------
const env = { XAI_API_KEY: "xai-fake", CHATROOM_TOKEN: "muse-fake" };

// 3a. evaluate 说不回 → 不调 xAI、不发消息
{
  const sys = new MockSys({
    messages: [humanMsg("m1", "你好")],
    evaluate: { __default: { should_reply: false, reason: "只回 @我的消息", cooldown_seconds: 30 } },
  });
  const r = await runPollCycle(env, sys);
  check("evaluate 不回：不调 xAI", sys.grokCalls.length === 0);
  check("evaluate 不回：不发消息", !sys.chatroomPosts.some((p) => p.path.startsWith("/api/rooms/")));
  check("evaluate 不回：计数 skipped_no=1", r.skipped_no === 1);
}

// 3b. 该回 → 调一次 xAI、发一条带 reply_to 的回复
{
  const sys = new MockSys({ messages: [humanMsg("m1", "@Grok（xAI） 在吗", "luo", "human", 1000)] });
  sys.messages[0].mentions = ["Grok（xAI）"];
  const r = await runPollCycle(env, sys);
  check("该回：调一次 xAI", sys.grokCalls.length === 1);
  const sent = sys.chatroomPosts.find((p) => p.path.startsWith("/api/rooms/"));
  check("该回：发一条回复", !!sent);
  check("该回：带 reply_to 引用原消息", sent && sent.body.reply_to === "m1");
  check("该回：计数 replied=1", r.replied === 1);
}

// 3c. 自己的消息跳过（不调 evaluate、不调 xAI）
{
  const sys = new MockSys({
    messages: [{ ...humanMsg("m1", "我刚说的", "grok", "agent", 1000), sender_id: "u_grok", sender_name: "Grok（xAI）", sender_type: "agent" }],
  });
  const r = await runPollCycle(env, sys);
  check("自己的消息：跳过", r.skipped_self === 1 && sys.grokCalls.length === 0);
  check("自己的消息：不问 evaluate", !sys.chatroomPosts.some((p) => p.path === "/api/evaluate"));
}

// 3d. 冷却期内跳过（last_reply 10 秒前，冷却 30 秒）
{
  const sys = new MockSys({ messages: [humanMsg("m1", "在吗")] });
  sys.kv.last_reply = Date.now() - 10 * 1000;
  const r = await runPollCycle(env, sys);
  check("冷却期内：不调 xAI", sys.grokCalls.length === 0 && r.skipped_cooldown === 1);
}

// 3e. 冷却期过后可回
{
  const sys = new MockSys({ messages: [humanMsg("m1", "在吗")] });
  sys.kv.last_reply = Date.now() - 60 * 1000;
  const r = await runPollCycle(env, sys);
  check("冷却期过后：正常回复", r.replied === 1);
}

// 3f. 无 XAI key → early return，且不拉房间（chatroomGets 为空）
{
  const sys = new MockSys({ messages: [humanMsg("m1", "在吗")] });
  const r = await runPollCycle({ CHATROOM_TOKEN: "muse-fake" }, sys);
  check("无 XAI key：early return", r.skipped === "no_xai_key");
  check("无 XAI key：不拉房间", sys.chatroomGets.length === 0 && sys.grokCalls.length === 0);
}

// 3g. 无 CHATROOM_TOKEN → early return
{
  const sys = new MockSys({ messages: [humanMsg("m1", "在吗")] });
  const r = await runPollCycle({ XAI_API_KEY: "xai-fake" }, sys);
  check("无 CHATROOM_TOKEN：early return", r.skipped === "no_chatroom_token");
}

// 3h. xAI 失败不崩、记数、不发消息
{
  const sys = new MockSys({ messages: [humanMsg("m1", "在吗")], grokError: "xAI HTTP 401" });
  const r = await runPollCycle(env, sys);
  check("xAI 失败：不崩、记 xai_failed", r.ok === true && r.xai_failed === 1);
  check("xAI 失败：不发消息", !sys.chatroomPosts.some((p) => p.path.startsWith("/api/rooms/")));
}

// 3i. Agent 发的消息：evaluate 判定（humans_only 下不回）
{
  const sys = new MockSys({
    messages: [humanMsg("m1", "agent 说话", "Atlas", "agent", 1000)],
    evaluate: { __default: { should_reply: false, reason: "只回人类消息", cooldown_seconds: 30 } },
  });
  const r = await runPollCycle(env, sys);
  check("Agent 消息：按 evaluate 不回", r.skipped_no === 1 && sys.grokCalls.length === 0);
}

// 3j. 已读消息不重复处理（seen 去重）
{
  const sys = new MockSys({ messages: [humanMsg("m1", "在吗")] });
  await runPollCycle(env, sys);
  const r2 = await runPollCycle(env, sys);
  check("seen 去重：第二轮无新消息", r2.received === 0 && sys.grokCalls.length === 1);
}

console.log(`\n${passed.length} passed, ${failed.length} failed`);
if (failed.length) {
  console.log("FAILED:", failed.join(", "));
  process.exit(1);
}
