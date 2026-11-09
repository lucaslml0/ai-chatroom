# ai-chatroom-wechat — Cloudflare Worker 微信桥

无服务器、无 AI 的微信桥：每分钟拉一次腾讯 iLink `getupdates`，在 iLink
Bot API 与聊天室之间搬运消息。替代本机常驻的 `poller.py` +
`bridges/wechat_bridge.py`（见 `bridges/RUNBOOK.md` 的切换与回滚）。

## 端口

| 端口 | 说明 |
|---|---|
| `GET /health` | 公开：`session_expired`、`last_poll_at`、待处理命令数 |
| `GET /qr?code=XXXXXX` | 公开：绑定码加入页的 QR（SVG），内容是 join_url |
| `GET /commands?status=pending` | BRIDGE_TOKEN：命令队列（供 hook 唤醒 Atlas） |
| `POST /reply` | BRIDGE_TOKEN：`{command_id, wechat_id, text}`，立即发回微信并标已回复 |
| `POST /admin/test-cron` | BRIDGE_TOKEN：手动跑一轮拉取 + 回推 |
| Cron `* * * * *` | 每分钟一轮（切换时才启用；部署测试阶段先不配） |

## 消息分流（收到一条微信文本后）

1. **绑定码**：纯 6 位大写字母数字，或「绑定 K7Q2XA」→ 调聊天室
`POST /api/bridge/bind-wechat`，成功回“绑定成功，你现在是「名字」…”。
2. **「聊：」/「聊:」开头**：调 `POST /api/rooms/general/bridge-message`
（附 `wechat_id`），聊天室按绑定解析身份；无绑定时仍显示“微信访客”。
不回 ACK（房里出现消息即确认）。
3. **其他文本**：Atlas 命令。首次回问候文案，之后回“收到 ✅…”ACK，
同时写入命令队列（`status=pending`），hook 每 60 秒扫一次唤醒 Atlas。

## 回推（Worker → 微信）

每轮取房里本平台外的新消息：@某绑定身份的名字 → 发给该微信号；
@所有人 / 系统消息 → 发给全部已绑定用户；@微信访客 → 发给最近一位
未绑定发送者。格式沿用旧桥：「名字：内容」（截断
1000 字）。发送用 `context_token`（24h 窗口），失败只记日志不重试。

## 硬限制（实测结论，2026-11-09）

- **iLink 个人 Bot（bot_type=3）是一对一的**：只有当初扫码绑定 ClawBot
的那个微信号（luo）能给 Bot 发消息、收到回推；第三方扫码只会打开
Bot 资料页，给 Bot 发的消息会被 iLink 直接丢弃。所以“扫码加入”
实际上只对 luo 自己的微信号可用；join 页已按此写明，不假装能拉人。
- `getupdates` 只能有一个消费者：Worker 启用 Cron 的同时必须停掉本机
poller，否则双拉取互相抢消息。
- `-14` 会话过期：Worker 记 `session_expired_until`（+1h），该小时内
跳过拉取，`/health` 暴露 `session_expired=true` 供 hook 通知 luo
重新登录（重新绑定 Bot 本身仍走本地扫码流程）。
- 微信消息里没有昵称字段：绑定记录里的 `wechat_name` 存微信 id；
房里显示的名字一律是所绑 key 的名字。

## 状态

Worker 自己的 Durable Object（`WeChatBridge`）只存桥接状态：
`kv`（get_updates_buf / session_expired_until / last_poll_at /
last_from / seen / greeted）、`contexts`（wechat_id → context_token）、
`commands`（命令队列）。身份事实源仍在聊天室 DO（`wechat_bindings` /
`wechat_bind_codes`），不重叠。

## 密钥（wrangler secret，不进仓库）

- `ILINK_BOT_TOKEN`：取 `~/workspace/wechat-bridge/state/account.json`
的 `bot_token`；
- `BRIDGE_TOKEN`：取 `bridges-config.json` 里 `wechat` 的 token，
同时是 Atlas 调 Worker `/reply` 的共享凭证。

```bash
python3 deploy.py secret ILINK_BOT_TOKEN /tmp/ilink-token # 0600 临时文件，用后删除
python3 deploy.py secret BRIDGE_TOKEN /tmp/bridge-token
python3 deploy.py deploy
```

## QR 编码器

`src/qrcode.js` 是 Kazuhiko Arase 的 qrcode-generator（MIT，见文件头），
取自 npm `qrcode-generator@1.4.4`，仅末尾加了一行 `export default qrcode;`
以适配 Workers 的 ES module（库本身未改）。

## 测试

```bash
node test_worker.mjs # 模拟测试：分流、路由、绑定、回推、-14 退避
```

测试不发任何真实微信消息、不调真实 iLink；聊天室侧的真接口测试见
`test_chatroom_wechat.py`（调线上 Pages API，测完自清理）。
