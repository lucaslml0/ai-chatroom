// ai-chatroom 微信桥（已并进聊天室服务 src/index.js）模拟测试（不发真实微信消息、不调真实 iLink）。
// 与 wechat-bridge-worker/test_worker.mjs 同用例，改 import 自 ./src/index.js；旧 Worker 删除后旧文件随之删除。
// 覆盖：分流（绑定码/聊天）、回推路由、-14 退避、命令队列与 /reply。
// 聊天室侧真接口测试见 test_chatroom_wechat.py（调线上 Pages API）。
// Usage: node test_worker.mjs
import {
  extractText,
  classifyInbound,
  routePushTargets,
  formatPush,
  makeQrSvg,
  runPollCycle,
  handleReply,
} from "./src/index.js";

let passed = [];
let failed = [];
function check(name, cond, extra = "") {
  (cond ? passed : failed).push(name);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  ${cond ? "" : extra}`);
}

// ---------- Mock sys：内存 DO + 录制的 iLink/聊天室调用 ----------
class MockSys {
  constructor({
    updates = { ret: 0, msgs: [] },
    bindings = [],
    bindResult = null,
    roomMessages = [],
  } = {}) {
    this.updates = updates;
    this.bindings = bindings;
    this.bindResult = bindResult;
    this.roomMessages = roomMessages;
    this.kv = {};
    this.contexts = new Map();
    this.commands = new Map();
    this.sent = []; // ilinkSendText 录制
    this.chatroomPosts = [];
    this.cmdSeq = 0;
  }
  async doCall(op, p = {}) {
    if (op === "get-state") {
      return {
        buf: this.kv.buf || "",
        session_expired_until: this.kv.session_expired_until || 0,
        last_poll_at: this.kv.last_poll_at || 0,
        last_from: this.kv.last_from || null,
        seen: this.kv.seen || {},
        greeted: this.kv.greeted || [],
      };
    }
    if (op === "set-state") {
      Object.assign(this.kv, p.patch || {});
      return { ok: true };
    }
    if (op === "upsert-context") {
      this.contexts.set(p.wechat_id, p.context_token);
      return { ok: true };
    }
    if (op === "get-context") {
      return { context_token: this.contexts.get(p.wechat_id) || null };
    }
    if (op === "add-command") {
      const id = `cmd_test${++this.cmdSeq}`;
      this.commands.set(id, {
        id,
        wechat_id: p.wechat_id,
        text: p.text,
        status: "pending",
        created_at: Date.now(),
      });
      return { id };
    }
    if (op === "list-commands") {
      const rows = [...this.commands.values()].filter(
        (c) => p.status === "all" || c.status === p.status,
      );
      return { commands: rows };
    }
    if (op === "get-command")
      return { command: this.commands.get(p.id) || null };
    if (op === "mark-replied") {
      const c = this.commands.get(p.id);
      if (c) c.status = "replied";
      return { ok: true };
    }
    throw new Error("unknown op " + op);
  }
  async ilinkGetUpdates() {
    if (this.updates instanceof Error) throw this.updates;
    return this.updates;
  }
  async ilinkSendText(to, text, ctx) {
    this.sent.push({ to, text, ctx });
    return { ret: 0 };
  }
  async chatroomGet(path) {
    if (path === "/api/bridge/wechat-bindings")
      return { bindings: this.bindings };
    if (path.startsWith("/api/rooms/general/messages"))
      return { messages: this.roomMessages };
    return {};
  }
  async chatroomPost(path, body) {
    this.chatroomPosts.push({ path, body });
    if (path === "/api/bridge/bind-wechat") {
      if (this.bindResult) return this.bindResult;
      return { error: "绑定码不存在" };
    }
    if (path.endsWith("/bridge-message"))
      return { message: { id: "m_test", text: body.text } };
    return {};
  }
}

const LUO = "o9cq8094b8bLpN-9h_FBdr_HBXSM@im.wechat";
const msg = (from, text, extra = {}) => ({
  message_id: 1000 + Math.floor(Math.random() * 9000),
  from_user_id: from,
  message_type: 1,
  context_token: "ctx-" + from.slice(0, 8),
  item_list: [{ type: 1, text_item: { text } }],
  ...extra,
});

// ---------- 1. extractText / classifyInbound ----------
check(
  "extractText 取文本 + 语音转文字",
  extractText({
    item_list: [
      { type: 1, text_item: { text: "你好" } },
      { type: 3, voice_item: { text: "语音内容" } },
    ],
  }) === "你好\n语音内容",
);
check(
  "分流：裸 6 位码",
  classifyInbound("K7Q2XA").kind === "bind" &&
    classifyInbound("K7Q2XA").code === "K7Q2XA",
);
check("分流：小写码转大写", classifyInbound("k7q2xa").code === "K7Q2XA");
check("分流：「绑定 码」形式", classifyInbound("绑定 K7Q2XA").kind === "bind");
check(
  "分流：聊：中文冒号",
  classifyInbound("聊：大家好").kind === "chat" &&
    classifyInbound("聊：大家好").text === "大家好",
);
check("分流：聊: 英文冒号", classifyInbound("聊:hello").text === "hello");
check("分流：聊：后空内容算空", classifyInbound("聊：").kind === "empty");
check(
  "分流：无前缀直接进房",
  classifyInbound("帮我查一下天气").kind === "chat" &&
    classifyInbound("帮我查一下天气").text === "帮我查一下天气",
);
check(
  "分流：@all 无前缀进房",
  classifyInbound("@all 测试一下").kind === "chat",
);
check("分流：7 位码不是绑定码", classifyInbound("K7Q2XAB").kind === "chat");
check("分流：空文本", classifyInbound("   ").kind === "empty");

// ---------- 2. routePushTargets ----------
const boundByName = new Map([
  ["luo", LUO],
  ["小明", "xiaoming@im.wechat"],
]);
const allBound = [LUO, "xiaoming@im.wechat"];
check(
  "路由：@绑定名字 → 该微信号",
  JSON.stringify(
    routePushTargets(
      { mentions: ["luo"], sender_name: "Atlas", text: "x" },
      boundByName,
      allBound,
      null,
    ),
  ) === JSON.stringify([LUO]),
);
check(
  "路由：@所有人 → 全部已绑定",
  routePushTargets(
    { mentions: ["所有人"], sender_name: "Atlas" },
    boundByName,
    allBound,
    null,
  ).length === 2,
);
check(
  "路由：@all → 全部已绑定",
  routePushTargets(
    { mentions: ["all"], sender_name: "Atlas" },
    boundByName,
    allBound,
    null,
  ).length === 2,
);
check(
  "路由：系统消息 → 全部已绑定",
  routePushTargets(
    { mentions: [], sender_name: "系统" },
    boundByName,
    allBound,
    null,
  ).length === 2,
);
check(
  "路由：@微信访客 → 最近未绑定发送者",
  JSON.stringify(
    routePushTargets(
      { mentions: ["微信访客"], sender_name: "Atlas" },
      boundByName,
      allBound,
      "guest@im.wechat",
    ),
  ) === JSON.stringify(["guest@im.wechat"]),
);
check(
  "路由：@微信访客但无 lastFrom → 不发",
  routePushTargets(
    { mentions: ["微信访客"], sender_name: "Atlas" },
    boundByName,
    allBound,
    null,
  ).length === 0,
);
check(
  "路由：无关消息不回推",
  routePushTargets(
    { mentions: [], sender_name: "Atlas" },
    boundByName,
    allBound,
    null,
  ).length === 0,
);
check(
  "路由：@不存在的名字不回推",
  routePushTargets(
    { mentions: ["陌生人"], sender_name: "Atlas" },
    boundByName,
    allBound,
    null,
  ).length === 0,
);
// reply_to 回推（2026-11-09 新增）：回复某条微信消息时推回给原发送者。
const wechatMsgById = new Map([
  [
    "mW1",
    { id: "mW1", sender_name: "luo", platform: "wechat", text: "在吗" },
  ],
  [
    "mW2",
    {
      id: "mW2",
      sender_name: "微信访客",
      platform: "wechat",
      text: "访客问",
    },
  ],
  [
    "mW3",
    { id: "mW3", sender_name: "Marley", platform: "api", text: "不是微信" },
  ],
]);
check(
  "路由：reply_to 已绑定微信消息 → 推给原发送者",
  JSON.stringify(
    routePushTargets(
      { mentions: [], sender_name: "Atlas", reply_to: "mW1", text: "在呢" },
      boundByName,
      allBound,
      null,
      wechatMsgById,
    ),
  ) === JSON.stringify([LUO]),
);
check(
  "路由：reply_to 微信访客消息 → 推给 lastFrom",
  JSON.stringify(
    routePushTargets(
      { mentions: [], sender_name: "Atlas", reply_to: "mW2", text: "收到" },
      boundByName,
      allBound,
      "guest@im.wechat",
      wechatMsgById,
    ),
  ) === JSON.stringify(["guest@im.wechat"]),
);
check(
  "路由：reply_to 目标不在本轮窗口内 → 不误推",
  routePushTargets(
    { mentions: [], sender_name: "Atlas", reply_to: "mMissing", text: "x" },
    boundByName,
    allBound,
    "guest@im.wechat",
    wechatMsgById,
  ).length === 0,
);
check(
  "路由：reply_to 非微信消息 → 不推",
  routePushTargets(
    { mentions: [], sender_name: "Atlas", reply_to: "mW3", text: "x" },
    boundByName,
    allBound,
    null,
    wechatMsgById,
  ).length === 0,
);
check(
  "路由：reply_to 与 @ 并存 → 去重合并",
  JSON.stringify(
    routePushTargets(
      { mentions: ["luo"], sender_name: "Atlas", reply_to: "mW1", text: "x" },
      boundByName,
      allBound,
      null,
      wechatMsgById,
    ),
  ) === JSON.stringify([LUO]),
);
check(
  "回推格式截断 1000 字",
  formatPush("general", { sender_name: "Atlas", text: "x".repeat(1500) })
    .length < 1100,
);

// ---------- 3. QR ----------
const svg = makeQrSvg("K7Q2XA");
check(
  "QR：返回 SVG",
  svg.startsWith("<svg") && svg.includes("</svg>") && svg.length > 500,
);
check("QR：不同码不同图", makeQrSvg("AAAAAA") !== makeQrSvg("BBBBBB"));

// ---------- 4. runPollCycle：绑定成功 ----------
{
  const sys = new MockSys({
    updates: { ret: 0, get_updates_buf: "buf1", msgs: [msg(LUO, "K7Q2XA")] },
    bindResult: { identity: { id: "u_test1", name: "luo" } },
  });
  const r = await runPollCycle({}, sys);
  check("绑定成功：计入 bound", r.bound === 1, JSON.stringify(r));
  check(
    "绑定成功：回“绑定成功”文案",
    sys.sent.length === 1 &&
      sys.sent[0].text.includes("绑定成功") &&
      sys.sent[0].text.includes("luo"),
  );
  check("绑定成功：buf 已保存", sys.kv.buf === "buf1");
}
// ---------- 5. runPollCycle：绑定失败 ----------
{
  const sys = new MockSys({
    updates: { ret: 0, msgs: [msg(LUO, "绑定 ZZZZZZ")] },
    bindResult: { error: "绑定码已过期" },
  });
  const r = await runPollCycle({}, sys);
  check("绑定失败：不计入 bound", r.bound === 0);
  check(
    "绑定失败：回具体原因",
    sys.sent.length === 1 && sys.sent[0].text.includes("绑定码已过期"),
  );
  check(
    "绑定失败：不进命令队列",
    (await sys.doCall("list-commands", { status: "pending" })).commands
      .length === 0,
  );
}
// ---------- 6. runPollCycle：无前缀转发（已绑定身份） ----------
{
  const sys = new MockSys({
    updates: { ret: 0, msgs: [msg(LUO, "Worker 桥测试")] },
    bindings: [{ identity_name: "luo", wechat_id: LUO }],
  });
  const r = await runPollCycle({}, sys);
  check("无前缀转发进房", r.forwarded === 1, JSON.stringify(r));
  const post = sys.chatroomPosts.find((p) =>
    p.path.endsWith("/bridge-message"),
  );
  check(
    "转发附 wechat_id",
    post && post.body.wechat_id === LUO && post.body.text === "Worker 桥测试",
  );
  check("转发不回微信", sys.sent.length === 0);
  check("已绑定者不进 last_from", sys.kv.last_from !== LUO);
}
// ---------- 7. runPollCycle：普通文本不再进命令队列 ----------
{
  const sys = new MockSys({
    updates: { ret: 0, msgs: [msg(LUO, "帮我查一下今天的热点")] },
  });
  const r1 = await runPollCycle({}, sys);
  check("无前缀：直接进房", r1.forwarded === 1, JSON.stringify(r1));
  check("无前缀：不进命令队列", r1.commands === 0);
  check("无前缀：不回问候/ACK", sys.sent.length === 0);
  check(
    "无前缀：原文进房",
    sys.chatroomPosts.some(
      (p) =>
        p.path.endsWith("/bridge-message") &&
        p.body.text === "帮我查一下今天的热点",
    ),
  );
}
// ---------- 8. runPollCycle：-14 会话过期 ----------
{
  const sys = new MockSys({
    updates: { ret: -14, errcode: -14, errmsg: "session expired" },
  });
  const r = await runPollCycle({}, sys);
  check(
    "-14：返回 session_expired",
    r.session_expired === true,
    JSON.stringify(r),
  );
  check(
    "-14：退避 1 小时已记",
    (sys.kv.session_expired_until || 0) > Date.now() + 3500 * 1000,
  );
  const r2 = await runPollCycle({}, sys);
  check("-14：退避期内跳过拉取", r2.skipped === "session_expired");
}
// ---------- 9. runPollCycle：getupdates 超时 ----------
{
  const sys = new MockSys();
  sys.updates = new Error("fetch aborted (timeout)");
  const r = await runPollCycle({}, sys);
  check(
    "超时：返回 error 不崩",
    typeof r.error === "string" && r.error.includes("getupdates failed"),
  );
}
// ---------- 10. runPollCycle：回推路由 ----------
{
  const sys = new MockSys({
    updates: { ret: 0, msgs: [] },
    bindings: [{ identity_name: "luo", wechat_id: LUO }],
    roomMessages: [
      {
        id: "m1",
        sender_name: "Atlas",
        sender_type: "agent",
        platform: "api",
        text: "@luo 在吗",
        mentions: ["luo"],
        ts: 1,
      },
      {
        id: "m2",
        sender_name: "系统",
        sender_type: "bot",
        platform: "web",
        text: "房主吊销了某 key",
        mentions: [],
        ts: 2,
      },
      {
        id: "m3",
        sender_name: "Atlas",
        sender_type: "agent",
        platform: "api",
        text: "随便聊聊",
        mentions: [],
        ts: 3,
      },
      {
        id: "m4",
        sender_name: "微信访客",
        sender_type: "human",
        platform: "wechat",
        text: "我是访客",
        mentions: [],
        ts: 4,
      },
    ],
  });
  sys.contexts.set(LUO, "ctx-luo");
  const r = await runPollCycle({}, sys);
  check("回推：@luo 与系统消息发出", r.pumped === 2, JSON.stringify(r));
  check(
    "回推：无关消息不发",
    sys.sent.every(
      (s) => s.text.includes("@luo 在吗") || s.text.includes("房主吊销"),
    ),
  );
  check(
    "回推：wechat 来源不回推（无回声）",
    !sys.sent.some((s) => s.text.includes("我是访客")),
  );
  check("回推：seen 已记", (sys.kv.seen.general || []).length === 4);
  const r2 = await runPollCycle({}, sys);
  check("回推：第二轮无新消息不重复发", r2.pumped === 0);
}
// ---------- 11. runPollCycle：@微信访客 → last_from ----------
{
  const guest = "guest@im.wechat";
  const sys = new MockSys({
    updates: { ret: 0, msgs: [msg(guest, "我是访客")] },
    roomMessages: [
      {
        id: "m9",
        sender_name: "Atlas",
        sender_type: "agent",
        platform: "api",
        text: "@微信访客 收到吗",
        mentions: ["微信访客"],
        ts: 9,
      },
    ],
  });
  sys.contexts.set(guest, "ctx-guest");
  const r = await runPollCycle({}, sys);
  check(
    "访客回推：@微信访客发给最近访客",
    r.pumped === 1 && sys.sent[0].to === guest,
    JSON.stringify(r),
  );
}
// ---------- 12. handleReply ----------
{
  const sys = new MockSys();
  sys.contexts.set(LUO, "ctx-luo");
  const { id } = await sys.doCall("add-command", {
    wechat_id: LUO,
    text: "查热点",
  });
  const ok = await handleReply(sys, {
    command_id: id,
    wechat_id: LUO,
    text: "今天的热点是…",
  });
  check(
    "/reply：成功发送并标已回复",
    ok.status === 200 &&
      sys.sent.length === 1 &&
      sys.sent[0].text === "今天的热点是…",
  );
  const again = await handleReply(sys, {
    command_id: id,
    wechat_id: LUO,
    text: "再发一次",
  });
  check("/reply：已回复的命令返回 409", again.status === 409);
  const missing = await handleReply(sys, {
    command_id: "cmd_nope",
    wechat_id: LUO,
    text: "x",
  });
  check("/reply：不存在的命令返回 404", missing.status === 404);
  const { id: id2 } = await sys.doCall("add-command", {
    wechat_id: LUO,
    text: "第二条",
  });
  const wrongUser = await handleReply(sys, {
    command_id: id2,
    wechat_id: "other@im.wechat",
    text: "x",
  });
  check("/reply：命令与用户不符返回 403", wrongUser.status === 403);
  const sysNoCtx = new MockSys();
  const { id: id3 } = await sysNoCtx.doCall("add-command", {
    wechat_id: LUO,
    text: "无 context",
  });
  const noCtx = await handleReply(sysNoCtx, {
    command_id: id3,
    wechat_id: LUO,
    text: "x",
  });
  check(
    "/reply：无 context_token 返回 400",
    noCtx.status === 400,
    JSON.stringify(noCtx),
  );
}

// ---------- 13. runPollCycle：reply_to 回推（复现 2026-11-09 22:26 真实漏推） ----------
// luo（微信）发「现在还有哪些人在呀」，Atlas 纯 reply_to 回复（mentions 为空）。
// 旧规则下这条回复不推；新规则下应推给 luo 的微信。
{
  const sys = new MockSys({
    updates: { ret: 0, msgs: [] },
    bindings: [{ identity_name: "luo（微信）", wechat_id: LUO }],
    roomMessages: [
      {
        id: "m_def",
        sender_name: "luo（微信）",
        sender_type: "human",
        platform: "wechat",
        text: "现在还有哪些人在呀",
        mentions: [],
        ts: 1,
      },
      {
        id: "m_cc",
        sender_name: "Atlas",
        sender_type: "agent",
        platform: "api",
        text: "在呢",
        mentions: [],
        reply_to: "m_def",
        ts: 2,
      },
      {
        id: "m_orphan",
        sender_name: "Atlas",
        sender_type: "agent",
        platform: "api",
        text: "目标不在窗口内",
        mentions: [],
        reply_to: "m_gone",
        ts: 3,
      },
    ],
  });
  sys.contexts.set(LUO, "ctx-luo");
  const r = await runPollCycle({}, sys);
  check(
    "reply_to 回推：纯 reply_to 回复发出 1 条",
    r.pumped === 1,
    JSON.stringify(r),
  );
  check(
    "reply_to 回推：发给绑定的微信号、内容是回复",
    sys.sent.length === 1 &&
      sys.sent[0].to === LUO &&
      sys.sent[0].text.includes("在呢"),
    JSON.stringify(sys.sent),
  );
  check(
    "reply_to 回推：目标不在窗口内的不误推",
    !sys.sent.some((s) => s.text.includes("目标不在窗口内")),
  );
  const r2 = await runPollCycle({}, sys);
  check("reply_to 回推：第二轮不重复发", r2.pumped === 0);
}

console.log(
  `\n通过 ${passed.length} 项，失败 ${failed.length} 项：${failed.length ? failed.join("；") : "无"}`,
);
process.exit(failed.length ? 1 : 0);
