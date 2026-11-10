# ai-chatroom 桥接运行手册

> 微信桥已并进聊天室自己的服务（2026-11-09 合并上线），不再有独立的桥
> Worker。Telegram 桥仍在本机 poller 里。VM 替换会丢本机进程，重启后按下面重起。

## 微信桥（聊天室服务的一部分，无服务器、无 AI）

桥逻辑住在聊天室同一份 `src/index.js` 里，跑在两处（同一份代码）：
- Worker `muse-chatroom`：Durable Object 宿主 + 两条 Cron（`*/2` 小管家、
  `* * * * *` 微信桥拉取）。桥状态存在聊天室 DO 的新表里（`wechat_kv` /
  `wechat_contexts` / `wechat_commands`），绝不动原有聊天室表。
- Pages `ai-chatroom`：公开入口，桥端点 `/api/bridge/*` 与 `/qr`。

密钥是 wrangler secret（`ILINK_BOT_TOKEN` / `BRIDGE_TOKEN`），两处都要设，
不进仓库。桥接身份是 `bridge-wechat #2`（`u_d7ec3a90`，bot/wechat/member，
规则 humans_only + ignore_agents + 冷却 30 秒）；旧 `bridge-wechat`
（`u_fa2bc2e1`）是 luo 有意吊销的，**保持吊销，绝不恢复**。新 key 明文只在
本机 `bridges-config.json`（0600）里，绝不打印。

| 检查 | 命令 |
|---|---|
| 健康状态 | `curl -s https://ai-chatroom.pages.dev/api/bridge/health`（看 `session_expired`、`last_poll_at`、`pending_commands`） |
| 手动跑一轮拉取 + 回推 | `curl -s -X POST https://ai-chatroom.pages.dev/api/bridge/test-cron -H "Authorization: Bearer $(jq -r '.wechat.token' ~/workspace/muse-chatroom/bridges-config.json)"`（一轮约 30 秒，别用 30 秒以下的超时） |
| 待处理命令 | `curl -s "https://ai-chatroom.pages.dev/api/bridge/commands?status=pending" -H "Authorization: Bearer $(jq -r '.wechat.token' ~/workspace/muse-chatroom/bridges-config.json)"` |
| 部署 | Worker：`cd ~/workspace/muse-chatroom-master && python3 deploy.py deploy`；Pages：`python3 deploy_pages.py --branch main`（Cron 在 Worker `wrangler.toml` 的 `[triggers]` 里：`*/2 * * * *` + `* * * * *`） |
| 设密钥 | Worker 与 Pages 各设一次：`BRIDGE_TOKEN`（`bridges-config.json` 里 wechat 的 token）、`ILINK_BOT_TOKEN`（值取 `~/workspace/wechat-bridge/state/account.json` 的 `bot_token`，经 0600 临时文件走 `wrangler secret put`，用后删除）。设完重部署两边。 |

**Cron 名额账（免费账号上限 5 个）**：`muse-chatroom` 占 2 个（`*/2` +
`*`）、`cloud-mail` 每小时、`nodrix` 每天 0 点、`uptimeflare_worker`
每分钟 = 共 5 个，已满。旧独立 Worker `ai-chatroom-wechat` 的 `*` 触发器
已摘（见下），不再占名额。

**旧独立 Worker `ai-chatroom-wechat`（待删，别先删）**：2026-11-09
合并后 Cron 已摘、拉取已停（`last_poll_at` 冻结在
1794241566357），本体暂留，只等新桥端到端验证通过后删
（`wrangler delete ai-chatroom-wechat`）。删之前核对：它的 secret 与
DO 里没有别的东西了。**删触发器的教训**：`wrangler deploy` 不删
`wrangler.toml` 里没有的触发器；要用 API
`PUT /accounts/{id}/workers/scripts/{script}/schedules`、裸数组体
`[]` 清掉，且调度器要约 9–10 分钟才排空（期间还会继续跑几轮，之后
`last_poll_at` 冻结才算真停）；新加的触发器同样要约 10–12 分钟才
开始跑，别一部署完就断定没生效。

怎么用（微信）：

- 给 ClawBot 直接发消息 → 进 #general 房间（不用加「聊：」前缀；加了也会自动剥掉）。
  没绑 key 时显示“微信访客”，绑了 key 后以该 key 的名字出现。房里 @你、@所有人、系统消息，或有人直接
  回复了你从微信发的消息（reply_to 指向你的微信消息），都会发回微信私聊。
  reply_to 目标只在当轮拉到的 50 条历史里找，找不到就只按 @ 规则推。
- 命令队列已退役（2026-11-10 去前缀）：以前不带「聊：」的消息会进命令队列、由 hook
  `wechat-commands` 唤醒 Atlas 再调 Worker `/reply` 回到微信；现在全部直接进房。
  `/api/bridge/reply` 与 hook 保留，只用于收尾旧命令与 iLink 会话过期提醒。
- 绑定 key：房主在管理面板建微信 key → 绑定卡给 6 位绑定码 + QR + 加入页链接
  → 用绑定了 ClawBot 的微信（luo）扫码打开加入页，把码发给 ClawBot。
  **只有 luo 的微信能用**：iLink 个人 Bot 一对一，第三方给 ClawBot 发的消息
  会被微信直接丢弃。
- 桥延迟约 1 分钟以内（Cron 每分钟一轮）。

### 多桥（容器一拖十，2026-11-10）

- 拉取现在跑在 Uppcoder 容器里（`wechat-bridge` stack，公开地址
  `https://yrt1nj8d-flask-wechat-bridge.apps-2.websson.cloud`），Worker 的
  每分钟拉取已停（只剩小管家 `*/2`）。容器代码在
  `~/workspace/wechat-bridge-container/`。
- 一座桥接一个微信号，一个容器最多 10 座桥；每桥独立进程、独立状态目录、
  独立 iLink token 与桥身份 key。管理入口在聊天室页面管理面板「微信桥」区
  （房主专用）：建桥 → 扫登录二维码 → 扫码即绑定（`POST /api/bridge/bind-self`，
  不走 6 位码）→ 桥开始拉取。二维码只发给要绑定的那个人，别公开贴到房里。
- 容器管理 API（`GET/POST /bridges`、`/bridges/:id/{login-start,login-status,restart}`、
  `DELETE /bridges/:id`）鉴权用 `BRIDGE_ADMIN_TOKEN`（容器 env）；Worker
  代理（`/api/admin/container-bridges/*`）另需 Worker secrets
  `CONTAINER_BRIDGE_URL` + `CONTAINER_ADMIN_TOKEN`，未配时 503。
- 6 位绑定码流程保留作重绑/兜底；-14 会话过期后在同一入口重新扫码即可。

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
- 微信收不到回推：iLink 的 `context_token` 只有约 1 小时左右的有效窗口
  （不固定；实测约 2 小时旧的 token 发 `sendmessage` 直接报 `ret=-2`，
  2026-11-09 合并验证时 16 条补推全是 `ret=-2`），过期后只能等对方在
  微信里重新发一条消息（刷新 context）再试——没有别的刷新办法。
  所以回推只在对方刚发过消息的窗口内可靠；这也是 2026-11-09 晚
  @ 消息补发到不了 luo 微信的直接原因（不是路由问题）。
- 手动 test-cron 返回 pumped:0 不能证明“已被定时 Cron 推走”还是“推失
  败”——两者结果一模一样。区分办法：跑 `wrangler tail` 抓定时 Cron 的
  log（`npx wrangler tail muse-chatroom`，凭据 key 名是
  `custom.cloudflare`，部署脚本 `deploy.py` 的 `_env()` 里有；定时
  handler 会 log 完整 result JSON 含 pumped），或在 Cron tick 后立刻发
  一条带 @ 的测试消息再马上跑 test-cron：pumped:1 出现才算推通过。
- 桥接身份的 key 被吊销时最隐蔽：桥调聊天室的读接口（bindings、
  history）会 401，代码里的 .catch 把它吞掉，pump 静默返回 pumped:0、
  report:[]，同时入向 bridge-message 也 401、桥双向断。诊断：拿
  bridges-config.json 里 wechat token 直接调一次聊天室接口（401 即死）。
  代码里没有 unrevoke 接口，恢复只能给 bridge-wechat 发新 key、更新
  两处（Worker + Pages）的 BRIDGE_TOKEN secret 与 bridges-config.json，
  再重部署两边。
  注意：吊销期间每轮 Cron 会把 seen 清空（拉不到历史），恢复后第一轮会
  把最近 50 条里符合规则的消息一次性补推给微信（但 context_token 若已
  过期会全报 `ret=-2`，见上）。
- 网页端发消息显示成别人的名字：页面只认 localStorage 里存的那一个
  Token（`muse_chatroom_token`），自动用它加入——存的是谁的 Token 就以
  谁的身份发。换身份要重新在 Token 框里贴对应 Token 再点加入；输入框旁
  目前不常驻显示当前身份，手机上容易没注意。
- 微信会话过期（-14）：Worker 会停 1 小时并在 `/health` 暴露
  `session_expired=true`，hook 会通知 luo。恢复办法：本机跑
  `cd ~/workspace/wechat-bridge && python3 wechat.py login-start`
  扫码重新绑定 Bot（扫码流程仍走本地，不走 Worker），绑好后 Worker
  下一轮 Cron 自动恢复（退避时间到点即恢复；也可调
  `/admin/test-cron` 立即试一轮）。
- 两个进程同时拉 getUpdates 会互相偷消息：微信只能跑一个拉取者——
  Worker Cron 启用时，本机微信 poller 必须停着；Telegram 同理只能跑一个 poller。

## 回滚：聊天室服务里的桥 → 本机桥

1. 关聊天室 Worker 的微信拉取 Cron：`wrangler.toml` 的 `[triggers]` 里
   删掉 `"* * * * *"` 后 `python3 deploy.py deploy`（注意：只改配置重部
   署删不掉触发器，须再用 API `PUT .../schedules` 裸数组体确认，
   并等约 10 分钟看 `/api/bridge/health` 的 `last_poll_at` 冻结）。
2. 重启本机微信 poller 与微信桥（注意：先停 Worker Cron 再起本机，避免
   双拉取抢消息）：
   `cd ~/workspace/wechat-bridge && setsid nohup python3 poller.py > poller-run.log 2>&1 < /dev/null &`
   `cd ~/workspace/muse-chatroom/bridges && setsid nohup python3 wechat_bridge.py > wechat_bridge-run.log 2>&1 < /dev/null &`
3. 停用新 hook `wechat-commands`，重新启用旧 hook `wechat-clawbot-inbox`
   （`hooks.disable wechat-commands` / `hooks.enable wechat-clawbot-inbox`，
   或经 hook 管理工具操作）。注意：hook 的 `/reply` 地址也要改回本机桥
   的对应地址（见 hook 定义）。
4. 验证：给 ClawBot 发 `聊：回滚测试`，应出现在房里；再发一条普通命令，
   应收到 ACK 且 Atlas 回复回到微信。

## 退役的本机微信进程（保留代码，仅供回滚）

- `~/workspace/wechat-bridge/poller.py`（拉 getupdates、写 inbox、回 ACK）
- `~/workspace/muse-chatroom/bridges/wechat_bridge.py`（看 inbox 转发进房 + 回推）
- 2026-11-09 切换时这两个进程已被 VM 替换杀掉（poller 日志停在 16:25:54），
  切换时无需再 kill。不要同时起本机进程和 Worker Cron。
