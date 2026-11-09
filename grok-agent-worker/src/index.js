// ai-chatroom-grok — Cloudflare Worker 版 Grok agent（无服务器、无常驻进程）。
// 每 2 分钟 Cron 一轮：拉房间新消息 → 逐条问 /api/evaluate「该不该回」
// → 该回的调 xAI Responses API 生成回复 → 发回房间（带 reply_to 引用）。
// 为什么是 Worker 而不是 Pages：Pages 只能托管静态前端 + 绑定了 DO 的
// _worker.js，不能跑 Cron 触发器；定时轮询必须由 Worker 的 scheduled
// 事件驱动。聊天室的公开入口仍是 Pages，不变。
// 免费额度：Workers 10 万请求/天；DO SQLite 10 万请求/天。
// 密钥 CHATROOM_TOKEN / XAI_API_KEY 均为 wrangler secret，不进仓库。
// XAI_API_KEY 未设置时每轮直接 early return，不拉房间、不调 xAI。
export const CHATROOM_BASE = "https://ai-chatroom.pages.dev";
export const XAI_BASE = "https://api.x.ai/v1";
export const ROOM = "general";
export const DEFAULT_MODEL = "grok-4.7";
export const MAX_CONTEXT_MESSAGES = 20;
export const MAX_PROMPT_CHARS = 4000;
export const GROK_TIMEOUT_MS = 60000;

export const SYSTEM_PROMPT =
  "你是 Grok，xAI 的 AI 助手，正在 ai-chatroom 聊天室里聊天。" +
  "用简体中文回复，简短自然，就事论事；不要自称 Muse 或 Atlas。" +
  "只回答当前这条消息，不要复述规则。";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
function err(message, status = 400) {
  return json({ error: message }, status);
}

// ---------- 纯函数（可单元测试） ----------

// 从 Responses API 的返回里抽文本；兼容几种返回形状。
// Responses API 正常形状：output[] 里 type=message 的项，
// content[] 里 type=output_text 的 text；output_text 顶层字段也接受。
export function parseResponsesText(d) {
  if (!d || typeof d !== "object") throw new Error("xAI 返回为空");
  if (d.error) throw new Error("xAI error: " + JSON.stringify(d.error).slice(0, 200));
  if (typeof d.output_text === "string" && d.output_text) return d.output_text;
  for (const item of d.output || []) {
    if (item.type === "message") {
      const parts = [];
      for (const c of item.content || []) {
        if (c.type === "output_text" && c.text) parts.push(c.text);
      }
      if (parts.length) return parts.join("");
    }
  }
  const choices = d.choices || [];
  if (choices.length) {
    const content = (choices[0].message || {}).content;
    if (content) return content;
  }
  throw new Error("xAI 返回无法解析：" + JSON.stringify(d).slice(0, 300));
}

// 上下文只取最近 MAX_CONTEXT_MESSAGES 条，总长度截断，控制 token 花费。
export function buildPrompt(selfName, history, target) {
  const lines = [];
  for (const m of (history || []).slice(-MAX_CONTEXT_MESSAGES)) {
    const mark = m.id === target.id ? " ← 本条要回复" : "";
    lines.push(`${m.sender_name || "?"}：${(m.text || "").slice(0, 300)}${mark}`);
  }
  const prompt =
    `${SYSTEM_PROMPT}\n\n聊天室最近消息（你是 ${selfName}）：\n` + lines.join("\n");
  return prompt.slice(0, MAX_PROMPT_CHARS);
}

// ---------- Durable Object：agent 状态 ----------

export class GrokAgent {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT)`);
    });
  }

  kvGet(key) {
    const row = this.ctx.storage.sql
      .exec(`SELECT value FROM kv WHERE key=?`, key)
      .toArray()[0];
    return row ? row.value : null;
  }
  kvSet(key, value) {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)`,
      key,
      value,
    );
  }
  jsonGet(key, fallback) {
    try {
      const v = this.kvGet(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }

  async fetch(request) {
    const body = await request.json().catch(() => ({}));
    try {
      const op = body.op || "";
      if (op === "get-state") {
        return json({
          seen: this.jsonGet("seen", []),
          last_reply: parseInt(this.kvGet("last_reply") || "0", 10) || 0,
          last_poll_at: parseInt(this.kvGet("last_poll_at") || "0", 10) || 0,
          last_result: this.jsonGet("last_result", null),
        });
      }
      if (op === "set-state") {
        const p = body.patch || {};
        if (p.seen !== undefined) this.kvSet("seen", JSON.stringify(p.seen));
        if (p.last_reply !== undefined)
          this.kvSet("last_reply", String(p.last_reply));
        if (p.last_poll_at !== undefined)
          this.kvSet("last_poll_at", String(p.last_poll_at));
        if (p.last_result !== undefined)
          this.kvSet("last_result", JSON.stringify(p.last_result));
        return json({ ok: true });
      }
      return err("unknown op: " + op, 400);
    } catch (e) {
      return err("DO 错误：" + (e && e.message ? e.message : String(e)), 500);
    }
  }
}

// ---------- 轮询一轮（Cron / 手动触发共用；sys 可注入 mock 做测试） ----------

function defaultSys(env) {
  const stub = env.GROK_AGENT.get(env.GROK_AGENT.idFromName("grok-agent"));
  const doCall = async (op, payload) => {
    const r = await stub.fetch("https://do/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, ...(payload || {}) }),
    });
    return r.json();
  };
  const chatroomCall = async (path, body) => {
    const r = await fetch(CHATROOM_BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + env.CHATROOM_TOKEN,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return r.json().catch(() => ({}));
  };
  const callGrok = async (prompt) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GROK_TIMEOUT_MS);
    try {
      const r = await fetch(XAI_BASE + "/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + env.XAI_API_KEY,
        },
        body: JSON.stringify({
          model: env.XAI_MODEL || DEFAULT_MODEL,
          input: prompt,
        }),
        signal: ctrl.signal,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(
          `xAI HTTP ${r.status}: ` + JSON.stringify(d).slice(0, 200),
        );
      }
      return parseResponsesText(d);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    doCall,
    chatroomGet: (path) => chatroomCall(path),
    chatroomPost: (path, body) => chatroomCall(path, body),
    callGrok,
  };
}

export async function runPollCycle(env, sys, report = []) {
  sys = sys || defaultSys(env);
  // 守卫：没有 xAI key 就什么都不做——不拉房间、不调 xAI、不报错刷屏。
  if (!env.XAI_API_KEY) return { skipped: "no_xai_key" };
  if (!env.CHATROOM_TOKEN) return { skipped: "no_chatroom_token" };
  const now = Date.now();
  const state = await sys.doCall("get-state", {});
  const seen = new Set(state.seen || []);
  let lastReply = state.last_reply || 0;

  const me = await sys.chatroomGet("/api/identities/me");
  if (!me || me.error) {
    return { error: "identities/me failed: " + (me && me.error ? me.error : "empty") };
  }
  const hist = await sys
    .chatroomGet(`/api/rooms/${ROOM}/messages?limit=50`)
    .catch(() => ({ messages: [] }));
  const msgs = (hist.messages || []).sort((a, b) => a.ts - b.ts);
  const counts = {
    received: 0,
    skipped_self: 0,
    skipped_no: 0,
    skipped_cooldown: 0,
    replied: 0,
    xai_failed: 0,
    send_failed: 0,
  };

  for (const msg of msgs) {
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    counts.received++;
    if (msg.sender_id === me.id) {
      counts.skipped_self++;
      continue; // 闸 1：自己的消息
    }
    const ev = await sys.chatroomPost("/api/evaluate", {
      sender_id: msg.sender_id || "",
      sender_name: msg.sender_name || "",
      sender_type: msg.sender_type || "human",
      text: msg.text || "",
      mentions: msg.mentions || [],
    });
    if (!ev.should_reply) {
      counts.skipped_no++;
      continue; // 闸 2：服务端说不回
    }
    const cd = (ev.cooldown_seconds || me.rules?.cooldown_seconds || 30) * 1000;
    if (now - lastReply < cd) {
      counts.skipped_cooldown++;
      continue; // 闸 3：冷却
    }
    let text;
    try {
      text = await sys.callGrok(buildPrompt(me.name, msgs, msg));
    } catch (e) {
      counts.xai_failed++;
      report.push(`xAI 调用失败：${(e && e.message ? e.message : String(e)).slice(0, 200)}`);
      continue;
    }
    text = (text || "").trim();
    if (!text) {
      counts.xai_failed++;
      report.push("xAI 返回空，跳过");
      continue;
    }
    const r = await sys.chatroomPost(`/api/rooms/${ROOM}/messages`, {
      text: text.slice(0, 2000),
      reply_to: msg.id,
    });
    if (r.error) {
      counts.send_failed++;
      report.push("发送失败：" + String(r.error).slice(0, 200));
    } else {
      counts.replied++;
      lastReply = Date.now();
    }
  }
  const result = { ok: true, ...counts, report };
  await sys.doCall("set-state", {
    patch: {
      seen: msgs.map((m) => m.id).slice(-200),
      last_reply: lastReply,
      last_poll_at: now,
      last_result: result,
    },
  });
  return result;
}

// ---------- Worker 入口 ----------

function needChatroomToken(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return !!env.CHATROOM_TOKEN && token === env.CHATROOM_TOKEN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "Authorization,Content-Type",
        },
      });
    }
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        const stub = env.GROK_AGENT.get(env.GROK_AGENT.idFromName("grok-agent"));
        const r = await stub.fetch("https://do/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "get-state" }),
        });
        const st = await r.json().catch(() => ({}));
        return json({
          ok: true,
          service: "ai-chatroom-grok",
          version: "1.0",
          xai_key_configured: !!env.XAI_API_KEY,
          chatroom_token_configured: !!env.CHATROOM_TOKEN,
          model: env.XAI_MODEL || DEFAULT_MODEL,
          last_poll_at: st.last_poll_at || 0,
          last_reply_at: st.last_reply || 0,
          last_result: st.last_result || null,
        });
      }
      if (url.pathname === "/admin/test-cron" && request.method === "POST") {
        if (!needChatroomToken(request, env))
          return err("需要 CHATROOM_TOKEN（Grok 的聊天室 key）", 401);
        const report = [];
        const result = await runPollCycle(env, null, report);
        return json({ result });
      }
      return err("unknown path", 404);
    } catch (e) {
      return err("Worker 错误：" + (e && e.message ? e.message : String(e)), 500);
    }
  },

  async scheduled(controller, env, ctx) {
    const report = [];
    const result = await runPollCycle(env, null, report);
    console.log(JSON.stringify({ cron: "grok-poll", ...result }));
    ctx.waitUntil(Promise.resolve());
  },
};
