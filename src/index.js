import qrcode from "./qrcode.js";

// ai-chatroom v2 — Cloudflare Workers + Durable Objects (SQLite, free tier)
// PLAN.md v2.4 + v2.6: Token 准入、一号一 key；房主最高权限；Moderator 风险操作
// （禁言/踢人/删消息/吊销 key）需房主批准；Moderator 可建 key 并私发房主；
// Moderator 只回 @Moderator 的消息（Workers AI 小管家，见 scheduled 处理）。
// v2.6：聊天记录默认只保存 7 天（到期自动清理）；在线名单含 WS 连接者 +
// 5 分钟内有活动的 Agent/Bot/桥接；聊天框「清空显示」只清本地视图。
// 免费额度：Workers 10万请求/天；DO SQLite 10万请求/天 + 13000 GB-s/天；
// Workers AI 10000 neurons/天（小管家日预算 2000）。

// 微信桥已并进聊天室自己的服务（2026-11-09）：拉取、回推、命令队列、/reply
// 都住在 src/index.js 里（桥状态在 ChatRoom DO 的 wechat_* 表）；Pages 不能
// 托管 Cron/DO，所以 1 分钟拉取定时器作为第二条 Cron 挂在 muse-chatroom
// Worker 上。独立的 ai-chatroom-wechat Worker 已废弃（见 RUNBOOK）。
// 微信桥公开地址就是本站（Pages），QR 也由本站 /qr 出。
const WECHAT_BRIDGE_URL = "https://ai-chatroom.pages.dev";

// ---------- 微信桥（iLink）常量 ----------
const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const CHATROOM_BASE = "https://ai-chatroom.pages.dev";
const JOIN_PAGE = "https://ai-chatroom.pages.dev/wechat-join";
const POLL_TIMEOUT_MS = 20000;
const SESSION_BACKOFF_MS = 3600 * 1000;
const WECHAT_ROOM = "general";

export const DEFAULT_ROOMS = [
  { slug: "general", name: "综合大厅", topic: "随便聊，Muse 使用心得、邀请互换都从这里开始" },
  { slug: "muse-exchange", name: "邀请互换", topic: "新用户互邀、换 token、分享邀请码（只发自己的邀请，别发账号密码）" },
  { slug: "help", name: "新手求助", topic: "刚用 Muse 不会配置？在这里问，大家和 Agent 一起回" },
];

export function defaultRules() {
  return {
    mode: "humans_only",
    ignore_agents: true,
    keywords: [],
    allow_senders: [],
    block_senders: [],
    cooldown_seconds: 30,
  };
}

const MODES = ["humans_only", "mentions_only", "all", "keywords", "none"];
const ROLES = ["owner", "moderator", "member"];
const ACTIONS = ["mute", "kick", "delete", "revoke-key"];

// v2.6：聊天记录默认只保存 7 天（meta retention_days 可改，1–90 天）；
// 在线窗口 5 分钟：WS 连接者 + 5 分钟内有活动的身份都算在线。
const RETENTION_DAYS_DEFAULT = 7;
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

// 回复规则引擎：服务端 /api/evaluate 与前端、Python 示例共用同一逻辑。
export function evaluateRules(rules, msg, self) {
  const r = { ...defaultRules(), ...(rules || {}) };
  const sender = msg.sender_name || "";
  const senderId = msg.sender_id || "";
  const text = msg.text || "";
  const mentions = msg.mentions || [];
  if (self && senderId && senderId === self.id) return { should_reply: false, reason: "自己的消息" };
  const blocked = (r.block_senders || []).some((x) => x === sender || x === senderId);
  if (blocked) return { should_reply: false, reason: "在屏蔽名单里" };
  if ((r.allow_senders || []).length > 0) {
    const ok = r.allow_senders.some((x) => x === sender || x === senderId);
    if (!ok) return { should_reply: false, reason: "不在白名单里" };
  }
  // @ 提及按短名匹配：名字带（…）后缀时，用户只会 @ 短名（如 @Atlas 而不是 @Atlas（muse））。
  // 容错：去标点/大小写，并接受字母换位等拼写误差——用户常打成 Altas、A'l'ta's，这类也算 @ 到。
  const shortName = (self.name || "").split("（")[0].split("(")[0].trim();
  const norm = (s) => String(s || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const sorted = (s) => [...norm(s)].sort().join("");
  const nameHit = (m) => {
    const nm = norm(m);
    if (!nm) return false;
    return nm === norm(self.name) || (shortName && nm === norm(shortName)) ||
      sorted(m) === sorted(self.name) || (shortName && sorted(m) === sorted(shortName));
  };
  const mentioned = self && (mentions.some(nameHit) || mentions.includes("all") || mentions.includes("所有人"));
  const hitKeyword = (r.keywords || []).some((k) => k && text.includes(k));
  if (r.mode === "none") return { should_reply: false, reason: "模式是不自动回复" };
  if (mentioned) return { should_reply: true, reason: "被 @提及" };
  if (hitKeyword) return { should_reply: true, reason: "命中关键词" };
  if (r.mode === "mentions_only") return { should_reply: false, reason: "只回 @我的消息" };
  if (r.mode === "keywords") return { should_reply: false, reason: "只回关键词消息" };
  const isAgent = msg.sender_type === "agent" || msg.sender_type === "bot";
  if (isAgent && r.ignore_agents) return { should_reply: false, reason: "默认忽略其他 Agent，避免循环" };
  if (r.mode === "humans_only" && msg.sender_type !== "human") return { should_reply: false, reason: "只回人类消息" };
  if (r.mode === "all") return { should_reply: true, reason: "模式是全部回复" };
  return { should_reply: true, reason: "符合回复规则" };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
}
function err(message, status = 400) { return json({ error: message }, status); }
function newToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return "muse_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function newId(prefix) {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return prefix + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function parseMentions(text) {
  const out = [];
  for (const m of text.matchAll(/@([^\s@]{1,30})/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
function sanitizeRules(input) {
  const r = defaultRules();
  if (!input || typeof input !== "object") return r;
  if (MODES.includes(input.mode)) r.mode = input.mode;
  if (typeof input.ignore_agents === "boolean") r.ignore_agents = input.ignore_agents;
  const arr = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, 20).map((x) => x.trim()) : [];
  r.keywords = arr(input.keywords);
  r.allow_senders = arr(input.allow_senders);
  r.block_senders = arr(input.block_senders);
  if (Number.isFinite(+input.cooldown_seconds)) r.cooldown_seconds = Math.max(0, Math.min(3600, Math.floor(+input.cooldown_seconds)));
  return r;
}
async function sha12(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

// ---------------- Durable Object ----------------
export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rate = new Map();
    this.ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS identities(
        token TEXT PRIMARY KEY, id TEXT, name TEXT, type TEXT,
        platform TEXT DEFAULT 'web', role TEXT DEFAULT 'member', bridge TEXT DEFAULT '',
        rules TEXT, revoked INTEGER DEFAULT 0,
        created INTEGER, last_reply INTEGER DEFAULT 0, last_seen INTEGER DEFAULT 0)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS rooms(
        slug TEXT PRIMARY KEY, name TEXT, topic TEXT, created INTEGER)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY, sender_id TEXT, sender_name TEXT, sender_type TEXT,
        platform TEXT DEFAULT 'web', text TEXT, reply_to TEXT, mentions TEXT, ts INTEGER)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS mutes(
        identity_id TEXT PRIMARY KEY, until INTEGER, reason TEXT, by_name TEXT)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS approvals(
        id TEXT PRIMARY KEY, requester_id TEXT, requester_name TEXT,
        action TEXT, target_id TEXT, target_name TEXT, reason TEXT,
        evidence_msg_id TEXT, minutes INTEGER DEFAULT 10, status TEXT DEFAULT 'pending',
        approver_name TEXT, created INTEGER, expires_at INTEGER)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS key_inbox(
        id TEXT PRIMARY KEY, token TEXT, purpose TEXT, created_by TEXT,
        created INTEGER, status TEXT DEFAULT 'pending')`);
      sql.exec(`CREATE TABLE IF NOT EXISTS wechat_bindings(
        wechat_id TEXT PRIMARY KEY, identity_id TEXT, wechat_name TEXT, bound_at INTEGER)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS wechat_bind_codes(
        code TEXT PRIMARY KEY, identity_id TEXT, created INTEGER, expires_at INTEGER, used INTEGER DEFAULT 0)`);
      // 微信桥状态（2026-11-09 并进聊天室服务；旧独立 Worker 的 WeChatBridge
      // DO 同结构改名前缀，绝不动上面聊天室的表）。
      sql.exec(`CREATE TABLE IF NOT EXISTS wechat_kv(key TEXT PRIMARY KEY, value TEXT)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS wechat_contexts(wechat_id TEXT PRIMARY KEY, context_token TEXT, updated_at INTEGER)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS wechat_commands(id TEXT PRIMARY KEY, wechat_id TEXT, text TEXT, status TEXT DEFAULT 'pending', created_at INTEGER, replied_at INTEGER)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`);
      sql.exec(`CREATE INDEX IF NOT EXISTS messages_ts_idx ON messages(ts)`);
      // v1 老表升级：补列（列已存在会抛错，直接忽略）
      for (const [table, col, def] of [
        ["identities", "platform", "TEXT DEFAULT 'web'"],
        ["identities", "role", "TEXT DEFAULT 'member'"],
        ["identities", "bridge", "TEXT DEFAULT ''"],
        ["identities", "revoked", "INTEGER DEFAULT 0"],
        ["identities", "last_seen", "INTEGER DEFAULT 0"],
        ["messages", "platform", "TEXT DEFAULT 'web'"],
        ["approvals", "minutes", "INTEGER DEFAULT 10"],
      ]) {
        try { sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* 已有该列 */ }
      }
      for (const room of DEFAULT_ROOMS) {
        sql.exec(`INSERT OR IGNORE INTO rooms(slug,name,topic,created) VALUES(?,?,?,?)`,
          room.slug, room.name, room.topic, Date.now());
      }
    });
  }

  members() {
    const seen = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const a = ws.deserializeAttachment();
        if (a && a.id && !seen.has(a.id)) seen.set(a.id, { id: a.id, name: a.name, type: a.type, platform: a.platform || "web" });
      } catch { /* ignore */ }
    }
    return [...seen.values()];
  }
  // 在线名单：WS 连接者 + 5 分钟内有活动的身份（REST 轮询的 Agent/Bot、
  // 微信/Telegram 桥接、值班的 Atlas 都算）。已吊销的不算。
  // 注意：身份只存在注册表 DO 里，房间 DO 自己的 identities 表是空的，
  // 所以最近活跃名单要问注册表（和 isMuted 一样的内部调用）。
  async presence() {
    const seen = new Map();
    for (const m of this.members()) seen.set(m.id, { ...m, bridge: "" });
    try {
      const stub = this.env.CHATROOM.get(this.env.CHATROOM.idFromName("__registry__"));
      const r = await stub.fetch("https://do/registry/list-online?since=" + (Date.now() - ONLINE_WINDOW_MS));
      const d = await r.json().catch(() => ({}));
      for (const x of (d.online || [])) {
        if (!seen.has(x.id)) seen.set(x.id, { id: x.id, name: x.name, type: x.type, platform: x.platform || "web", bridge: x.bridge || "" });
      }
    } catch { /* 注册表读不到就只返回 WS 成员 */ }
    return [...seen.values()];
  }
  broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch { /* closed */ }
    }
  }
  checkRate(senderId) {
    const now = Date.now();
    const list = (this.rate.get(senderId) || []).filter((t) => now - t < 10000);
    if (list.length >= 5) return false;
    list.push(now);
    this.rate.set(senderId, list);
    return true;
  }
  async isMuted(senderId) {
    try {
      const stub = this.env.CHATROOM.get(this.env.CHATROOM.idFromName("__registry__"));
      const r = await stub.fetch("https://do/registry/is-muted?id=" + encodeURIComponent(senderId));
      const d = await r.json().catch(() => ({}));
      return !!d.muted;
    } catch { return false; }
  }
  async storeMessage(sender, text, replyTo) {
    const sql = this.ctx.storage.sql;
    const msg = {
      id: newId("m_"), sender_id: sender.id, sender_name: sender.name,
      sender_type: sender.type, platform: sender.platform || "web",
      text, reply_to: replyTo || null,
      mentions: parseMentions(text), ts: Date.now(),
    };
    sql.exec(`INSERT INTO messages(id,sender_id,sender_name,sender_type,platform,text,reply_to,mentions,ts)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      msg.id, msg.sender_id, msg.sender_name, msg.sender_type, msg.platform, msg.text,
      msg.reply_to, JSON.stringify(msg.mentions), msg.ts);
    this.pruneOldMessages();
    return msg;
  }
  // 保留期清理：默认 7 天；meta retention_days 可改（1–90 天）。返回清理条数。
  pruneOldMessages() {
    const sql = this.ctx.storage.sql;
    let days = RETENTION_DAYS_DEFAULT;
    try {
      const row = sql.exec(`SELECT value FROM meta WHERE key='retention_days'`).toArray()[0];
      const n = parseInt(row ? row.value : "", 10);
      if (Number.isFinite(n)) days = Math.max(1, Math.min(90, n));
    } catch { /* 读不到就用默认 */ }
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const n = sql.exec(`SELECT COUNT(*) AS n FROM messages WHERE ts < ?`, cutoff).toArray()[0].n;
    if (n > 0) sql.exec(`DELETE FROM messages WHERE ts < ?`, cutoff);
    return n;
  }
  // 唯一名字：重名自动加 #2、#3……
  uniqueName(base) {
    const sql = this.ctx.storage.sql;
    const rows = sql.exec(`SELECT name FROM identities WHERE name = ? OR name LIKE ?`, base, base + " #%").toArray();
    const taken = new Set(rows.map((r) => r.name));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base} #${n}`)) n++;
    return `${base} #${n}`;
  }

  // ---------- 内部：注册表 ----------
  async registryFetch(request) {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const identByToken = (token) => {
      if (!token) return null;
      return sql.exec(`SELECT token,id,name,type,platform,role,bridge,rules,revoked,created,last_reply,last_seen FROM identities WHERE token=?`, token).toArray()[0] || null;
    };
    const identById = (id) => {
      if (!id) return null;
      return sql.exec(`SELECT token,id,name,type,platform,role,bridge,rules,revoked,created,last_reply,last_seen FROM identities WHERE id=?`, id).toArray()[0] || null;
    };
    const pub = (row) => row ? { id: row.id, name: row.name, type: row.type, platform: row.platform, role: row.role, bridge: row.bridge, rules: JSON.parse(row.rules || "{}"), revoked: !!row.revoked, created: row.created, last_seen: row.last_seen } : null;

    if (url.pathname === "/registry/identity") {
      const row = identByToken(url.searchParams.get("token") || "");
      if (!row) return err("token 无效", 401);
      return json(pub(row));
    }
    if (url.pathname === "/registry/is-muted") {
      const row = sql.exec(`SELECT until FROM mutes WHERE identity_id=?`, url.searchParams.get("id") || "").toArray()[0];
      return json({ muted: !!row && row.until > Date.now(), until: row ? row.until : 0 });
    }
    if (url.pathname === "/registry/count") {
      const row = sql.exec(`SELECT COUNT(*) AS n FROM identities`).toArray()[0];
      return json({ count: row.n });
    }
    // 引导：只有 identities 为空且 setup_key 对上时才能建房主
    if (url.pathname === "/registry/bootstrap" && request.method === "POST") {
      const n = sql.exec(`SELECT COUNT(*) AS n FROM identities`).toArray()[0].n;
      if (n > 0) return err("已初始化，引导通道已关闭", 403);
      if (!this.env.SETUP_KEY || body.setup_key !== this.env.SETUP_KEY) return err("setup_key 不对", 403);
      const name = String(body.name || "luo").trim().slice(0, 30) || "luo";
      const token = newToken();
      const id = newId("u_");
      sql.exec(`INSERT INTO identities(token,id,name,type,platform,role,bridge,rules,revoked,created) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        token, id, name, "human", "web", "owner", "", JSON.stringify(defaultRules()), 0, Date.now());
      return json({ token, id, name, type: "human", role: "owner" });
    }
    // 创建 key：房主与 Moderator 可做；Moderator 只能建 member，且 key 进房主私信箱
    if (url.pathname === "/registry/create-key" && request.method === "POST") {
      const req = identByToken(String(body.requester_token || ""));
      if (!req || req.revoked) return err("需要房主或 Moderator 的 Token", 401);
      if (req.role !== "owner" && req.role !== "moderator") return err("只有房主和 Moderator 能发 key", 403);
      const name = this.uniqueName(String(body.name || "").trim().slice(0, 30));
      if (!String(body.name || "").trim()) return err("需要一个名字");
      const type = ["human", "agent", "bot"].includes(body.type) ? body.type : "agent";
      const platform = ["web", "wechat", "telegram", "api"].includes(body.platform) ? body.platform : "api";
      const bridge = ["", "wechat", "telegram"].includes(body.bridge) ? body.bridge : "";
      // Moderator 只能建普通成员，不能建房主/Moderator，也不能建桥接身份
      const role = req.role === "owner" && ROLES.includes(body.role) ? body.role : "member";
      const finalBridge = req.role === "owner" ? bridge : "";
      const token = newToken();
      const id = newId("u_");
      const rules = sanitizeRules(body.rules);
      sql.exec(`INSERT INTO identities(token,id,name,type,platform,role,bridge,rules,revoked,created) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        token, id, name, type, platform, role, finalBridge, JSON.stringify(rules), 0, Date.now());
      const inboxId = newId("k_");
      sql.exec(`INSERT INTO key_inbox(id,token,purpose,created_by,created,status) VALUES(?,?,?,?,?,?)`,
        inboxId, token, String(body.purpose || "").slice(0, 120), req.name, Date.now(), "pending");
      return json({ token, id, name, type, platform, role, bridge: finalBridge, inbox_id: inboxId,
        note: req.role === "moderator" ? "key 已进房主私信箱，由房主分发" : "key 已生成，请私下发给对方" });
    }
    if (url.pathname === "/registry/set-rules" && request.method === "POST") {
      const row = identByToken(String(body.token || ""));
      if (!row || row.revoked) return err("token 无效", 401);
      const rules = sanitizeRules(body.rules);
      sql.exec(`UPDATE identities SET rules=? WHERE token=?`, JSON.stringify(rules), String(body.token));
      return json({ rules });
    }
    // 房主代设某成员的回复规则（内部执行：Worker 已核对房主身份）
    if (url.pathname === "/registry/set-rules-by-id" && request.method === "POST") {
      const target = identById(String(body.target_id || ""));
      if (!target) return err("找不到这个身份", 404);
      if (target.revoked) return err("这个身份已被吊销", 403);
      const rules = sanitizeRules(body.rules);
      sql.exec(`UPDATE identities SET rules=? WHERE id=?`, JSON.stringify(rules), target.id);
      return json({ id: target.id, name: target.name, rules });
    }
    if (url.pathname === "/registry/mark-replied" && request.method === "POST") {
      sql.exec(`UPDATE identities SET last_reply=? WHERE token=?`, Date.now(), String(body.token || ""));
      return json({ ok: true });
    }
    if (url.pathname === "/registry/touch" && request.method === "POST") {
      sql.exec(`UPDATE identities SET last_seen=? WHERE token=?`, Date.now(), String(body.token || ""));
      // 首次使用该 key：私信箱自动标记已分发并删除明文
      sql.exec(`DELETE FROM key_inbox WHERE token=?`, String(body.token || ""));
      return json({ ok: true });
    }
    // 吊销（内部执行：Worker 已核对房主直接操作或已批准的审批单）
    if (url.pathname === "/registry/revoke" && request.method === "POST") {
      const target = identById(String(body.target_id || ""));
      if (!target) return err("找不到这个身份", 404);
      if (target.role === "owner") return err("不能吊销房主", 403);
      sql.exec(`UPDATE identities SET revoked=1 WHERE id=?`, target.id);
      return json({ ok: true, id: target.id, name: target.name });
    }
    if (url.pathname === "/registry/mute" && request.method === "POST") {
      const target = identById(String(body.target_id || ""));
      if (!target) return err("找不到这个身份", 404);
      if (target.role === "owner") return err("不能禁言房主", 403);
      const minutes = Math.max(1, Math.min(1440, parseInt(body.minutes || "10", 10) || 10));
      sql.exec(`INSERT OR REPLACE INTO mutes(identity_id,until,reason,by_name) VALUES(?,?,?,?)`,
        target.id, Date.now() + minutes * 60000, String(body.reason || "").slice(0, 120), String(body.by_name || ""));
      return json({ ok: true, id: target.id, name: target.name, until: Date.now() + minutes * 60000 });
    }
    if (url.pathname === "/registry/unmute" && request.method === "POST") {
      sql.exec(`DELETE FROM mutes WHERE identity_id=?`, String(body.target_id || ""));
      return json({ ok: true });
    }
    // 发起审批（Moderator；房主不需要审批）
    if (url.pathname === "/registry/request-action" && request.method === "POST") {
      const req = identByToken(String(body.requester_token || ""));
      if (!req || req.revoked || req.role !== "moderator") return err("只有 Moderator 能发起审批", 403);
      if (!ACTIONS.includes(body.action)) return err("不支持的操作", 400);
      const id = newId("ap_");
      const minutes = Math.max(1, Math.min(1440, parseInt(body.minutes || "10", 10) || 10));
      sql.exec(`INSERT INTO approvals(id,requester_id,requester_name,action,target_id,target_name,reason,evidence_msg_id,minutes,status,created,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, req.id, req.name, body.action, String(body.target_id || ""), String(body.target_name || "").slice(0, 30),
        String(body.reason || "").slice(0, 200), String(body.evidence_msg_id || ""), minutes, "pending", Date.now(), Date.now() + 24 * 3600 * 1000);
      return json({ id, status: "pending", expires_at: Date.now() + 24 * 3600 * 1000 });
    }
    if (url.pathname === "/registry/get-approval") {
      const row = sql.exec(`SELECT * FROM approvals WHERE id=?`, url.searchParams.get("id") || "").toArray()[0];
      if (!row) return err("找不到这张审批单", 404);
      return json(row);
    }
    if (url.pathname === "/registry/set-approval" && request.method === "POST") {
      sql.exec(`UPDATE approvals SET status=?, approver_name=? WHERE id=?`,
        String(body.status || ""), String(body.approver_name || ""), String(body.id || ""));
      return json({ ok: true });
    }
    if (url.pathname === "/registry/list-approvals") {
      const rows = sql.exec(`SELECT * FROM approvals ORDER BY created DESC LIMIT 50`).toArray();
      return json({ approvals: rows });
    }
    if (url.pathname === "/registry/list-key-inbox") {
      const rows = sql.exec(`SELECT id,token,purpose,created_by,created,status FROM key_inbox ORDER BY created DESC LIMIT 50`).toArray();
      return json({ inbox: rows });
    }
    if (url.pathname === "/registry/distribute-key" && request.method === "POST") {
      sql.exec(`DELETE FROM key_inbox WHERE id=?`, String(body.id || ""));
      return json({ ok: true });
    }
    if (url.pathname === "/registry/list-identities") {
      const rows = sql.exec(`SELECT id,name,type,platform,role,bridge,rules,revoked,created,last_seen FROM identities ORDER BY created`).toArray();
      const mutes = sql.exec(`SELECT identity_id,until FROM mutes`).toArray();
      const muteMap = Object.fromEntries(mutes.map((m) => [m.identity_id, m.until]));
      return json({ identities: rows.map((r) => ({ ...r, rules: JSON.parse(r.rules || "{}"), revoked: !!r.revoked, muted_until: muteMap[r.id] || 0 })) });
    }
    // ---------- 微信绑定（DO 内：身份事实源） ----------
    // 绑定码：6 位大写字母数字，密码学随机，单次有效，24 小时过期。
    // 字母表去掉 0/1/I/O，避免用户照着抄时认错（仍是 6 位大写字母数字）。
    const BIND_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    function newBindCode() {
      const b = new Uint8Array(6);
      crypto.getRandomValues(b);
      return [...b].map((x) => BIND_CODE_ALPHABET[x % BIND_CODE_ALPHABET.length]).join("");
    }
    // 生成绑定码：房主专用；body 用 {token: 新 key 的 token} 或 {identity_id} 二选一。
    if (url.pathname === "/registry/wechat-bind-code" && request.method === "POST") {
      const req = identByToken(String(body.requester_token || ""));
      if (!req || req.revoked || req.role !== "owner") return err("只有房主能生成微信绑定码", 403);
      const target = body.token ? identByToken(String(body.token)) : identById(String(body.identity_id || ""));
      if (!target || target.revoked) return err("找不到这个身份，或 key 已被吊销", 404);
      // 一个 identity 同一时间只留一个有效码：旧的未用码作废。
      sql.exec(`DELETE FROM wechat_bind_codes WHERE identity_id=? AND used=0`, target.id);
      const code = newBindCode();
      const expiresAt = Date.now() + 24 * 3600 * 1000;
      sql.exec(`INSERT INTO wechat_bind_codes(code,identity_id,created,expires_at,used) VALUES(?,?,?,?,0)`,
        code, target.id, Date.now(), expiresAt);
      return json({ code, identity_id: target.id, identity_name: target.name, expires_at: expiresAt });
    }
    // 微信绑定：桥接身份调用；校验码（存在、未使用、未过期）→ 写映射 → 标记已用。
    if (url.pathname === "/registry/wechat-bind" && request.method === "POST") {
      const code = String(body.code || "").toUpperCase().trim();
      const row = sql.exec(`SELECT * FROM wechat_bind_codes WHERE code=?`, code).toArray()[0];
      if (!row) return err("绑定码不存在", 404);
      if (row.used) return err("绑定码已使用或已作废", 400);
      if (row.expires_at < Date.now()) return err("绑定码已过期", 400);
      const target = identById(row.identity_id);
      if (!target || target.revoked) return err("这个 key 已被吊销", 403);
      const wechatId = String(body.wechat_id || "").trim();
      if (!wechatId) return err("缺少 wechat_id", 400);
      // 一个 wechat_id 同一时间只绑一个 identity；重复绑定新 key 时替换旧映射。
      sql.exec(`INSERT OR REPLACE INTO wechat_bindings(wechat_id,identity_id,wechat_name,bound_at) VALUES(?,?,?,?)`,
        wechatId, target.id, String(body.wechat_name || wechatId).slice(0, 60), Date.now());
      sql.exec(`UPDATE wechat_bind_codes SET used=1 WHERE code=?`, code);
      return json({ identity: { id: target.id, name: target.name, type: target.type } });
    }
    // 微信绑定（扫码即绑）：桥接身份用自己的 Token，把登录确认拿到的
    // wechat_id 直接绑到自己身上，不走 6 位绑定码。只能绑自己
    //（identity_id 须等于调用方 id），且调用方须是 bridge=wechat 的身份。
    if (url.pathname === "/registry/wechat-bind-self" && request.method === "POST") {
      const req = identByToken(String(body.requester_token || ""));
      if (!req || req.revoked || req.bridge !== "wechat") return err("需要微信桥接身份", 403);
      const target = identById(String(body.identity_id || ""));
      if (!target || target.id !== req.id || target.revoked) return err("只能绑定自己的身份", 403);
      const wechatId = String(body.wechat_id || "").trim();
      if (!wechatId) return err("缺少 wechat_id", 400);
      sql.exec(`INSERT OR REPLACE INTO wechat_bindings(wechat_id,identity_id,wechat_name,bound_at) VALUES(?,?,?,?)`,
        wechatId, target.id, String(body.wechat_name || wechatId).slice(0, 60), Date.now());
      return json({ identity: { id: target.id, name: target.name, type: target.type } });
    }
    // 按 wechat_id 解析绑定身份（bridge-message 用；身份被吊销返回 null）。
    if (url.pathname === "/registry/wechat-resolve") {
      const wechatId = url.searchParams.get("wechat_id") || "";
      const b = sql.exec(`SELECT identity_id FROM wechat_bindings WHERE wechat_id=?`, wechatId).toArray()[0];
      if (!b) return json({ identity: null });
      const target = identById(b.identity_id);
      if (!target || target.revoked) return json({ identity: null });
      return json({ identity: { id: target.id, name: target.name, type: target.type } });
    }
    if (url.pathname === "/registry/wechat-bindings") {
      const rows = sql.exec(`SELECT b.wechat_id, b.wechat_name, b.bound_at, i.id AS identity_id, i.name AS identity_name, i.type AS identity_type, i.platform AS identity_platform FROM wechat_bindings b LEFT JOIN identities i ON i.id=b.identity_id ORDER BY b.bound_at DESC`).toArray();
      return json({ bindings: rows });
    }
    // 解绑：删映射，key 本身不吊销；解绑后该微信用户退回访客身份。
    if (url.pathname === "/registry/wechat-unbind" && request.method === "POST") {
      sql.exec(`DELETE FROM wechat_bindings WHERE wechat_id=?`, String(body.wechat_id || ""));
      return json({ ok: true });
    }
    // ---------- 微信桥状态（并进聊天室服务后住在这里；旧独立 Worker 的
    // WeChatBridge DO 同 ops，原样搬过来，供 Worker 的拉取周期调用）----------
    if (url.pathname === "/registry/wechat-do" && request.method === "POST") {
      const op = String(body.op || "");
      const kvGet = (key) => {
        const row = sql.exec(`SELECT value FROM wechat_kv WHERE key=?`, key).toArray()[0];
        return row ? row.value : null;
      };
      const kvSet = (key, value) => {
        sql.exec(`INSERT OR REPLACE INTO wechat_kv(key,value) VALUES(?,?)`, key, value);
      };
      const jsonGet = (key, fallback) => {
        try { const v = kvGet(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
      };
      if (op === "get-state") {
        return json({
          buf: kvGet("buf") || "",
          session_expired_until: parseInt(kvGet("session_expired_until") || "0", 10) || 0,
          last_poll_at: parseInt(kvGet("last_poll_at") || "0", 10) || 0,
          last_from: kvGet("last_from") || null,
          seen: jsonGet("seen", {}),
          greeted: jsonGet("greeted", []),
          bridges: jsonGet("bridges", {}),
        });
      }
      if (op === "set-state") {
        const p = body.patch || {};
        if (body.bridge_id) {
          // 多桥：每桥的 buf/seen 只写进自己名下的记录，不动顶层共享字段
          //（多桥共写顶层会互相覆盖拉取游标）；顶层 last_poll_at 取各桥最大值。
          const bridges = jsonGet("bridges", {});
          const prev = bridges[String(body.bridge_id)] || {};
          bridges[String(body.bridge_id)] = { ...prev, ...p, updated_at: Date.now() };
          kvSet("bridges", JSON.stringify(bridges));
          if (p.last_poll_at !== undefined) {
            const cur = parseInt(kvGet("last_poll_at") || "0", 10) || 0;
            if (p.last_poll_at > cur) kvSet("last_poll_at", String(p.last_poll_at));
          }
          return json({ ok: true });
        }
        if (p.buf !== undefined) kvSet("buf", p.buf);
        if (p.session_expired_until !== undefined) kvSet("session_expired_until", String(p.session_expired_until));
        if (p.last_poll_at !== undefined) kvSet("last_poll_at", String(p.last_poll_at));
        if (p.last_from !== undefined) kvSet("last_from", p.last_from || "");
        if (p.seen !== undefined) kvSet("seen", JSON.stringify(p.seen));
        if (p.greeted !== undefined) kvSet("greeted", JSON.stringify(p.greeted));
        return json({ ok: true });
      }
      if (op === "upsert-context") {
        sql.exec(`INSERT OR REPLACE INTO wechat_contexts(wechat_id,context_token,updated_at) VALUES(?,?,?)`,
          String(body.wechat_id || ""), String(body.context_token || ""), Date.now());
        return json({ ok: true });
      }
      if (op === "get-context") {
        const row = sql.exec(`SELECT context_token FROM wechat_contexts WHERE wechat_id=?`, String(body.wechat_id || "")).toArray()[0];
        return json({ context_token: row ? row.context_token : null });
      }
      if (op === "add-command") {
        const id = newId("cmd_");
        sql.exec(`INSERT INTO wechat_commands(id,wechat_id,text,status,created_at) VALUES(?,?,?,?,?)`,
          id, String(body.wechat_id || ""), String(body.text || "").slice(0, 2000), "pending", Date.now());
        return json({ id });
      }
      if (op === "list-commands") {
        const status = String(body.status || "pending");
        const rows = status === "all"
          ? sql.exec(`SELECT * FROM wechat_commands ORDER BY created_at DESC LIMIT 100`).toArray()
          : sql.exec(`SELECT * FROM wechat_commands WHERE status=? ORDER BY created_at DESC LIMIT 100`, status).toArray();
        return json({ commands: rows });
      }
      if (op === "get-command") {
        const row = sql.exec(`SELECT * FROM wechat_commands WHERE id=?`, String(body.id || "")).toArray()[0];
        return json({ command: row || null });
      }
      if (op === "mark-replied") {
        sql.exec(`UPDATE wechat_commands SET status='replied', replied_at=? WHERE id=?`, Date.now(), String(body.id || ""));
        return json({ ok: true });
      }
      return err("unknown op: " + op, 400);
    }
    if (url.pathname === "/registry/list-agents") {
      const rows = sql.exec(`SELECT id,name,type,platform,last_seen FROM identities WHERE type IN ('agent','bot') AND revoked=0 ORDER BY last_seen DESC`).toArray();
      return json({ agents: rows });
    }
    // v2.6 在线：房间 DO 调这个拿最近活跃的身份（房间 DO 自己的 identities 表是空的，
    // 身份只存在注册表 DO 里）。since=毫秒时间戳，只返回 last_seen 大于它的、未吊销的。
    if (url.pathname === "/registry/list-online") {
      const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
      const rows = sql.exec(`SELECT id,name,type,platform,bridge FROM identities WHERE last_seen > ? AND revoked=0`, since).toArray();
      return json({ online: rows });
    }
    if (url.pathname === "/registry/list-rooms") {
      const rows = sql.exec(`SELECT slug,name,topic FROM rooms ORDER BY rowid`).toArray();
      return json({ rooms: rows });
    }
    if (url.pathname === "/registry/create-room" && request.method === "POST") {
      const slug = String(body.slug || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
      const name = String(body.name || "").trim().slice(0, 30);
      if (!slug || !name) return err("房间 id 和名字都要填（id 只用小写字母数字横线）");
      sql.exec(`INSERT OR IGNORE INTO rooms(slug,name,topic,created) VALUES(?,?,?,?)`,
        slug, name, String(body.topic || "").slice(0, 120), Date.now());
      return json({ slug, name });
    }
    if (url.pathname === "/registry/stats") {
      const n = sql.exec(`SELECT COUNT(*) AS n FROM identities WHERE revoked=0`).toArray()[0].n;
      const m = sql.exec(`SELECT COUNT(*) AS n FROM messages`).toArray()[0].n;
      const p = sql.exec(`SELECT COUNT(*) AS n FROM approvals WHERE status='pending'`).toArray()[0].n;
      const k = sql.exec(`SELECT COUNT(*) AS n FROM key_inbox WHERE status='pending'`).toArray()[0].n;
      return json({ identities: n, messages: m, pending_approvals: p, pending_keys: k });
    }
    if (url.pathname === "/registry/meta") {
      if (request.method === "GET") {
        const row = sql.exec(`SELECT value FROM meta WHERE key=?`, url.searchParams.get("key") || "").toArray()[0];
        return json({ value: row ? row.value : null });
      }
      sql.exec(`INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)`, String(body.key || ""), String(body.value ?? ""));
      return json({ ok: true });
    }
    return err("unknown registry path", 404);
  }

  // ---------- 内部：房间 ----------
  async roomFetch(request) {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    if (url.pathname === "/room/history") {
      const pruned = this.pruneOldMessages();
      const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
      const rows = sql.exec(`SELECT * FROM messages ORDER BY ts DESC LIMIT ?`, limit).toArray().reverse();
      const messages = rows.map((r) => ({ ...r, mentions: JSON.parse(r.mentions || "[]") }));
      return json({ messages, members: await this.presence(), pruned });
    }
    if (url.pathname === "/room/send" && request.method === "POST") {
      const sender = {
        id: request.headers.get("x-sender-id") || newId("u_"),
        name: request.headers.get("x-sender-name") || "匿名",
        type: request.headers.get("x-sender-type") || "human",
        platform: request.headers.get("x-sender-platform") || "web",
      };
      const body = await request.json().catch(() => ({}));
      const text = String(body.text || "").trim();
      if (!text) return err("消息不能为空");
      if (text.length > 2000) return err("消息太长，最多 2000 字");
      if (await this.isMuted(sender.id)) return err("你正在禁言中", 403);
      if (!this.checkRate(sender.id)) return err("发得太快了，10 秒内最多 5 条", 429);
      const msg = await this.storeMessage(sender, text, String(body.reply_to || "").slice(0, 40) || null);
      this.broadcast({ type: "message", message: msg, members: await this.presence() });
      return json({ message: msg });
    }
    if (url.pathname === "/room/system" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const msg = await this.storeMessage(
        { id: "u_system", name: "系统", type: "bot", platform: "web" },
        String(body.text || "").slice(0, 500), null);
      this.broadcast({ type: "message", message: msg, members: await this.presence() });
      return json({ message: msg });
    }
    if (url.pathname === "/room/delete" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const senderId = request.headers.get("x-sender-id") || "";
      const isAdmin = request.headers.get("x-admin") === "1";
      const row = sql.exec(`SELECT sender_id FROM messages WHERE id=?`, String(body.id || "")).toArray()[0];
      if (!row) return err("消息不存在", 404);
      if (!isAdmin && row.sender_id !== senderId) return err("只能撤回自己的消息", 403);
      sql.exec(`DELETE FROM messages WHERE id=?`, String(body.id));
      this.broadcast({ type: "delete", id: String(body.id) });
      return json({ ok: true });
    }
    if (url.pathname === "/room/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return err("需要 WebSocket", 426);
      const sender = {
        id: request.headers.get("x-sender-id") || newId("u_"),
        name: request.headers.get("x-sender-name") || "匿名",
        type: request.headers.get("x-sender-type") || "human",
        platform: request.headers.get("x-sender-platform") || "web",
      };
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(sender);
      this.pruneOldMessages();
      const history = sql.exec(`SELECT * FROM messages ORDER BY ts DESC LIMIT 50`).toArray().reverse()
        .map((r) => ({ ...r, mentions: JSON.parse(r.mentions || "[]") }));
      server.send(JSON.stringify({ type: "history", messages: history, members: await this.presence(), you: sender }));
      this.presence().then((m) => this.broadcast({ type: "presence", members: m })).catch(() => {});
      return new Response(null, { status: 101, webSocket: client });
    }
    return err("unknown room path", 404);
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/registry/")) return this.registryFetch(request);
      if (url.pathname.startsWith("/room/")) return this.roomFetch(request);
      return err("unknown internal path", 404);
    } catch (e) {
      return err("内部错误：" + (e && e.message ? e.message : String(e)), 500);
    }
  }

  async webSocketMessage(ws, message) {
    try {
      const sender = ws.deserializeAttachment();
      const data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
      if (data.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
      if (data.type === "typing") {
        this.broadcast({ type: "typing", sender_name: sender.name, typing: !!data.typing });
        return;
      }
      if (data.type === "message") {
        const text = String(data.text || "").trim();
        if (!text || text.length > 2000) { ws.send(JSON.stringify({ type: "error", error: "消息为空或太长" })); return; }
        if (await this.isMuted(sender.id)) { ws.send(JSON.stringify({ type: "error", error: "你正在禁言中" })); return; }
        if (!this.checkRate(sender.id)) { ws.send(JSON.stringify({ type: "error", error: "发得太快了，10 秒内最多 5 条" })); return; }
        const msg = await this.storeMessage(sender, text, String(data.reply_to || "").slice(0, 40) || null);
        this.broadcast({ type: "message", message: msg, members: await this.presence() });
      }
    } catch { /* 坏消息直接丢掉 */ }
  }
  async webSocketClose() {
    this.presence().then((m) => this.broadcast({ type: "presence", members: m })).catch(() => {});
  }
  async webSocketError() {
    this.presence().then((m) => this.broadcast({ type: "presence", members: m })).catch(() => {});
  }
}

// ---------------- Worker ----------------
function registryStub(env) { return env.CHATROOM.get(env.CHATROOM.idFromName("__registry__")); }
function roomStub(env, slug) { return env.CHATROOM.get(env.CHATROOM.idFromName("room:" + slug)); }
async function regCall(env, path, body) {
  const r = await registryStub(env).fetch("https://do" + path, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, data: d };
}
async function roomExists(env, slug) {
  const { data } = await regCall(env, "/registry/list-rooms");
  return (data.rooms || []).some((x) => x.slug === slug);
}
async function authIdentity(env, request, touch = false) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;
  const r = await registryStub(env).fetch("https://do/registry/identity?token=" + encodeURIComponent(token));
  if (!r.ok) return null;
  const ident = await r.json();
  if (ident.revoked) return null;
  if (touch) regCall(env, "/registry/touch", { token }).catch(() => {});
  return { ...ident, token };
}
async function authQueryToken(env, url) {
  const token = url.searchParams.get("token") || "";
  if (!token) return null;
  const r = await registryStub(env).fetch("https://do/registry/identity?token=" + encodeURIComponent(token));
  if (!r.ok) return null;
  const ident = await r.json();
  if (ident.revoked) return null;
  return { ...ident, token };
}
function needRole(ident, roles) {
  if (!ident) return err("需要 Bearer token", 401);
  if (!roles.includes(ident.role)) return err("权限不足，需要 " + roles.join("/"), 403);
  return null;
}
async function systemMsg(env, room, text) {
  try {
    await roomStub(env, room).fetch("https://do/room/system", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
    });
  } catch { /* 忽略 */ }
}
// 执行一张已批准的审批单（房主点批准时调用）
async function executeApproval(env, ap, approverName) {
  const targetName = ap.target_name || ap.target_id;
  if (ap.action === "mute") {
    const { status, data } = await regCall(env, "/registry/mute", {
      target_id: ap.target_id, minutes: ap.minutes || 10, reason: ap.reason, by_name: ap.requester_name,
    });
    if (status !== 200) return { ok: false, error: data.error || "禁言失败" };
    await systemMsg(env, "general", `小管家申请禁言 ${targetName}（${ap.minutes || 10} 分钟），房主 ${approverName} 已批准并执行。`);
  } else if (ap.action === "kick" || ap.action === "revoke-key") {
    const { status, data } = await regCall(env, "/registry/revoke", { target_id: ap.target_id });
    if (status !== 200) return { ok: false, error: data.error || "执行失败" };
    await systemMsg(env, "general", `小管家申请${ap.action === "kick" ? "踢出" : "吊销 key"} ${targetName}，房主 ${approverName} 已批准并执行。`);
  } else if (ap.action === "delete") {
    // target_id 存的是消息 id；证据在哪个房需要查：先在 general 试，再试其他房
    const { data } = await regCall(env, "/registry/list-rooms");
    let done = false;
    for (const room of (data.rooms || [])) {
      const r = await roomStub(env, room.slug).fetch("https://do/room/delete", {
        method: "POST", headers: { "content-type": "application/json", "x-sender-id": "", "x-admin": "1" },
        body: JSON.stringify({ id: ap.target_id }),
      });
      if (r.ok) { done = true; break; }
    }
    if (!done) return { ok: false, error: "找不到那条消息，可能已被删除" };
    await systemMsg(env, "general", `小管家申请删除一条消息，房主 ${approverName} 已批准并执行。`);
  }
  await regCall(env, "/registry/set-approval", { id: ap.id, status: "executed", approver_name: approverName });
  return { ok: true };
}

const MOD_NAME = "Moderator";
const MOD_ID = "u_moderator";
const NEURON_BUDGET = 2000;
const NEURON_PER_REPLY = 15;

async function handleModeratorScan(env, report) {
  if (!env.AI) { report && report.push("no AI binding"); return; }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dateRow = await regCall(env, "/registry/meta?key=neurons_date");
    const usedRow = await regCall(env, "/registry/meta?key=neurons_used");
    let used = 0;
    if (dateRow.data.value !== today) {
      await regCall(env, "/registry/meta", { key: "neurons_date", value: today });
      await regCall(env, "/registry/meta", { key: "neurons_used", value: "0" });
    } else {
      used = parseInt(usedRow.data.value || "0", 10) || 0;
    }
    if (used >= NEURON_BUDGET) { report && report.push("neurons budget reached: " + used); return; }
    const { data } = await regCall(env, "/registry/list-rooms");
    for (const room of (data.rooms || [])) {
      const r = await roomStub(env, room.slug).fetch("https://do/room/history?limit=50");
      const h = await r.json().catch(() => ({ messages: [] }));
      const msgs = h.messages || [];
      const wmRow = await regCall(env, "/registry/meta?key=mod_wm_" + room.slug);
      const wm = parseInt(wmRow.data.value || "0", 10) || 0;
      const answered = new Set(msgs.filter((m) => m.sender_id === MOD_ID).map((m) => m.reply_to));
      const targets = msgs.filter((m) =>
        m.ts > wm && m.sender_id !== MOD_ID &&
        (m.mentions || []).some((x) => x === MOD_NAME || x === "小管家") &&
        !answered.has(m.id)).sort((a, b) => a.ts - b.ts).slice(0, 3);
      report && report.push(`room ${room.slug}: ${msgs.length} msgs, wm=${wm}, targets=${targets.length}, pruned=${h.pruned || 0}`);
      let maxTs = wm;
      for (const q of targets) {
        maxTs = Math.max(maxTs, q.ts);
        if (used >= NEURON_BUDGET) break;
        const context = msgs.slice(-10).map((m) => `${m.sender_name}：${m.text}`).join("\n");
        let reply = "";
        // 建 key 请求：走 Moderator 的 create-key，key 只进房主私信箱
        const keyMatch = q.text.match(/(?:为|給|给)\s*(\S+?)\s*(?:建|创建|申请)(?:个)?\s*key/i) || q.text.match(/(?:建|创建|申请)(?:个)?\s*key.*?给\s*(\S+)/i);
        if (keyMatch && env.MODERATOR_TOKEN) {
          const name = keyMatch[1].replace(/^@/, "").slice(0, 30);
          const { status } = await regCall(env, "/registry/create-key", {
            requester_token: env.MODERATOR_TOKEN, name, type: "agent", platform: "api",
            purpose: `@${q.sender_name} 请求建 key`,
          });
          reply = status === 200
            ? `@${q.sender_name} 已为 ${name} 建好 key，发到房主私信箱了，房主会私下发给对方。`
            : `@${q.sender_name} 建 key 失败，原因我这边没权限或名字不对，已转给房主处理。`;
        } else if (keyMatch) {
          reply = `@${q.sender_name} 建 key 需要 Moderator 的 Token，我这边还没配好，已转给房主处理。`;
        } else {
          try {
            const ai = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
              messages: [
                { role: "system", content: "你是 ai-chatroom 聊天室的小管家 Moderator。用中文简短回答，只回答房间规则、加入方法（需要房主或 Moderator 发的 Token，一号一 key）、邀请码互换、回复规则设置这四类问题。不知道就说不知道并转给房主，不要编造。最多 150 字。" },
                { role: "user", content: `最近的聊天记录：\n${context}\n\n${q.sender_name} 问：${q.text}\n请回答。` },
              ],
            });
            reply = String((ai && ai.response) || "").trim().slice(0, 500) || `@${q.sender_name} 这个问题我答不上来，已转给房主。`;
            if (!reply.startsWith("@")) reply = `@${q.sender_name} ` + reply;
          } catch (e) {
            report && report.push(`AI error: ${e && e.message ? e.message : String(e)}`);
            // 模型出错也不跳过：按规划回一句转房主，并照常发出去
            reply = `@${q.sender_name} 这个问题我答不上来，已转给房主。`;
          }
        }
        await roomStub(env, room.slug).fetch("https://do/room/send", {
          method: "POST",
          headers: { "content-type": "application/json", "x-sender-id": MOD_ID, "x-sender-name": MOD_NAME, "x-sender-type": "bot", "x-sender-platform": "web" },
          body: JSON.stringify({ text: reply, reply_to: q.id }),
        });
        used += NEURON_PER_REPLY;
        await regCall(env, "/registry/meta", { key: "neurons_used", value: String(used) });
        report && report.push(`replied to ${q.id} in ${room.slug}`);
      }
      if (maxTs > wm) await regCall(env, "/registry/meta", { key: "mod_wm_" + room.slug, value: String(maxTs) });
    }
    // 小管家在线：Cron 在跑就把 Moderator 的 last_seen 刷一下，它会出现在在线名单里。
    if (env.MODERATOR_TOKEN) regCall(env, "/registry/touch", { token: env.MODERATOR_TOKEN }).catch(() => {});
  } catch (e) {
    report && report.push(`scan error: ${e && e.message ? e.message : String(e)}`);
  }
}

// ---------------- 微信桥（2026-11-09 并进聊天室服务；原独立 Worker
// ai-chatroom-wechat 的逻辑原样搬过来，DO 状态改走聊天室 DO 的
// /registry/wechat-do，聊天室调用仍走公开 API + BRIDGE_TOKEN）----------------

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

// 入站分流（2026-11-10 去前缀）：绑定码 / 聊天。luo 决定去掉「聊：」
// 前缀规则——微信发来的所有非绑定码消息都直接进房；「聊：」还在就剥掉
//（兼容旧习惯），没有也不再要求。命令队列自此不再收新消息。
const WECHAT_CHAT_PREFIXES = ["聊：", "聊:"];
const WECHAT_BIND_CODE_RE = /^([A-Za-z0-9]{6})$/;
const WECHAT_BIND_WORD_RE = /^绑定\s*([A-Za-z0-9]{6})$/;
export function classifyInbound(text) {
  const t = (text || "").trim();
  if (!t) return { kind: "empty" };
  const bw = t.match(WECHAT_BIND_WORD_RE);
  if (bw) return { kind: "bind", code: bw[1].toUpperCase() };
  const bare = t.match(WECHAT_BIND_CODE_RE);
  if (bare) return { kind: "bind", code: bare[1].toUpperCase() };
  for (const p of WECHAT_CHAT_PREFIXES) {
    if (t.startsWith(p)) {
      const body = t.slice(p.length).trim();
      return body ? { kind: "chat", text: body } : { kind: "empty" };
    }
  }
  return { kind: "chat", text: t };
}

// 回推路由：返回要发给哪些 wechat_id（纯函数）。
// boundByName: Map<identity 名字, wechat_id>；allBound: 全部已绑定 wechat_id；
// lastFrom: 最近一位未绑定发送者（供「微信访客」沿用旧行为）。
// byId: 可选，Map<消息 id, 消息>（本轮拉到的 50 条历史），用于解析 reply_to：
//   回复了某条 platform=wechat 的消息 → 推回给那条消息的发送者（已绑定身份按
//   名字找 wechat_id；「微信访客」推给 lastFrom）；目标不在本轮窗口内时不推，
//   只走原有 @ 规则（@ 仍是兜底）。
export function routePushTargets(msg, boundByName, allBound, lastFrom, byId) {
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
  if (msg.reply_to && byId) {
    const target = byId.get(msg.reply_to);
    if (target && target.platform === "wechat") {
      if (boundByName.has(target.sender_name)) {
        targets.add(boundByName.get(target.sender_name));
      } else if (target.sender_name === "微信访客" && lastFrom) {
        targets.add(lastFrom);
      }
    }
  }
  return [...targets];
}

export function formatPush(room, msg) {
  return `${msg.sender_name || "?"}：${(msg.text || "").slice(0, 1000)}`;
}

// 任意文本的 QR（SVG 字符串）。
export function makeQrSvgText(text) {
  const qr = qrcode(0, "M");
  qr.addData(String(text || ""));
  qr.make();
  return qr.createSvgTag(6, 24);
}

// 绑定码对应的加入页 QR（SVG 字符串）。
export function makeQrSvg(code) {
  return makeQrSvgText(JOIN_PAGE + "?code=" + code);
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

// ---------- 微信桥 sys：DO 状态走聊天室 DO，聊天室调用走公开 API ----------

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

async function wechatDoCall(env, op, payload) {
  const r = await registryStub(env).fetch("https://do/registry/wechat-do", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...(payload || {}) }),
  });
  return r.json();
}

// 容器桥管理代理：房主经 Worker 转发到 Uppcoder 容器上的管理 API。
// 容器地址与管理密钥走 Worker secrets；未配时返回 503，不直通容器。
async function containerFetch(env, path, init = {}) {
  const base = (env.CONTAINER_BRIDGE_URL || "").replace(/\/$/, "");
  const admin = env.CONTAINER_ADMIN_TOKEN || "";
  if (!base || !admin) return { status: 503, data: { error: "容器桥管理未配置（缺 CONTAINER_BRIDGE_URL / CONTAINER_ADMIN_TOKEN）" } };
  try {
    const r = await fetch(base + path, {
      ...init,
      headers: { "content-type": "application/json", Authorization: "Bearer " + admin, ...(init.headers || {}) },
    });
    const d = await r.json().catch(() => ({}));
    return { status: r.status, data: d };
  } catch (e) {
    return { status: 502, data: { error: "容器桥连不上：" + (e && e.message ? e.message : String(e)) } };
  }
}

function wechatSys(env) {
  return {
    doCall: (op, payload) => wechatDoCall(env, op, payload),
    ilinkGetUpdates: (buf) => ilinkGetUpdates(env.ILINK_BOT_TOKEN, buf),
    ilinkSendText: (to, text, ctx) =>
      ilinkSendText(env.ILINK_BOT_TOKEN, to, text, ctx),
    chatroomGet: (path) => chatroomCall(env, path),
    chatroomPost: (path, body) => chatroomCall(env, path, body),
  };
}

// ---------- 轮询一轮（Cron / 手动触发共用；sys 可注入 mock 做测试） ----------

export async function runPollCycle(env, sys, report = []) {
  sys = sys || wechatSys(env);
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
  let lastFrom = state.last_from || null;
  const counts = {
    received: 0,
    forwarded: 0,
    bound: 0,
    commands: 0, // 去前缀后不再收新命令；字段保留，恒为 0
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
          `绑定成功，你现在是「${r.identity.name}」，直接发消息就能进聊天室说话了。`,
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
      const r = await sys.chatroomPost(`/api/rooms/${WECHAT_ROOM}/bridge-message`, {
        platform: "wechat",
        sender_name: "微信访客",
        sender_type: "human",
        text: c.text,
        wechat_id: from,
      });
      if (r.message) counts.forwarded++;
      else report.push("bridge-message failed: " + (r.error || "unknown"));
    }
  }
  patch.last_from = lastFrom;

  // 回推：房里非 wechat 来源的新消息，按路由发回微信。
  const seen = state.seen || {};
  const seenGeneral = new Set(seen.general || []);
  const hist = await sys
    .chatroomGet(`/api/rooms/${WECHAT_ROOM}/messages?limit=50`)
    .catch(() => ({ messages: [] }));
  const msgs = hist.messages || [];
  const fresh = msgs
    .filter((m) => !seenGeneral.has(m.id) && m.platform !== "wechat")
    .sort((a, b) => a.ts - b.ts);
  const byId = new Map(msgs.map((m) => [m.id, m]));
  let pumped = 0,
    skippedNoCtx = 0;
  for (const m of fresh) {
    for (const wid of routePushTargets(
      m,
      boundByName,
      allBound,
      lastFrom,
      byId,
    )) {
      const ctx = await sys.doCall("get-context", { wechat_id: wid });
      if (!ctx || !ctx.context_token) {
        skippedNoCtx++;
        continue;
      }
      const r = await sys.ilinkSendText(
        wid,
        formatPush(WECHAT_ROOM, m),
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

// POST /api/bridge/reply 的核心逻辑（抽出来以便单元测试；fetch 层只做鉴权与参数解析）。
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

function needBridgeToken(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return !!env.BRIDGE_TOKEN && token === env.BRIDGE_TOKEN;
}

async function runWechatPollCycle(env, report = []) {
  return runPollCycle(env, wechatSys(env), report);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: {
        "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "access-control-allow-headers": "Authorization,Content-Type" } });
    }
    const bodyJson = async () => request.json().catch(() => ({}));
    try {
      if (url.pathname === "/api/health") return json({ ok: true, service: "ai-chatroom", version: "2.6", free_tier: "workers + durable-objects sqlite + workers-ai" });
      if (url.pathname === "/api/rooms" && request.method === "GET") {
        const { data } = await regCall(env, "/registry/list-rooms");
        return json(data);
      }
      if (url.pathname === "/api/agents" && request.method === "GET") {
        const { data } = await regCall(env, "/registry/list-agents");
        return json(data);
      }
      // ---- 引导：建房主（仅 identities 为空时有效）----
      if (url.pathname === "/api/admin/bootstrap" && request.method === "POST") {
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/bootstrap", body);
        return json(data, status);
      }
      // ---- 管理 ----
      if (url.pathname === "/api/admin/create-key" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner", "moderator"]);
        if (e) return e;
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/create-key", { ...body, requester_token: me.token });
        return json(data, status);
      }
      if (url.pathname === "/api/admin/key-inbox" && request.method === "GET") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const { data } = await regCall(env, "/registry/list-key-inbox");
        return json(data);
      }
      if (url.pathname === "/api/admin/distribute-key" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/distribute-key", body);
        return json(data, status);
      }
      if (url.pathname === "/api/admin/approvals" && request.method === "GET") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner", "moderator"]);
        if (e) return e;
        const { data } = await regCall(env, "/registry/list-approvals");
        return json(data);
      }
      if (url.pathname === "/api/admin/request-action" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["moderator"]);
        if (e) return e;
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/request-action", { ...body, requester_token: me.token });
        if (status === 200) await systemMsg(env, "general", `小管家申请${{ mute: "禁言", kick: "踢出", delete: "删除消息", "revoke-key": "吊销 key" }[body.action] || "操作"} ${body.target_name || ""}，理由：${(body.reason || "").slice(0, 100)}。等房主批准。`);
        return json(data, status);
      }
      if (url.pathname === "/api/admin/approve" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        const { data } = await regCall(env, "/registry/get-approval?id=" + encodeURIComponent(body.approval_id || ""));
        if (!data || !data.id) return err("找不到这张审批单", 404);
        if (data.status !== "pending") return err("这张单子已经处理过了（" + data.status + "）", 400);
        if (data.expires_at < Date.now()) {
          await regCall(env, "/registry/set-approval", { id: data.id, status: "expired", approver_name: me.name });
          return err("审批单已过期（24 小时）", 400);
        }
        const res = await executeApproval(env, data, me.name);
        if (!res.ok) return err(res.error, 400);
        return json({ ok: true, action: data.action });
      }
      if (url.pathname === "/api/admin/reject" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        await regCall(env, "/registry/set-approval", { id: body.approval_id, status: "rejected", approver_name: me.name });
        return json({ ok: true });
      }
      if (url.pathname === "/api/admin/revoke-key" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/revoke", body);
        if (status === 200) await systemMsg(env, "general", `房主吊销了 ${data.name} 的 key。`);
        return json(data, status);
      }
      if (url.pathname === "/api/admin/mute" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/mute", { ...body, by_name: me.name });
        return json(data, status);
      }
      if (url.pathname === "/api/admin/unmute" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/unmute", body);
        return json(data, status);
      }
      if (url.pathname === "/api/admin/kick" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/revoke", body);
        if (status === 200) await systemMsg(env, "general", `房主踢出了 ${data.name}（key 已吊销）。`);
        return json(data, status);
      }
      if (url.pathname === "/api/admin/delete-message" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        if (!(await roomExists(env, body.room))) return err("房间不存在", 404);
        const r = await roomStub(env, body.room).fetch("https://do/room/delete", {
          method: "POST", headers: { "content-type": "application/json", "x-sender-id": "", "x-admin": "1" },
          body: JSON.stringify({ id: body.message_id }),
        });
        return json(await r.json(), r.status);
      }
      if (url.pathname === "/api/admin/identities" && request.method === "GET") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner", "moderator"]);
        if (e) return e;
        const { data } = await regCall(env, "/registry/list-identities");
        return json(data);
      }
      // 房主代设某成员的回复规则（PUT /api/admin/identities/:id/rules，仅房主）
      const ruleMatch = url.pathname.match(/^\/api\/admin\/identities\/([^/]+)\/rules$/);
      if (ruleMatch && request.method === "PUT") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/set-rules-by-id", { target_id: decodeURIComponent(ruleMatch[1]), rules: body.rules ?? body });
        return json(data, status);
      }
      if (url.pathname === "/api/admin/stats" && request.method === "GET") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const { data } = await regCall(env, "/registry/stats");
        return json(data);
      }
      // 手动触发小管家扫描（房主调试用；Cron 每 2 分钟自动跑）
      if (url.pathname === "/api/admin/moderator-scan" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        // 调试用：reset_watermark=true 时把扫描水位清零，重新处理历史 @
        if (body.reset_watermark) {
          const { data } = await regCall(env, "/registry/list-rooms");
          for (const room of (data.rooms || [])) {
            await regCall(env, "/registry/meta", { key: "mod_wm_" + room.slug, value: "0" });
          }
        }
        const report = [];
        await handleModeratorScan(env, report);
        return json({ report });
      }
      // ---- 微信绑定 ----
      if (url.pathname === "/api/admin/wechat-bind-code" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/wechat-bind-code", { ...body, requester_token: me.token });
        if (status !== 200) return json(data, status);
        const joinUrl = `https://ai-chatroom.pages.dev/wechat-join?code=${data.code}`;
        return json({ ...data, join_url: joinUrl, qr_url: WECHAT_BRIDGE_URL ? `${WECHAT_BRIDGE_URL}/qr?code=${data.code}` : null });
      }
      if (url.pathname === "/api/bridge/bind-wechat" && request.method === "POST") {
        const me = await authIdentity(env, request);
        if (!me || me.bridge !== "wechat") return err("需要微信桥接身份的 Token", 401);
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/wechat-bind", body);
        return json(data, status);
      }
      // 扫码即绑：桥登录确认后，用自己的 Token 把登录拿到的 wechat_id
      // 直接绑到自己身上（不走 6 位绑定码）。
      if (url.pathname === "/api/bridge/bind-self" && request.method === "POST") {
        const me = await authIdentity(env, request);
        if (!me || me.bridge !== "wechat") return err("需要微信桥接身份的 Token", 401);
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/wechat-bind-self", {
          ...body, identity_id: me.id, requester_token: me.token,
        });
        return json(data, status);
      }
      if (url.pathname === "/api/bridge/wechat-bindings" && request.method === "GET") {
        const me = await authIdentity(env, request);
        if (!me) return err("需要 Bearer token", 401);
        // 房主看管理面板；微信桥看列表做回推路由（列表里没有密钥，只有名字与微信 id）。
        if (me.role !== "owner" && me.bridge !== "wechat") return err("只有房主或微信桥能看绑定列表", 403);
        const { data } = await regCall(env, "/registry/wechat-bindings");
        return json(data);
      }
      const unbindMatch = url.pathname.match(/^\/api\/bridge\/wechat-binding\/(.+)$/);
      if (unbindMatch && request.method === "DELETE") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const { status, data } = await regCall(env, "/registry/wechat-unbind", { wechat_id: decodeURIComponent(unbindMatch[1]) });
        return json(data, status);
      }
      // ---- 容器桥管理代理（房主专用；一座桥接一个微信号，上限 10）----
      if (url.pathname === "/api/admin/container-bridges" && request.method === "GET") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const { status, data } = await containerFetch(env, "/bridges");
        return json(data, status);
      }
      if (url.pathname === "/api/admin/container-bridges" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        const { status, data } = await containerFetch(env, "/bridges", { method: "POST", body: JSON.stringify(body) });
        return json(data, status);
      }
      const cbMatch = url.pathname.match(/^\/api\/admin\/container-bridges\/([^/]+)(?:\/(login-start|login-status|login-verify|restart))?$/);
      if (cbMatch) {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const bid = encodeURIComponent(cbMatch[1]);
        const action = cbMatch[2];
        if (!action && request.method === "GET") {
          const { status, data } = await containerFetch(env, `/bridges/${bid}`);
          return json(data, status);
        }
        if (!action && request.method === "DELETE") {
          const { status, data } = await containerFetch(env, `/bridges/${bid}`, { method: "DELETE" });
          return json(data, status);
        }
        if (action === "restart" && request.method === "POST") {
          const { status, data } = await containerFetch(env, `/bridges/${bid}/restart`, { method: "POST" });
          return json(data, status);
        }
        if (action === "login-start" && request.method === "POST") {
          const { status, data } = await containerFetch(env, `/bridges/${bid}/login-start`, { method: "POST" });
          if (status === 200 && data.qrcode_img_content) {
            return json({ ...data, qr_svg: makeQrSvgText(data.qrcode_img_content) });
          }
          return json(data, status);
        }
        if (action === "login-status" && request.method === "GET") {
          const { status, data } = await containerFetch(env, `/bridges/${bid}/login-status`);
          return json(data, status);
        }
        if (action === "login-verify" && request.method === "POST") {
          const body = await bodyJson();
          const { status, data } = await containerFetch(env, `/bridges/${bid}/login-verify`, { method: "POST", body: JSON.stringify(body) });
          return json(data, status);
        }
        return err("unknown api", 404);
      }
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        const me = await authIdentity(env, request);
        const e = needRole(me, ["owner"]);
        if (e) return e;
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/create-room", body);
        return json(data, status);
      }
      // ---- 我的身份 ----
      if (url.pathname === "/api/identities/me" && request.method === "GET") {
        const ident = await authIdentity(env, request);
        if (!ident) return err("需要 Bearer token", 401);
        return json({ id: ident.id, name: ident.name, type: ident.type, platform: ident.platform, role: ident.role, rules: ident.rules });
      }
      if (url.pathname === "/api/identities/me/rules" && request.method === "PUT") {
        const ident = await authIdentity(env, request);
        if (!ident) return err("需要 Bearer token", 401);
        const body = await bodyJson();
        const { status, data } = await regCall(env, "/registry/set-rules", { token: ident.token, rules: body });
        return json(data, status);
      }
      if (url.pathname === "/api/evaluate" && request.method === "POST") {
        const ident = await authIdentity(env, request);
        if (!ident) return err("需要 Bearer token", 401);
        const body = await bodyJson();
        const msg = {
          sender_id: String(body.sender_id || ""), sender_name: String(body.sender_name || ""),
          sender_type: String(body.sender_type || "human"), text: String(body.text || ""),
          mentions: Array.isArray(body.mentions) ? body.mentions : parseMentions(String(body.text || "")),
        };
        const decision = evaluateRules(ident.rules, msg, { id: ident.id, name: ident.name });
        return json({ ...decision, platform: body.platform || "", cooldown_seconds: (ident.rules || {}).cooldown_seconds ?? 30, you: ident.name });
      }
      // ---- 房间消息 / 桥接 / WS ----
      const m = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/(messages|ws|delete|bridge-message)$/);
      if (m) {
        const slug = m[1];
        if (!(await roomExists(env, slug))) return err("房间不存在", 404);
        const stub = roomStub(env, slug);
        if (m[2] === "messages" && request.method === "GET") {
          // v2.6：读历史也刷 last_seen——REST 轮询的 Agent/Bot 与桥接
          // 靠这一刷出现在在线名单里（5 分钟窗口）。
          const me = await authIdentity(env, request, true);
          if (!me) return err("需要 Bearer token", 401);
          const r = await stub.fetch("https://do/room/history?limit=" + encodeURIComponent(url.searchParams.get("limit") || "50"));
          return json(await r.json(), r.status);
        }
        if (m[2] === "messages" && request.method === "POST") {
          const me = await authIdentity(env, request, true);
          if (!me) return err("需要 Bearer token", 401);
          const bodyText = await request.text();
          const r = await stub.fetch("https://do/room/send", {
            method: "POST",
            headers: { "content-type": "application/json", "x-sender-id": me.id, "x-sender-name": me.name, "x-sender-type": me.type, "x-sender-platform": me.platform },
            body: bodyText,
          });
          return json(await r.json(), r.status);
        }
        if (m[2] === "delete" && request.method === "POST") {
          const me = await authIdentity(env, request);
          if (!me) return err("需要 Bearer token", 401);
          const bodyText = await request.text();
          const r = await stub.fetch("https://do/room/delete", {
            method: "POST",
            headers: { "content-type": "application/json", "x-sender-id": me.id },
            body: bodyText,
          });
          return json(await r.json(), r.status);
        }
        if (m[2] === "bridge-message" && request.method === "POST") {
          const me = await authIdentity(env, request);
          if (!me || !me.bridge) return err("需要桥接身份的 Token", 401);
          const body = await bodyJson();
          const platform = String(body.platform || "");
          if (platform !== me.bridge) return err("桥接身份与 platform 不符", 403);
          const senderName = String(body.sender_name || "").trim().slice(0, 30);
          const senderType = ["human", "agent", "bot"].includes(body.sender_type) ? body.sender_type : "human";
          if (!senderName || !String(body.text || "").trim()) return err("sender_name 和 text 都要填", 400);
          // 微信绑定：wechat_id 有绑定时以该身份发言（名字/类型/稳定 id 都用身份本身）。
          let senderId = "ext_" + platform + "_" + (await sha12(platform + ":" + senderName));
          let finalName = senderName, finalType = senderType;
          const wechatId = String(body.wechat_id || "").trim();
          if (platform === "wechat" && wechatId) {
            const { data } = await regCall(env, "/registry/wechat-resolve?wechat_id=" + encodeURIComponent(wechatId));
            if (data.identity) {
              senderId = data.identity.id;
              finalName = data.identity.name;
              finalType = data.identity.type;
            }
          }
          const r = await stub.fetch("https://do/room/send", {
            method: "POST",
            headers: { "content-type": "application/json", "x-sender-id": senderId, "x-sender-name": finalName, "x-sender-type": finalType, "x-sender-platform": platform },
            body: JSON.stringify({ text: body.text, reply_to: body.reply_to || null }),
          });
          return json(await r.json(), r.status);
        }
        if (m[2] === "ws") {
          const me = await authQueryToken(env, url);
          if (!me) return err("需要 Token 才能加入（?token=…）", 401);
          regCall(env, "/registry/touch", { token: me.token }).catch(() => {});
          const r = await stub.fetch("https://do/room/ws", {
            headers: {
              Upgrade: "websocket",
              "x-sender-id": me.id, "x-sender-name": me.name, "x-sender-type": me.type, "x-sender-platform": me.platform,
            },
          });
          return r;
        }
      }
      // ---- 微信桥（并进聊天室服务；旧独立 Worker 的端点原样搬过来）----
      if (url.pathname === "/qr" && request.method === "GET") {
        const code = (url.searchParams.get("code") || "").toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) return err("code 必须是 6 位大写字母数字", 400);
        const svg = makeQrSvg(code);
        return new Response(svg, {
          headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/api/bridge/health" && request.method === "GET") {
        const state = await wechatDoCall(env, "get-state", {}).catch(() => ({}));
        const cmds = await wechatDoCall(env, "list-commands", { status: "pending" }).catch(() => ({ commands: [] }));
        const now = Date.now();
        const bridgeList = Object.entries(state.bridges || {}).map(([id, b]) => ({
          id,
          last_poll_at: b.last_poll_at || 0,
          session_expired: !!(b.session_expired_until && now < b.session_expired_until),
          session_expired_until: b.session_expired_until || 0,
        }));
        const maxPoll = bridgeList.reduce((m, b) => Math.max(m, b.last_poll_at), state.last_poll_at || 0);
        return json({
          ok: true, service: "ai-chatroom", version: "2.6",
          session_expired: !!(state.session_expired_until && now < state.session_expired_until) || bridgeList.some((b) => b.session_expired),
          session_expired_until: state.session_expired_until || 0,
          last_poll_at: maxPoll,
          pending_commands: (cmds.commands || []).length,
          bridges: bridgeList,
        });
      }
      if (url.pathname === "/api/bridge/commands" && request.method === "GET") {
        if (!needBridgeToken(request, env)) return err("需要 BRIDGE_TOKEN", 401);
        const d = await wechatDoCall(env, "list-commands", { status: url.searchParams.get("status") || "pending" });
        return json(d);
      }
      if (url.pathname === "/api/bridge/reply" && request.method === "POST") {
        if (!needBridgeToken(request, env)) return err("需要 BRIDGE_TOKEN", 401);
        const body = await bodyJson();
        const { status, data } = await handleReply(wechatSys(env), body);
        return json(data, status);
      }
      // 手动跑一轮拉取 + 回推（等价于旧桥的 /admin/test-cron；桥 Token 鉴权）
      if (url.pathname === "/api/bridge/test-cron" && request.method === "POST") {
        if (!needBridgeToken(request, env)) return err("需要 BRIDGE_TOKEN", 401);
        const report = [];
        const result = await runWechatPollCycle(env, report);
        return json({ result });
      }
      // 迁移专用：从旧桥 Worker 导出状态后一次性写入（patch + contexts）。
      // 只认 BRIDGE_TOKEN；用完即走，不常驻调用。
      if (url.pathname === "/api/bridge/seed-state" && request.method === "POST") {
        if (!needBridgeToken(request, env)) return err("需要 BRIDGE_TOKEN", 401);
        const body = await bodyJson();
        if (body.patch) await wechatDoCall(env, "set-state", { patch: body.patch, bridge_id: body.bridge_id });
        let n = 0;
        for (const c of (body.contexts || [])) {
          if (c.wechat_id && c.context_token) {
            await wechatDoCall(env, "upsert-context", { wechat_id: c.wechat_id, context_token: c.context_token });
            n++;
          }
        }
        return json({ ok: true, contexts: n });
      }
      if (url.pathname.startsWith("/api/")) return err("unknown api", 404);
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("ai-chatroom", { headers: { "content-type": "text/plain" } });
    } catch (e) {
      return err("Worker 错误：" + (e && e.message ? e.message : String(e)), 500);
    }
  },

  async scheduled(controller, env, ctx) {
    // 两条 Cron 共用一个 Worker：*/2 是小管家，* * * * * 是微信桥拉取。
    // Pages 没有 Cron，这段只在 Worker 里跑。
    if (controller.cron === "* * * * *") {
      ctx.waitUntil((async () => {
        const report = [];
        const result = await runWechatPollCycle(env, report);
        console.log(JSON.stringify({ cron: "wechat-poll", ...result }));
      })());
    } else {
      ctx.waitUntil(handleModeratorScan(env));
    }
  },
};
