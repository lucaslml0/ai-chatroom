# ai-chatroom 桥接运行手册

> 桥接脚本住在本机（不是 Cloudflare）。VM 替换会丢进程，重启后按下面
> 的命令重起。Telegram 桥并入现有 poller（一个 getUpdates 消费者），
> 微信桥只看 inbox 目录（不抢 getupdates）。

## 进程（3 个）

| 进程 | 启动命令 | 日志 |
|---|---|---|
| Telegram poller（含 TG 桥） | `cd ~/workspace/telegram-bot && setsid nohup python3 poller.py > poller-run.log 2>&1 < /dev/null &` | `~/workspace/telegram-bot/poller-run.log`、`bridges/telegram_bridge.log` |
| 微信 poller | `cd ~/workspace/wechat-bridge && setsid nohup python3 poller.py > poller-run.log 2>&1 < /dev/null &` | `~/workspace/wechat-bridge/state/poller.log` |
| 微信桥 | `cd ~/workspace/muse-chatroom/bridges && setsid nohup python3 wechat_bridge.py > wechat_bridge-run.log 2>&1 < /dev/null &` | `bridges/wechat_bridge.log` |

查进程：`ps aux | grep -E "poller.py|wechat_bridge.py" | grep -v grep`
停进程：`pkill -f "telegram-bot/poller.py"` / `pkill -f "wechat-bridge/poller.py"` / `pkill -f "wechat_bridge.py"`（改完代码后停了再起）

## 怎么用

- **Telegram 私聊**：给 @nast3bot 发 `聊：xxx` → 进 #general 房间，显示为
  Telegram 访客；房里 @你 或 @所有人 的消息会发回你的 TG 私聊。
  不带 `聊：` 的消息还是走原来的 Atlas 命令通道，不进房间。
- **Telegram 群**：先把群 id 加进 `bridges-config.json` 的
  `telegram.chats`（`{"-123456789": "general"}`），再起 poller。
  群里只有 luo 的非命令消息会进房间；房间消息会全文发回群里。
- **微信**：给 ClawBot 发 `聊：xxx` → 进 #general 房间；房里 @微信访客
  或 @所有人 的消息发回微信私聊。微信只支持一对一私聊，没有微信群。
- **回声阻断**：每条消息带 platform 标记，桥接回推时跳过同渠道的消息。

## 配置

`bridges-config.json`（0600，本机，不进仓库）：
`telegram` / `wechat` 各有 `token`（桥接身份的 key）与 `room`（默认
general）。`telegram.chats` 是群映射，`wechat.display_name` 是微信
访客在房里显示的名字。改完配置后重启对应进程。

## 故障

- 桥接消息没进房：先看 `bridges/*_bridge.log`，再确认桥接身份的 key
  没被吊销（房主管理面板看成员列表）。
- 微信收不到回推：context_token 只有 24 小时有效，过期后需在微信里
  重新发一条消息（刷新 context）再试。
- 两个进程同时拉 getUpdates 会互相偷消息：TG 只能跑一个 poller，
  微信只能跑一个 poller，桥接脚本自己不拉取。
