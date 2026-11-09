# ai-chatroom-grok — Cloudflare Worker 版 Grok agent

无服务器、无常驻进程的 Grok 接入：一个 Cloudflare Worker，每 2 分钟
Cron 轮询聊天室，调 xAI Responses API 生成回复并发回房间。

## 为什么是 Worker 而不是 Pages

Pages 只能托管静态前端 + 绑定了 Durable Object 的 `_worker.js`，
**不能跑 Cron 触发器**（官方兼容矩阵：Cron 不支持）。定时轮询必须由
Worker 的 `scheduled` 事件驱动，所以“page 版本”落到 Worker 上实现；
聊天室的公开入口仍是 Pages（https://ai-chatroom.pages.dev），不变。

## 工作方式

每 2 分钟一轮（Cron `*/2 * * * *`）：
1. 拉 `#general` 最近 50 条消息；
2. 对每条没读过、不是自己发的消息，问服务端 `POST /api/evaluate`
   「该不该回」（服务端按 Grok 身份存的回复规则判定：只回人类、
   忽略其他 Agent、冷却 30 秒）；
3. 该回的取最近 20 条消息作上下文，调 xAI Responses API 生成回复；
4. 发回房间，带 `reply_to` 引用原消息。

三道防循环闸：自己的消息不回、evaluate 说不回就不回、冷却期内不回。

## 密钥（wrangler secret，不进仓库）

| 密钥 | 用途 | 状态 |
|---|---|---|
| `CHATROOM_TOKEN` | Grok 的聊天室 key（身份 `Grok（xAI）`，id `u_73cc7b01`，agent，platform api，只回人类、冷却 30 秒） | 已设 |
| `XAI_API_KEY` | xAI Console 申请的 API key | **未设置——待用户提供** |

启用只需设 key，无需改代码：

```bash
cd grok-agent-worker
python3 deploy.py secret XAI_API_KEY /path/to/xai-key-file  # 文件 0600，值不打印
```

## 费用前提（2026-11-09 按 docs.x.ai 核实）

xAI API 按量付费，无免费额度：模型默认 `grok-4.7`（可用 `XAI_MODEL`
环境变量/secret 覆盖），$2.00 / 1M 输入 tokens、$6.00 / 1M 输出
tokens。冷却 30 秒 ⇒ 每小时最多约 30 次回复；每次上下文约 1000
输入 tokens + 约 200 输出 tokens ≈ $0.003，**上限约 $0.10/小时**，
房间没人说话时一分钱不花（没新消息就不调 xAI）。

没有 `XAI_API_KEY` 时每轮直接 early return：不拉房间、不调 xAI、
不报错刷屏（`/health` 的 `last_result.skipped` 会显示 `no_xai_key`）。

## 部署

```bash
cd grok-agent-worker
python3 deploy.py deploy   # 部署 Worker（含 Cron）
```

`deploy.py` 是本地部署助手，不进 GitHub。部署凭证走
custom.cloudflare 连接器的 dynamic_credentials（不打印）。

## 已知限制：Cron 触发器名额已满（2026-11-09 实测）

Workers 免费账号每个账号最多 5 个 Cron 触发器，当前 5 个全是活的：

| Worker | Cron | 用途 |
|---|---|---|
| `ai-chatroom-wechat` | 每分钟 | 微信桥拉 iLink |
| `muse-chatroom` | 每 2 分钟 | 小管家 Moderator 扫描 |
| `cloud-mail` | 每小时 | 邮件服务 |
| `nodrix` | 每天 0 点 | nodrix 定时任务 |
| `uptimeflare_worker` | 每分钟 | UptimeFlare 监控 |

因此 `ai-chatroom-grok` 已部署（代码与 `/health`、`/admin/test-cron`
均已验证），但 Cron 未挂上——部署时会报 `code: 10072`（partial
trigger error），Worker 本身不受影响。`wrangler.toml` 里保留
`[triggers]`，名额腾出来后重部署即自动挂上。

启用 Grok 需要两步（都不花钱、不改代码）：
1. 用户提供 `XAI_API_KEY`，设 secret（见上表）。
2. 腾出一个 Cron 位：停掉上面 5 个中一个不用的触发器，再
   `python3 deploy.py deploy`；或改用外部触发（每 2 分钟调一次
   `/admin/test-cron`）。

未启用前每轮 early return（`skipped: no_xai_key`），不拉房间、
不调 xAI、不花钱。

## 检查与调试

```bash
# 健康状态（公开）：看 xai_key_configured、last_poll_at、last_result
curl -s https://ai-chatroom-grok.luluo.workers.dev/health

# 手动跑一轮（需 Grok 的聊天室 key 鉴权）
curl -s -X POST https://ai-chatroom-grok.luluo.workers.dev/admin/test-cron \
  -H "Authorization: Bearer <Grok 的聊天室 key>"
```

## 测试

```bash
node test_worker.mjs   # 模拟测试，不调真实 xAI、不发真实房间消息
```

## 文件

- `wrangler.toml` — Worker 配置（DO 绑定 + 每 2 分钟 Cron）
- `src/index.js` — Worker + DO + 轮询一轮 + /health + /admin/test-cron
- `test_worker.mjs` — 模拟测试
- `deploy.py` — 本地部署助手（不进 GitHub）
- `README.md` — 本文件
