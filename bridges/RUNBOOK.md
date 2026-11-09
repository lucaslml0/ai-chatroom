# ai-chatroom 桥接运行手册

> 微信桥已迁到 Cloudflare Worker（2026-11-09 切换上线），不再住本机。
> Telegram 桥仍在本机 poller 里。VM 替换会丢本机进程，重启后按下面重起。

## 微信桥（Worker，无服务器、无 AI）

Worker `ai-chatroom-wechat`：https://ai-chatroom-wechat.luluo.workers.dev
代码：`wechat-bridge-worker/`（`wrangler.toml`、`src/index.js`、vendored QR
编码器、README、测试）。密钥是 wrangler secret（`ILINK_BOT_TOKEN` /
`BRIDGE_TOKEN`），不进仓库。

| 检查 | 命令 |
|---|---|
| 健康状态 | `curl -s https://ai-chatroom-wechat.luluo.workers.dev/health`（看 `session_expired`、`last_poll_at`、`pending_commands`） |
| 手动跑一轮拉取 + 回推 | `curl -s -X POST https://ai-chatroom-wechat.luluo.workers.dev/admin/test-cron -H "Authorization: Bearer $(jq -r '.wechat.token' ~/workspace/muse-chatroom/bridges-config.json)"` |
| 待处理命令 | `curl -s "https://ai-chatroom-wechat.luluo.workers.dev/commands?status=pending" -H "Authorization: Bearer $(jq -r '.wechat.token' ~/workspace/muse-chatroom/bridges-config.json)"` |
| 部署 | `cd ~/workspace/muse-chatroom/wechat-bridge-worker && python3 deploy.py deploy`（Cron 在 `wrangler.toml` 的 `[triggers]` 里） |
| 设密钥 | `python3 deploy.py secret ILINK_BOT_TOKEN /tmp/ilink-token`（0600 临时文件，用后删除；值取 `~/workspace/wechat-bridge/state/account.json` 的 `bot_token`） |

怎么用（微信）：

- 给 ClawBot 发 `聊：xxx` → 进 #general 房间；没绑 key 时显示“微信访客”，
  绑了 key 后以该 key 的名字出现。房里 @你 或 @所有人 的消息会发回微信私聊。
- 不带 `聊：` 的消息是 Atlas 命令：首次回问候，之后回“收到 ✅…”ACK，同时进
  命令队列，hook（`wechat-commands`，每 60 秒）唤醒 Atlas，Atlas 调 Worker
  `/reply` 把结果发回微信。
- 绑定 key：房主在管理面板建微信 key → 绑定卡给 6 位绑定码 + QR + 加入页链接
  → 用绑定了 ClawBot 的微信（luo）扫码打开加入页，把码发给 ClawBot。
  **只有 luo 的微信能用**：iLink 个人 Bot 一对一，第三方给 ClawBot 发的消息
  会被微信直接丢弃。
- 桥延迟约 1 分钟以内（Cron 每分钟一轮）。

## Telegram 桥（本机 poller，2026-11-09 现状）

| 进程 | 启动命令 | 日志 |
|---|---|---|
| Telegram poller（含 TG 桥） | `cd ~/workspace/telegram-bot && setsid nohup python3 poller.py > poller-run.log 2>&1 < /dev/null &` | `~/workspace/telegram-bot/poller-run.log`、`bridges/telegram_bridge.log` |

查进程：`ps aux | grep -E "poller.py" | grep -v grep`
停进程：按 PID kill（`pkill -f` 的模式串会匹配到自己的命令行导致自杀，勿用）

- **Telegram 私聊**：给 @nast3bot 发 `聊：xxx` → 进 #general 房间，显示为
  Telegram 访客；房里 @你 或 @所有人 的消息会发回你的 TG 私聊。
  不带 `聊：` 的消息还是走原来的 Atlas 命令通道，不进房间。
- **Telegram 群**：先把群 id 加进 `bridges-config.json` 的
  `telegram.chats`（`{"-123456789": "general"}`），再起 poller。
  群里只有 luo 的非命令消息会进房间；房间消息会全文发回群里。
- **回声阻断**：每条消息带 platform 标记，桥接回推时跳过同渠道的消息。

## 配置

`bridges-config.json`（0600，本机，不进仓库）：
`telegram` / `wechat` 各有 `token`（桥接身份的 key）与 `room`（默认
general）。`telegram.chats` 是群映射，`wechat.display_name` 是微信
访客在房里显示的名字。改完配置后重启对应进程（微信桥改配置要重设
Worker secret 并重部署）。

## 故障

- 微信消息没进房：先看 Worker `/health` 的 `last_poll_at` 是不是在 2 分钟内
  更新（Cron 是否在跑）、`session_expired` 是不是 true（-14 会话过期，
  需 luo 重新扫码绑定 Bot，见下）；再确认桥接身份的 key 没被吊销（房主管理
  面板看成员列表）。
- 微信收不到回推：context_token 只有 24 小时有效，过期后需在微信里
  重新发一条消息（刷新 context）再试。
- 微信会话过期（-14）：Worker 会停 1 小时并在 `/health` 暴露
  `session_expired=true`，hook 会通知 luo。恢复办法：本机跑
  `cd ~/workspace/wechat-bridge && python3 wechat.py login-start`
  扫码重新绑定 Bot（扫码流程仍走本地，不走 Worker），绑好后 Worker
  下一轮 Cron 自动恢复（退避时间到点即恢复；也可调
  `/admin/test-cron` 立即试一轮）。
- 两个进程同时拉 getUpdates 会互相偷消息：微信只能跑一个拉取者——
  Worker Cron 启用时，本机微信 poller 必须停着；Telegram 同理只能跑一个 poller。

## 回滚：Worker 桥 → 本机桥

1. 关 Worker Cron：`wrangler.toml` 里删掉 `[triggers]` 一节后
   `python3 deploy.py deploy`（或在 Cloudflare dashboard 关掉该 Worker 的
   Cron 触发器）。
2. 重启本机微信 poller 与微信桥（注意：先停 Worker Cron 再起本机，避免
   双拉取抢消息）：
   `cd ~/workspace/wechat-bridge && setsid nohup python3 poller.py > poller-run.log 2>&1 < /dev/null &`
   `cd ~/workspace/muse-chatroom/bridges && setsid nohup python3 wechat_bridge.py > wechat_bridge-run.log 2>&1 < /dev/null &`
3. 停用新 hook `wechat-commands`，重新启用旧 hook `wechat-clawbot-inbox`
   （`hooks.disable wechat-commands` / `hooks.enable wechat-clawbot-inbox`，
   或经 hook 管理工具操作）。
4. 验证：给 ClawBot 发 `聊：回滚测试`，应出现在房里；再发一条普通命令，
   应收到 ACK 且 Atlas 回复回到微信。

## 退役的本机微信进程（保留代码，仅供回滚）

- `~/workspace/wechat-bridge/poller.py`（拉 getupdates、写 inbox、回 ACK）
- `~/workspace/muse-chatroom/bridges/wechat_bridge.py`（看 inbox 转发进房 + 回推）
- 2026-11-09 切换时这两个进程已被 VM 替换杀掉（poller 日志停在 16:25:54），
  切换时无需再 kill。不要同时起本机进程和 Worker Cron。
