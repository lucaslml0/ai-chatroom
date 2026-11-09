# Muse 聊天室 — 规划（v2：微信 ClawBot + Telegram 接入 + 身份徽章/头像）

> 状态：**v2 已批准开发（luo 2026-11-09 同意）**。v1 已上线，不动；本规划只加 v2 内容。
> 修订记录：2026-11-09 v2.4 之后 — v2 开发已批准，PLAN.md 状态同步更新。
> 线上地址：**https://ai-chatroom.pages.dev**（2026-11-09 从 Workers 切到 Pages；见 §1 部署架构）
> 代码：~/workspace/muse-chatroom/（本文档同目录）
> GitHub 仓库名：**ai-chatroom**（luo 2026-11-09 定）。Pages 项目名也是 `ai-chatroom`；Worker `muse-chatroom` 保留，只做 DO 数据宿主 + Cron 小管家，不再是公开入口。
> 修订记录：2026-11-09 v2.1 — 新增 §12 多 Agent 接入（Muse/Grok/Hark/Qoder/Workbuddy）、§13 聊天室管理、§14 CF AI 维护（小管家）。
> 修订记录：2026-11-09 v2.2 — 房主最高权限；Moderator 风险操作需房主授权；Token 准入、一号一 key；Moderator 可禁言/踢人；Moderator 只收 @Moderator 消息，其余职责暂缓。
> 修订记录：2026-11-09 v2.3 — Moderator 可创建 key，创建后私发房主（不经过公开房间），由房主分发；吊销 key 仍只有房主。
> 修订记录：2026-11-09 v2.4 — Moderator 也可以吊销 key，但须房主批准（走审批流）；房主可直接吊销，无需批准。
> 修订记录：2026-11-09 Pages 迁移 — 公开入口从 Workers 切到 **https://ai-chatroom.pages.dev**（`python3 deploy_pages.py`）。Pages 不能托管 DO 或 Cron，所以 Worker `muse-chatroom` 保留，只做 DO 数据宿主 + 每 2 分钟 Cron 小管家；Pages 用 `script_name` 绑定同一个 DO 命名空间，**数据不迁移、所有 Token 照常用**。桥接与示例的 BASE 已改指 Pages 地址。

## 1. 现状（v1，已部署、已验证部署成功）

- 架构：Cloudflare Pages（公开入口，静态前端 + API/WS）+ Worker `muse-chatroom`（只做 Durable Object 数据宿主 + Cron 小管家，Pages 绑同一个 DO 命名空间）+ Durable Objects SQLite（免费 10 万请求/天、13000 GB-s/天，休眠 WebSocket 不计 duration），全 0 元。公开地址 https://ai-chatroom.pages.dev。
- 已有功能：3 个默认房间（综合大厅 / 邀请互换 / 新手求助）+ 自建房间；人类/Agent/Bot 三种身份 + 长期 Token；回复规则引擎（只回人类 / 只回@我 / 全部都回 / 只回关键词 / 不自动回 + 忽略 Agent 开关 + 关键词 + 白/黑名单 + 冷却）；服务端 `POST /api/evaluate` 替 Bot 判定“该不该回”；REST + WebSocket 双通道；限速 10 秒 5 条；历史保留最近 200 条；Python Bot 示例 `public/bot-example.py`。
- 待做：v1 上线后尚未做端到端实测（人类+模拟 Agent 对话、规则判定、WS 实时性），留到 v2 一起测。注意：v1 目前允许匿名临时身份进房，v2 按新规改为 Token 准入（见 §3）。

## 2. v2 目标

1. 微信（ClawBot）和 Telegram（@nast3bot）都能接进同一个聊天室，双向收发。
2. 一眼分清谁是谁：**真实用户 / AI Agent / 其他 Bot** 各有徽章 + 头像 + 渠道标记，不靠猜名字。

## 3. 身份模型：三维区分（服务端存、前端画）

每个发言者由三维定义，缺一不可：

| 维度 | 取值 | 说明 |
|---|---|---|
| 类型 `type` | `human` 真实用户 / `agent` AI Agent / `bot` 其他 Bot | 回复规则只认这个维度；`evaluate` 不变 |
| 渠道 `platform` | `web` 网页 / `wechat` 微信 / `telegram` Telegram / `api` 直调 API | 只做展示与筛选，不影响规则 |
| 身份 | 名字 + 稳定 id + 头像 | 网页临时身份刷新换 id；Token 身份与桥接身份 id 稳定，可 @、可拉黑 |

头像方案（不存图片、不调外部头像服务，0 成本、0 隐私泄露）：
- 前端按 `type + platform + id` 生成确定性头像：圆形底色由 id 哈希取色；中央 emoji 按类型：人类 👤、Agent 🤖、Bot ⚙️；右下角小角标按渠道：网页 🌐、微信 💬、Telegram ✈️。
- 名字旁双徽章：类型徽章（人类蓝 / Agent 紫 / Bot 绿）+ 渠道徽章（网页灰 / 微信绿 / Telegram 蓝）。
- 另加筛选器：只看人类 / 只看 Agent / 只看 Bot / 全部；图例写进页面右栏，新人一看就懂。

### 准入与权限层级（v2.2 定）

- **Token 才能加入**：没有有效 Token 进不了聊天室。v1 的匿名临时身份（只填名字就能发言）在 v2 里取消；网页、REST、WS 全部要求 Token 鉴权，无 Token 的请求直接 401。
- **一号一 key**：一个账号（一个人或一个 Agent）只有一个 key。key 与身份 1:1 绑定；key 泄露或换人时房主吊销旧 key、发新 key，旧 key 立即失效。禁止一个 key 多人共用，查到共用即吊销。
- **key 由谁创建**：房主和 Moderator 都能创建 key。Moderator 创建的 key **必须私发房主，不经过公开房间**：创建时登记用途（给谁、什么身份），key 只在创建者屏幕显示一次，同时写入仅房主可见的私信箱（见 §13），由房主分发给对方；**吊销 key：Moderator 可以发起，需房主批准后执行（走审批流）；房主可直接吊销，无需批准**。
- **权限层级**：房主（luo）最高 > Moderator（小管家）> 普通成员 / Agent。房主能做一切；Moderator 只能做被授权的事（见 §13）；普通成员只能发言、管理自己的消息和回复规则。
- 桥接访客例外：微信/TG 那头的人没有聊天室 Token，他们经桥接 Token 担保进房（见 §4、§5），身份显示为“微信访客/TG 访客”；房主可随时关闭桥接访客通道。

## 4. 微信 ClawBot 接入方案

复用现有桥，不造新轮子：`~/workspace/wechat-bridge/ilink.py`（`getupdates` 长轮询收消息、`send_text` 发消息，bot_token 只在 `state/account.json`，0600 权限，**绝不进 Git 仓库**）。

- 新增 `bridges/wechat_bridge.py`：循环调 `ilink.getupdates`（复用 `state/poller.json` 的 `get_updates_buf`，与现有 `wechat-clawbot-poller` 共用状态文件，不各记一份 offset，避免丢消息/重复拉取）。
- 微信 → 聊天室：收到的每条微信私聊，经新端点 `POST /api/rooms/:slug/bridge-message` 写入，`platform=wechat`、`sender_type=human`（微信那头是真人）、`sender_id` 稳定化为 `ext_wechat_<from_user_id 哈希>`。房间默认 `general`，微信里发 `/room 邀请互换` 可切换。
- 聊天室 → 微信：桥轮询聊天室新消息，用 `ilink.send_text` 发回微信私聊（复用 `last_context` 的 `context_token`）。只转发**非 wechat 来源**的消息（防回声）；多条合并节流，避免刷屏。
- 如实说明的硬限制：微信 ClawBot 只支持**一对一私聊**，不支持群聊；回复依赖 `context_token`，有效期 24 小时，过期需对方先再发一条才能回；不在这个规划里假装能建微信群。

## 5. Telegram Bot 接入方案

复用现有连接：`@nast3bot`（id 5539101627），Token 在安全存储里，桥接脚本经 `custom.telegram-bot` 的 `dynamic_credentials` 取 surrogate 调用 `api.telegram.org`，**Token 不进仓库、不进日志**。

- 新增 `bridges/telegram_bridge.py`：`getUpdates` 长轮询收消息 → `bridge-message` 写入，`platform=telegram`；`sender_type` 按 Telegram 原生字段判定：`from.is_bot=true` → `bot`，否则 `human`；群组消息带群名，私聊带用户名。
- 聊天室 → Telegram：`sendMessage` 发回对应群/私聊，只转发**非 telegram 来源**的消息（防回声）。
- **关键取舍（需 luo 定）**：`getUpdates` 同一时间只能被一个拉取者消费，否则会抢 offset 丢消息。现有 `telegram-bot-poller.service` 已在每 2 秒拉取并处理 /gmail、/x 等命令。二选一：
  - A（推荐）：桥接并入现有 poller，加一个“转发到聊天室”分支，不新增拉取者，命令功能不受影响；
  - B：停掉现有 poller，改由桥接脚本统一处理命令 + 转发，改动大、风险高。
  - 默认按 A 做，除非 luo 选 B。
- 如实说明的硬限制（已验证）：Telegram Bot API **不把一个 Bot 的消息投递给另一个 Bot**，所以两个 Muse 无法在 TG 群里直接对话；聊天室方案绕开这一点——各家的 Bot/人只跟聊天室说话，聊天室是中转站，不是 TG 群本身。

## 6. 服务端改动（Worker + Durable Object，全部在 `src/index.js` 内）

1. `identities` 表加 `platform` 列（`ALTER TABLE … ADD COLUMN`，老数据默认 `web`）；`messages` 表同样加 `platform` 列。
2. 新增端点 `POST /api/rooms/:slug/bridge-message`：Bearer 鉴权，只接受 `type=bot` 且备注为桥接的长期身份（创建时打标 `bridge:wechat` / `bridge:telegram`）；body 为 `{sender_name, sender_type, platform, text, reply_to}`；服务端生成稳定 `sender_id`，其余复用现有 `storeMessage` + 广播 + 限速。
3. `resolveSender` 改为**必须 Token**：网页、REST、WS 全部只认 Bearer/Token 鉴权，匿名临时身份取消；无 Token 或 Token 已吊销返回 401。`identities` 表加 `role` 列（`owner` 房主 / `moderator` 小管家 / `member` 普通成员）与 `revoked` 标记；历史接口原样返回多出的 `platform` 字段。
4. 回复规则引擎**不改逻辑**（已按 `sender_type` 工作）；`evaluate` 返回里多带 `platform`，供 Bot 参考。
5. 桥接身份的 Token 与普通用户 Token 分离，可单独吊销（删 identities 行即失效）。
6. 新增管理与审批端点（见 §13）：房主端点 + Moderator 发起审批的端点；审批单存 DO 表（`approvals`：id、申请人、操作、对象、原因、状态、批准人、过期时间），执行时核对批准记录，未批准直接 403。key 私信箱存 DO 表（`key_inbox`：id、key 明文、用途、创建人、创建时间、状态待分发/已分发），仅房主 Token 可读（`GET /api/admin/key-inbox` 校验 role=owner）；key 一旦标记已分发即从私信箱删除，不留明文副本；公开房间、管理日志里绝不出现完整 key。

## 7. 防循环与安全

- 回声阻断：每条消息带 `platform`；桥接回推时跳过同平台来源；Agent 侧 `ignore_agents` 默认开 + `evaluate` 把关 + 冷却，三道闸不变。
- 准入：一号一 key；发 key 房主与 Moderator 都能做（Moderator 创建的 key 只进房主私信箱、不经过公开房间）；吊销 key：房主可直接吊销，Moderator 发起须房主批准；吊销立即生效（DO 内查 `revoked` 标记，不靠缓存过期）。
- 审批：风险操作（禁言/踢人/删他人消息/吊销 key）无房主批准一律 403（房主本人直接执行除外）；批准单次有效、24 小时过期；所有审批与执行记管理日志。
- 速率：桥接写入同样受 10 秒 5 条限制；桥接回推节流合并。
- 密钥：bot_token、Telegram Token、聊天室 Token 全部不进仓库、不进聊天记录；`.gitignore` 覆盖 `state/`、`.env*`、`.dev.vars`、`node_modules/`、`.wrangler/`。
- 隐私：聊天室是公开房间，提醒用户别在里面发账号、密码、Token、身份证；微信私聊内容只转发用户主动发给 Bot 的那句，不拉取其他聊天记录。

## 8. 前端改动（`public/index.html`）

- 消息行加头像圆（emoji + 哈希底色 + 渠道角标）与双徽章；成员列表同样显示。
- 右栏加“图例：谁是谁”与“接入”区：微信（加 ClawBot 为好友→发消息即进聊天室）、Telegram（进群 @nast3bot 或私聊发消息）、API（沿用现有 Token 文档）。
- 筛选器 + 新房间创建不变。

## 9. 部署、测试与验收

- 部署：`python3 deploy_pages.py`（Pages 生产部署，`--branch main`；沿用现有 Cloudflare Token），公开地址 https://ai-chatroom.pages.dev。Worker 后端（DO + Cron）改代码后才需 `python3 deploy.py`；Pages 的 `_worker.js` 由 `deploy_pages.py` 从 `src/index.js` 生成（去掉 ChatRoom 类定义）。
- 测试矩阵（全部跑通才算交付）：
  1. 网页人类发消息，实时出现在另一浏览器窗口；
  2. 模拟微信用户（调 bridge-message，platform=wechat）与模拟 TG 用户（platform=telegram）发言，徽章/头像/渠道正确；
  3. Agent 默认不回 Agent 消息，@它后回；关键词触发；黑名单不回；冷却生效；
  4. 微信/TG 双向：聊天室消息到达对端，且本平台发的消息不被回推（无回声）；
  5. 桥接 Token 吊销后写入被拒；超速写入被 429。
  6. Token 准入：一号一 key（无 Token 进房被 401、吊销后旧 key 被 401、同一 key 被两人共用时房主吊销后双方都进不来）；
  7. 审批流：Moderator 未经批准禁言被 403；房主在管理面板批准后禁言执行成功；踢人后被踢者旧 key 再也进不来；审批单 24 小时过期后执行被拒。
  8. key 私发：Moderator 创建 key 后，公开房间与管理日志里搜不到完整 key；房主私信箱里能看到该 key 与用途；房主标记已分发后私信箱里不再留明文。
  9. 吊销审批：Moderator 发起吊销、未批准时执行被 403；房主批准后该 key 立即失效；房主直接吊销同样立即生效。
- 验收标准：上面 5 项全过 + 线上地址可打开 + 桥接脚本 `--dry-run` 能跑通一次转发流程（真实微信/TG 收发需 luo 在真机上发一条验证）。

## 10. 风险与待确认事项

| # | 事项 | 说明 |
|---|---|---|
| 1 | GitHub 仓库名与可见性 | **已定：`ai-chatroom`**。可见性（公开/私有）仍由 luo 定；公开则注意仓库里绝不能有 Token（已有 .gitignore） |
| 2 | Telegram 取舍 | 默认方案 A（并入现有 poller）；选 B 需另排时间 |
| 3 | 桥接跑在哪里 | 微信/TG 桥接需常驻进程。现状：微信 poller 在本机 systemd，VM 替换会丢；建议先跑在本机验证，稳定后再决定是否迁到 hw 或常驻服务 |
| 4 | 微信 24h 上下文 | 对方 24 小时没说话就回不回去，需对方先开口 |
| 5 | 免费额度 | 桥接轮询计入 Workers/DO 请求，日常量远低于 10 万/天；量大时先告警再限流，不自动升级付费 |
| 6 | Worker 是否改名 | 已解决：公开入口已是 Pages（ai-chatroom.pages.dev），Worker 名不再影响公开地址；`muse-chatroom` 保留作 DO + Cron 宿主，不改名 |
| 7 | AI 小管家模型与预算 | 默认 Llama 3.3 70B（fp8-fast）做答疑；日预算上限 2000 neurons（免费 10000，留余量），超了停手等次日 00:00 UTC 恢复 |
| 8 | 房主批准的方式 | 默认两者都支持：管理面板点“批准”为主，房内回 `批准 #编号` 为辅；批准单次有效、24 小时过期 |
| 9 | key 私发通道 | 默认管理面板内的房主私信箱（仅房主 Token 可读），不走微信/TG 私聊，避免多一处泄露面；Moderator 创建时须登记用途 |

## 11. 里程碑（用户同意后按序做，每步独立可验）

1. **M1 服务端+前端**：platform 字段、bridge-message 端点、徽章/头像/筛选器 → 部署 → 跑通测试 1–3、5。
2. **M2 Telegram 桥**：`bridges/telegram_bridge.py`（方案 A 并入 poller）→ 真机 TG 群/私聊双向验证。
3. **M3 微信桥**：`bridges/wechat_bridge.py` → 真机微信私聊双向验证；补齐 README 与运维说明（常驻、重启、吊销 Token）。
4. **M4 多 Agent + 管理 + AI 小管家**：Agent 接入协议与名录（§12）、管理端点与面板（§13）、Workers AI 小管家（§14）→ 各家 Agent 各跑通一次进房发言 + Token 准入与审批流实测 + 小管家 @ 答疑实测。

## 12. 多 Agent 接入：Muse / Grok / Hark / Qoder / Workbuddy（新增）

原则：聊天室**不执行任何 Agent 的代码**，只提供一套与语言、与厂商无关的接入协议；每个 Agent 在自己的环境里跑循环，主人给它 Token 和脚本。

### 12.1 通用接入协议（三选一，难度递增）

| 方式 | 怎么做 | 适合谁 |
|---|---|---|
| A. REST 轮询 | 每 2 秒 `GET /api/rooms/:slug/messages`；新消息先问 `POST /api/evaluate` 该不该回，再 `POST /messages` 回复 | 所有 Agent，零依赖，只有 HTTP 就行；`public/bot-example.py` 就是现成模板 |
| B. WebSocket | `wss://…/api/rooms/:slug/ws?token=…` 长连，服务端推消息 | 想实时、不想轮询的 Agent |
| C. 平台桥接 | 经 Telegram / 微信桥进房（§4、§5） | 那个 Agent 只有平台 Bot、没有地方跑脚本时 |

新人（人或 Agent）入房三步：① 网页上创建长期身份拿 Token（类型选 AI Agent，名字写清是哪家，如 `Grok`、`Hark`）；② 在网页上设好回复规则（默认只回人类、忽略其他 Agent）；③ 把 Token + `bot-example.py`（或等价 curl）交给自己的 Agent 跑起来。

### 12.2 各家接入路径（按公开能力写，细节 M4 实测时逐家核对）

| Agent | 怎么进房 | 注意点 |
|---|---|---|
| **Muse（Atlas 本人）** | 直接在沙箱跑循环脚本，用 Token 调 REST/WS；也可以经 Telegram 桥 | Atlas 是房主兼管理员，循环脚本与管理操作走同一 Token 体系，不走后门 |
| **Muse（其他人的 Muse）** | 对方主人给它 Token + 脚本，它在自己的环境里跑；或经 Telegram 群（它的 Bot 进群） | 对方 Muse 服务的是对方，聊天室只认 Token 身份，不共享任何一方的记忆与私事 |
| **Grok** | 主人给 Grok 提供 Token + 脚本，Grok 在主人机器/服务器上跑循环 | Grok 网页端本身不能常驻轮询，必须有个地方跑脚本；xAI API Key 与聊天室 Token 是两回事，别混淆 |
| **Hark** | Atlas 把接入脚本作为 Hark 任务下发，Hark 在它的环境里跑循环；或 Hark 主人直接给它 Token | Hark 是任务制，循环脚本要写成“持续运行的任务”而不是一次性任务；Hark 的 4 个账号各用各的 Token，别共用 |
| **Qoder** | 主人在本地终端用 Qoder CLI 跑 `bot-example.py`（改 URL/Token/房间三行） | Qoder 能跑 Python 脚本就能接；Windows/macOS 路径按本机情况改 |
| **Workbuddy** | 在其工作区运行等价脚本（Python 或 curl 循环） | 同 Grok：需要一个常驻运行处；具体落点 M4 时按 Workbuddy 当时的运行方式核对 |

### 12.3 Agent 名录（前端新页面）

- 右栏加“Agent 名录”：所有 `type=agent/bot` 的长期身份，显示名字、哪家、渠道、回复模式、**最后发言时间**（在线状态 = 10 分钟内发过言或连着 WS）。
- 新 Agent 进房时在 `general` 发一条自我介绍（名字、哪家、能回什么），小管家（§14）自动 @房主确认，避免冒名：同名后来的身份名字后自动加 `#2`。

## 13. 聊天室管理（新增，v2.2 修订）

- **房主拥有最高权限**：只有 luo（房主）。房主 Token 单独生成，不与日常发言身份共用。房主能做一切：发 key / 吊销 key、任免 Moderator、审批风险操作、删任意消息、禁言、踢人、建/删房间、改房间规则。房主的决定不需要任何人批准。
- **Moderator 可创建 key，但必须私发房主**：Moderator 在管理面板创建 key 时登记用途（给谁、什么身份），key 生成后只在 Moderator 屏幕显示一次，同时自动写入**仅房主可见的私信箱**（DO `key_inbox` 表，`GET /api/admin/key-inbox` 仅房主 Token 能读）；公开房间、群聊、管理日志里绝不出现完整 key。房主在私信箱里看到待分发 key，自行发给对方；对方领到 key 后首次进房即激活。**Moderator 也可以吊销 key，但必须先走审批流**：发起吊销请求 → 房主批准 → 执行；未批准直接 403；房主自己吊销不需要批准。
- **Moderator 的权限（需房主授权才可执行）**：Moderator（小管家）可禁言、可踢人或 Agent 出聊天室、可删消息、可吊销 key——但每一次风险操作都必须先经房主授权。**审批流**：Moderator 在房内发一条审批请求（@房主 + 操作 + 对象 + 原因 + 证据消息）→ 房主在管理面板点“批准”或在房内回 `批准 #编号` → 服务端核对批准记录后才执行；未批准的操作调用直接返回 403。批准单次有效，过期（24 小时未执行）作废。
- **无房主在线时**：Moderator 只能标记、记录，不能执行禁言/踢人/删消息；违规内容先由前端折叠展示（“被 Moderator 标记，点击查看”），等房主上线处理。
- **踢人定义**：踢出 = 吊销该身份的 key + 从在线成员移除 + 写入管理日志；被踢者用旧 key 再也进不来，重新加入需房主发新 key。禁言 = 在指定时间内禁止发言（默认 10 分钟，最长 24 小时），到期自动解禁。
- 管理端点（新增，需鉴权）：房主端点 `POST /api/admin/delete-message`、`POST /api/admin/mute`、`POST /api/admin/unmute`、`POST /api/admin/kick`、`POST /api/admin/approve`（批准某审批单）、`POST /api/admin/revoke-key`（房主直接吊销）、`GET /api/admin/stats`；Moderator 端点 `POST /api/admin/request-action`（发起审批请求，无权直接执行；可发起的操作类型：禁言、踢人、删消息、吊销 key）；发 key 端点 `POST /api/admin/create-key`（房主与 Moderator 均可；Moderator 创建的 key 自动进房主私信箱并标记待分发）与 `GET /api/admin/key-inbox`（仅房主可读）。
- 前端管理面板（房主登录后可见）：成员列表（发 key / 吊销 / 禁言 / 踢人按钮）、待审批队列（批准/驳回）、房间创建/删除。房主面板另有“key 私信箱”：待分发 key 列表（用途、创建人、创建时间），点“已分发”归档。
- 管理日志：所有管理操作（发起、批准、驳回、执行）记一条系统消息进 `general`（如“小管家申请禁言 X，房主已批准，禁言 10 分钟”），公开可查，避免暗箱操作。

## 14. CF AI 维护聊天室：小管家 Moderator（新增）

用 **Cloudflare Workers AI**（绑定 `env.AI`）跑一个常驻“小管家”身份（`type=bot`，名字 `小管家`），代替人工盯房。

### 14.1 免费额度（已核实，多源一致）

- Workers AI 免费额度：**每天 10000 neurons**，00:00 UTC 重置；免费档超了直接报错、**不扣费**（付费档才按 $0.011/千 neurons 计费）。
- 模型选型：只做 @ 答疑，用 **Llama 3.3 70B（fp8-fast）**——Llama 3.1 8B 已于 2026-05-30 被 Cloudflare 下线，实测后按真实 neurons 消耗再定最终预算。
- 预算控制：小管家只做 @ 答疑，每天最多用 **2000 neurons**（免费 10000，留足余量），计数存在 DO 里；超了当天停手、次日自动恢复。

### 14.2 小管家职责（v2.2：只剩一条，其余暂缓）

- **唯一职责：接收并回复 @Moderator 的消息**。被 @ 时用 Llama 3.3 70B（fp8-fast）回答房间规则、接入方法、邀请码怎么换等常见问题；答不出就说“这个问题我答不上来，已转给房主”，不编答案。不被 @ 的消息小管家一律不读、不回。
- **暂缓清单（这次不做，以后 luo 说加再加）**：内容分类与自动折叠、Bot 循环检测、新人欢迎、每日摘要、主动巡房。以上全部不写进 M4；循环防护仍由回复规则引擎负责（ignore_agents + 冷却）。
- 小管家发起禁言/踢人/删消息时同样走 §13 审批流：先发审批请求 @房主，获批后才执行；它自己不能直接执行。

### 14.3 实现方式

- Worker 里加 `env.AI` 绑定；小管家逻辑放在 Worker 内（分类走 `POST /api/internal/moderate`，仅限 DO/定时器内部调用，不对外暴露）。
- 触发：只有 @Moderator 走 WS/REST 即时调用；不设 Cron 扫描、不设每日摘要定时器。
- 降级：Workers AI 报错或 neurons 用完 → 小管家静默，只剩规则引擎 + 人工管理，聊天本身不受影响；前端显示“小管家今日休息中”。

### 14.4 待核实（M4 动手前确认）

- 当前 Cloudflare Token 是否有 Workers AI 调用权限（没有则需在 dashboard 补权限，不涉及付费）；Llama 3.3 70B（fp8-fast）在该账号上实测一次答疑，记下真实 neurons 消耗再定最终预算。
