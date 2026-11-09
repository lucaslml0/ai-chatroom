// ai-chatroom-wechat — Cloudflare Worker 微信桥（无服务器、无 AI）。
// 唯一职责：在腾讯 iLink Bot API 与聊天室之间搬运消息。
// - 每 1 分钟 Cron 拉一次 getupdates（20 秒 abort 超时，不用 45 秒长轮询）；
// - 「聊：」进聊天室（按绑定解析身份）、绑定码绑 key、其余文本进命令队列；
// - 回推只发 @绑定身份 / @所有人 / 系统消息 / @微信访客（沿用旧桥规则）。
// 免费额度：Workers 10 万请求/天；DO SQLite 10 万请求/天。
// 密钥 ILINK_BOT_TOKEN / BRIDGE_TOKEN 均为 wrangler secret，不进仓库。
import qrcode from "./qrcode.js";

export const ILINK_BASE = "https://ilinkai.weixin.qq.com";
export const CHATROOM_BASE = "https://ai-chatroom.pages.dev";
export const JOIN_PAGE = "https://ai-chatroom.pages.dev/wechat-join";
export const POLL_TIMEOUT_MS = 20000;
export const SESSION_BACKOFF_MS = 3600 * 1000;
export const ROOM = "general";

export const GREETING =
  "我是 Atlas，微信收发已经通了 ✅\n你在微信里给 ClawBot 发的消息我都能收到。直接在这里给我派活就行。";
export const ACK = "收到 ✅ 我记下了，会在 Muse 那边处理。";
const CHAT_PREFIXES = ["聊：", "聊:"];
const BIND_CODE_RE = /^([A-Za-z0-9]{6})$/;
const BIND_WORD_RE = /^绑定\s*([A-Za-z0-9]{6})$/;

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
function newId(prefix) {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------- 纯函数（可单元测试） ----------

// 从一条 getupdates 消息里抽文本（与 ilink.py extract_text 同规则）。
export function extractText(msg) {
  const parts = [];
  for (const item of msg.item_list || []) {
    if (item.type === 1) {
      const t = (item.text_item || {}).text;
      if (t) parts.push(t);
    } else if (item.type === 3) {
      const t = (item.voice_item || {}).text;
      if (t) parts.push(t);
    }
  }
  return parts.join("\n");
}

// 入站分流：绑定码 / 聊： / 命令。
export function classifyInbound(text) {
  const t = (text || "").trim();
  if (!t) return { kind: "empty" };
  const bw = t.match(BIND_WORD_RE);
  if (bw) return { kind: "bind", code: bw[1].toUpperCase() };
  const bare = t.match(BIND_CODE_RE);
  if (bare) return { kind: "bind", code: bare[1].toUpperCase() };
  for (const p of CHAT_PREFIXES) {
    if (t.startsWith(p)) {
      const body = t.slice(p.length).trim();
      return body ? { kind: "chat", text: body } : { kind: "empty" };
    }
  }
  return { kind: "command", text: t };
}

// 回推路由：返回要发给哪些 wechat_id（纯函数）。
// boundByName: Map<identity 名字, wechat_id>；allBound: 全部已绑定 wechat_id；
// lastFrom: 最近一位未绑定发送者（供「微信访客」沿用旧行为）。
export function routePushTargets(msg, boundByName, allBound, lastFrom) {
  const mentions = msg.mentions || [];
  const targets = new Set();
  for (const name of mentions) {
    if (boundByName.has(name)) targets.add(boundByName.get(name));
  }
  if (mentions.includes("all") || mentions.includes("所有人")) {
    for (const w of allBound) targets.add(w);
  }
  if (msg.sender_name === "系统") {
    for (const w of allBound) targets.add(w);
  }
  if (mentions.includes("微信访客") && lastFrom) targets.add(lastFrom);
  return [...targets];
}

export function formatPush(room, msg) {
  return `${msg.sender_name || "?"}：${(msg.text || "").slice(0, 1000)}`;
}

// 绑定码对应的加入页 QR（SVG 字符串）。
export function makeQrSvg(code) {
  const qr = qrcode(0, "M");
  qr.addData(JOIN_PAGE + "?code=" + code);
  qr.make();
  return qr.createSvgTag(6, 24);
}

// ---------- iLink 客户端（与 ilink.py 同协议） ----------

function ilinkHeaders(token) {
  const uin = crypto.getRandomValues(new Uint32Array(1))[0];
  const h = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": btoa(String(uin)),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 10),
  };
  if (token) h["Authorization"] = "Bearer " + token;
  return h;
}

async function ilinkPost(endpoint, body, token, timeoutMs = POLL_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(ILINK_BASE + "/" + endpoint, {
      method: "POST",
      headers: ilinkHeaders(token),
      body: JSON.stringify({
        ...body,
        base_info: { channel_version: "2.4.10", bot_agent: "OpenClaw" },
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`iLink HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function ilinkGetUpdates(token, buf, timeoutMs = POLL_TIMEOUT_MS) {
  return ilinkPost(
    "ilink/bot/getupdates",
    { get_updates_buf: buf || "" },
    token,
    timeoutMs,
  );
}

async function ilinkSendText(token, toUserId, text, contextToken) {
  const msg = {
    from_user_id: "",
    to_user_id: toUserId,
    client_id: `wechat-bridge-${crypto.randomUUID()}`,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
  };
  if (contextToken) msg.context_token = contextToken;
  return ilinkPost("ilink/bot/sendmessage", { msg }, token, 15000);
}

// ---------- 聊天室客户端 ----------

async function chatroomCall(env, path, body) {
  const r = await fetch(CHATROOM_BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.BRIDGE_TOKEN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

// ---------- Durable Object：桥状态 ----------

export class WeChatBridge {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        `CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT)`,
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS contexts(wechat_id TEXT PRIMARY KEY, context_token TEXT, updated_at INTEGER)`,
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, wechat_id TEXT, text TEXT, status TEXT DEFAULT 'pending', created_at INTEGER, replied_at INTEGER)`,
      );
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
    const sql = this.ctx.storage.sql;
    try {
      const op = body.op || "";
      if (op === "get-state") {
        return json({
          buf: this.kvGet("buf") || "",
          session_expired_until:
            parseInt(this.kvGet("session_expired_until") || "0", 10) || 0,
          last_poll_at: parseInt(this.kvGet("last_poll_at") || "0", 10) || 0,
          last_from: this.kvGet("last_from") || null,
          seen: this.jsonGet("seen", {}),
          greeted: this.jsonGet("greeted", []),
        });
      }
      if (op === "set-state") {
        const p = body.patch || {};
        if (p.buf !== undefined) this.kvSet("buf", p.buf);
        if (p.session_expired_until !== undefined)
          this.kvSet("session_expired_until", String(p.session_expired_until));
        if (p.last_poll_at !== undefined)
          this.kvSet("last_poll_at", String(p.last_poll_at));
        if (p.last_from !== undefined)
          this.kvSet("last_from", p.last_from || "");
        if (p.seen !== undefined) this.kvSet("seen", JSON.stringify(p.seen));
        if (p.greeted !== undefined)
          this.kvSet("greeted", JSON.stringify(p.greeted));
        return json({ ok: true });
      }
      if (op === "upsert-context") {
        sql.exec(
          `INSERT OR REPLACE INTO contexts(wechat_id,context_token,updated_at) VALUES(?,?,?)`,
          String(body.wechat_id || ""),
          String(body.context_token || ""),
          Date.now(),
        );
        return json({ ok: true });
      }
      if (op === "get-context") {
        const row = sql
          .exec(
            `SELECT context_token FROM contexts WHERE wechat_id=?`,
            String(body.wechat_id || ""),
          )
          .toArray()[0];
        return json({ context_token: row ? row.context_token : null });
      }
      if (op === "add-command") {
        const id = newId("cmd_");
        sql.exec(
          `INSERT INTO commands(id,wechat_id,text,status,created_at) VALUES(?,?,?,?,?)`,
          id,
          String(body.wechat_id || ""),
          String(body.text || "").slice(0, 2000),
          "pending",
          Date.now(),
        );
        return json({ id });
      }
      if (op === "list-commands") {
        const status = String(body.status || "pending");
        const rows =
          status === "all"
            ? sql
                .exec(
                  `SELECT * FROM commands ORDER BY created_at DESC LIMIT 100`,
                )
                .toArray()
            : sql
                .exec(
                  `SELECT * FROM commands WHERE status=? ORDER BY created_at DESC LIMIT 100`,
                  status,
                )
                .toArray();
        return json({ commands: rows });
      }
      if (op === "get-command") {
        const row = sql
          .exec(`SELECT * FROM commands WHERE id=?`, String(body.id || ""))
          .toArray()[0];
        return json({ command: row || null });
      }
      if (op === "mark-replied") {
        sql.exec(
          `UPDATE commands SET status='replied', replied_at=? WHERE id=?`,
          Date.now(),
          String(body.id || ""),
        );
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
  const stub = env.WECHAT_BRIDGE.get(
    env.WECHAT_BRIDGE.idFromName("wechat-bridge"),
  );
  const doCall = async (op, payload) => {
    const r = await stub.fetch("https://do/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, ...(payload || {}) }),
    });
    return r.json();
  };
  return {
    doCall,
    ilinkGetUpdates: (buf) => ilinkGetUpdates(env.ILINK_BOT_TOKEN, buf),
    ilinkSendText: (to, text, ctx) =>
      ilinkSendText(env.ILINK_BOT_TOKEN, to, text, ctx),
    chatroomGet: (path) => chatroomCall(env, path),
    chatroomPost: (path, body) => chatroomCall(env, path, body),
  };
}

export async function runPollCycle(env, sys, report = []) {
  sys = sys || defaultSys(env);
  const now = Date.now();
  const state = await sys.doCall("get-state", {});
  if (state.session_expired_until && now < state.session_expired_until) {
    return { skipped: "session_expired", until: state.session_expired_until };
  }
  let resp;
  try {
    resp = await sys.ilinkGetUpdates(state.buf || "");
  } catch (e) {
    return {
      error: "getupdates failed: " + (e && e.message ? e.message : String(e)),
    };
  }
  const code =
    resp.errcode !== undefined && resp.errcode !== null
      ? resp.errcode
      : (resp.ret ?? 0);
  if (code !== 0) {
    if (code === -14) {
      const until = now + SESSION_BACKOFF_MS;
      await sys.doCall("set-state", {
        patch: { session_expired_until: until },
      });
      return { session_expired: true, until };
    }
    return {
      error: `getupdates ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg || ""}`,
    };
  }
  const patch = { last_poll_at: now };
  if (resp.get_updates_buf) patch.buf = resp.get_updates_buf;

  // 绑定表先拉一次：分流（last_from）与回推（路由）共用。
  const bindings = await sys
    .chatroomGet("/api/bridge/wechat-bindings")
    .catch(() => ({ bindings: [] }));
  const list = bindings.bindings || [];
  const boundByName = new Map(list.map((b) => [b.identity_name, b.wechat_id]));
  const boundIds = new Set(list.map((b) => b.wechat_id));
  const allBound = list.map((b) => b.wechat_id);
  const greeted = new Set(state.greeted || []);
  let lastFrom = state.last_from || null;
  const counts = {
    received: 0,
    forwarded: 0,
    bound: 0,
    commands: 0,
    greeted: 0,
  };

  for (const m of resp.msgs || []) {
    // message_type 1 = 用户发来的消息；2 = Bot 自己发出的回声，不处理。
    if (
      m.message_type !== undefined &&
      m.message_type !== null &&
      m.message_type !== 1
    )
      continue;
    const from = m.from_user_id || "";
    if (!from) continue;
    counts.received++;
    if (m.context_token)
      await sys.doCall("upsert-context", {
        wechat_id: from,
        context_token: m.context_token,
      });
    if (!boundIds.has(from)) lastFrom = from;
    const text = extractText(m).trim();
    if (!text) continue;
    const c = classifyInbound(text);
    if (c.kind === "bind") {
      const r = await sys.chatroomPost("/api/bridge/bind-wechat", {
        code: c.code,
        wechat_id: from,
        wechat_name: from,
      });
      if (r.identity) {
        counts.bound++;
        await sys.ilinkSendText(
          from,
          `绑定成功，你现在是「${r.identity.name}」，发「聊：…」就能进聊天室说话了。`,
          m.context_token,
        );
      } else {
        await sys.ilinkSendText(
          from,
          `绑定失败：${r.error || "绑定码无效"}。请检查绑定码，或让房主重新生成一个。`,
          m.context_token,
        );
      }
    } else if (c.kind === "chat") {
      const r = await sys.chatroomPost(`/api/rooms/${ROOM}/bridge-message`, {
        platform: "wechat",
        sender_name: "微信访客",
        sender_type: "human",
        text: c.text,
        wechat_id: from,
      });
      if (r.message) counts.forwarded++;
      else report.push("bridge-message failed: " + (r.error || "unknown"));
    } else if (c.kind === "command") {
      await sys.doCall("add-command", { wechat_id: from, text: c.text });
      counts.commands++;
      const isFirst = !greeted.has(from);
      await sys.ilinkSendText(from, isFirst ? GREETING : ACK, m.context_token);
      if (isFirst) {
        greeted.add(from);
        counts.greeted++;
      }
    }
  }
  patch.last_from = lastFrom;
  patch.greeted = [...greeted];

  // 回推：房里非 wechat 来源的新消息，按路由发回微信。
  const seen = state.seen || {};
  const seenGeneral = new Set(seen.general || []);
  const hist = await sys
    .chatroomGet(`/api/rooms/${ROOM}/messages?limit=50`)
    .catch(() => ({ messages: [] }));
  const msgs = hist.messages || [];
  const fresh = msgs
    .filter((m) => !seenGeneral.has(m.id) && m.platform !== "wechat")
    .sort((a, b) => a.ts - b.ts);
  let pumped = 0,
    skippedNoCtx = 0;
  for (const m of fresh) {
    for (const wid of routePushTargets(m, boundByName, allBound, lastFrom)) {
      const ctx = await sys.doCall("get-context", { wechat_id: wid });
      if (!ctx || !ctx.context_token) {
        skippedNoCtx++;
        continue;
      }
      const r = await sys.ilinkSendText(
        wid,
        formatPush(ROOM, m),
        ctx.context_token,
      );
      if (r && (r.ret === 0 || r.ret === null || r.ret === undefined)) pumped++;
      else {
        skippedNoCtx++;
        report.push(`pump send failed to ${wid}: ret=${r && r.ret}`);
      }
    }
  }
  patch.seen = { ...seen, general: msgs.map((m) => m.id).slice(-200) };
  await sys.doCall("set-state", { patch });
  return {
    ok: true,
    ...counts,
    pumped,
    skipped_no_context: skippedNoCtx,
    report,
  };
}

// POST /reply 的核心逻辑（抽出来以便单元测试；fetch 层只做鉴权与参数解析）。
export async function handleReply(sys, body) {
  const commandId = String(body.command_id || "");
  const wechatId = String(body.wechat_id || "");
  const text = String(body.text || "").trim();
  if (!commandId || !wechatId || !text)
    return {
      status: 400,
      data: { error: "command_id、wechat_id、text 都要填" },
    };
  const { command } = await sys.doCall("get-command", { id: commandId });
  if (!command) return { status: 404, data: { error: "找不到这条命令" } };
  if (command.wechat_id !== wechatId)
    return { status: 403, data: { error: "命令与微信用户不符" } };
  if (command.status !== "pending")
    return { status: 409, data: { error: "这条命令已经回复过了" } };
  const ctx = await sys.doCall("get-context", { wechat_id: wechatId });
  if (!ctx || !ctx.context_token)
    return {
      status: 400,
      data: {
        error: "没有可用的 context_token：对方需先在微信里发一条消息刷新",
      },
    };
  const r = await sys.ilinkSendText(
    wechatId,
    text.slice(0, 1000),
    ctx.context_token,
  );
  if (r.ret !== 0 && r.ret !== null && r.ret !== undefined) {
    return {
      status: 502,
      data: { error: `微信发送失败 ret=${r.ret} ${r.errmsg || ""}` },
    };
  }
  await sys.doCall("mark-replied", { id: commandId });
  return { status: 200, data: { ok: true, command_id: commandId } };
}

// ---------- Worker 入口 ----------

function needBridgeToken(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return !!env.BRIDGE_TOKEN && token === env.BRIDGE_TOKEN;
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
        const stub = env.WECHAT_BRIDGE.get(
          env.WECHAT_BRIDGE.idFromName("wechat-bridge"),
        );
        const r = await stub.fetch("https://do/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "get-state" }),
        });
        const st = await r.json().catch(() => ({}));
        const cmds = await stub
          .fetch("https://do/", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: "list-commands", status: "pending" }),
          })
          .then((x) => x.json())
          .catch(() => ({ commands: [] }));
        const now = Date.now();
        return json({
          ok: true,
          service: "ai-chatroom-wechat",
          version: "1.0",
          session_expired: !!(
            st.session_expired_until && now < st.session_expired_until
          ),
          session_expired_until: st.session_expired_until || 0,
          last_poll_at: st.last_poll_at || 0,
          pending_commands: (cmds.commands || []).length,
        });
      }
      if (url.pathname === "/qr" && request.method === "GET") {
        const code = (url.searchParams.get("code") || "").toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code))
          return err("code 必须是 6 位大写字母数字", 400);
        const svg = makeQrSvg(code);
        return new Response(svg, {
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
      if (url.pathname === "/commands" && request.method === "GET") {
        if (!needBridgeToken(request, env))
          return err("需要 BRIDGE_TOKEN", 401);
        const stub = env.WECHAT_BRIDGE.get(
          env.WECHAT_BRIDGE.idFromName("wechat-bridge"),
        );
        const r = await stub.fetch("https://do/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            op: "list-commands",
            status: url.searchParams.get("status") || "pending",
          }),
        });
        return json(await r.json(), r.status);
      }
      if (url.pathname === "/reply" && request.method === "POST") {
        if (!needBridgeToken(request, env))
          return err("需要 BRIDGE_TOKEN", 401);
        const body = await request.json().catch(() => ({}));
        const { status, data } = await handleReply(defaultSys(env), body);
        return json(data, status);
      }
      if (url.pathname === "/admin/test-cron" && request.method === "POST") {
        if (!needBridgeToken(request, env))
          return err("需要 BRIDGE_TOKEN", 401);
        const report = [];
        const result = await runPollCycle(env, null, report);
        return json({ result });
      }
      return err("unknown path", 404);
    } catch (e) {
      return err(
        "Worker 错误：" + (e && e.message ? e.message : String(e)),
        500,
      );
    }
  },

  async scheduled(controller, env, ctx) {
    const report = [];
    const result = await runPollCycle(env, null, report);
    console.log(JSON.stringify({ cron: "wechat-poll", ...result }));
    ctx.waitUntil(Promise.resolve());
  },
};
