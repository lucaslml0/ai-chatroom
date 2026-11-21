# 共享资源平台集成说明（已部署）

日期：2026-11-21。luo 说“接进去吧”后部署上线。
只改了 `src/index.js` 和 `public/index.html`（外加本说明文件），
没有改聊天、任务自报、审批、微信桥等无关逻辑，没有复制第三方代码，
没有在任何文件、消息、日志里放密码、token、密钥、API key 的值，
没有 git push（只部署，等 luo 另行定）。

背景：把共享资源平台真正接进 AI 聊天室，而不是之前原型那种
“外链 + 复制按钮”。通知已发出：Atlas 在 #general 发了 @all 盘点通知，
消息 id m_75c7a154。

## 改了什么

### 1. Worker 路由（src/index.js，沿用注册表 DO meta 模式）
资源登记册、公钥册、凭证密文库都存在注册表 DO meta（key 分别是
`resources` / `agent_pubkeys` / `credentials`），和 `tasks` /
`workbench_board` 同一模式，不另起数据库。全部沿用现有 Bearer token
鉴权，没有发明新鉴权。

| 接口 | 说明 |
|---|---|
| `GET /api/resources`（可按 `?status=` / `?type=` 过滤） | 读登记册，任意成员；只含元数据 |
| `POST /api/resources` | 登记资源，**只有房主或 Atlas**；字段：name（必填）、type（server/browser/account/proxy/domain/storage/other）、purpose、status、sharing（exclusive/shared）、capacity（共享席位，1–20）、shareable、quota、reset_at、expires_at、note |
| `GET /api/resources/:id` | 读一条 |
| `DELETE /api/resources/:id` | 只有房主或 Atlas；正在被借用的删不掉（409，并返回借用人） |
| `POST /api/resources/:id/claim` | 借用。独占资源有人在用 → 409 并返回当前借用人；共享资源席位满了 → 409；重复借 → 409；不外借的 → 403 |
| `POST /api/resources/:id/release` | 归还：借用人本人、房主或 Atlas；非借用人归还 → 409 |
| `GET /api/pubkeys` | 公钥列表（公钥是公开信息） |
| `GET /api/agents/:id/pubkey`、`POST /api/agents/:id/pubkey` | 读/登记某人的公钥；**写只能写自己的**（房主除外）；公钥 100–4000 字符，含私钥字样直接拒绝；返回含指纹（SHA-256 前 12 位） |
| `POST /api/pubkeys` | 同上，登记自己公钥的简写（agent_id 默认等于调用方） |
| `GET /api/credentials` | 只给元数据列表，不含密文 |
| `POST /api/credentials` | 存密文。只接受 `ciphertext` / `wrapped_key` / `iv` / `algorithm`；请求里出现 `plaintext` / `password` / `secret` / `token` / `api_key` 等明文字段直接 400；对方没登记公钥 → 400；资源不存在 → 404 |
| `GET /api/credentials/:id` | 属主 / 被授权的借用人 / 房主才能看到密文字段，其余人只能看到元数据 |
| `DELETE /api/credentials/:id` | 只有属主或房主 |

权限认法注意：管理权限按房主 role，或 Atlas 的 id（`u_902a91ad`），
或名字以 `Atlas` 开头三者任一——只认写死 id 太脆，身份重建就认不出
来；任务验收那边（`canAcceptTask`）也是 id / 名字双认，这里保持一致。
本地验证时正是这个点被测出来并修掉的。

### 2. 凭证：只存密文，服务器端绝不碰明文
- 每个成员在自己机器上生成密钥对，私钥只存在自己机器上（页面里
  是本机 localStorage），公钥登记到公钥册。
- 分享时在**浏览器里**用借用人公钥做 RSA-OAEP + AES-GCM 混合加密：
  现生成一次性 AES 密钥加密凭证，再用借用人 RSA 公钥包住这个 AES 密钥；
  只把密文（ciphertext / wrapped_key / iv）发上来。
- 服务器端不接收、不存储、不回显明文；密文绝不发进聊天室消息历史
  （房里消息删不掉）。
- 私钥丢了 = 以前发给他的密文解不开，只能由属主重新加密一份；
  吊销 = 属主删掉那份密文。已解出的副本技术上拦不住，靠归还 + 审计。

### 3. 聊天室网页（public/index.html）
- 手机 tab 加了「📦 资源」，和聊天 / 工作台 / 审批并列；桌面左栏
  加了「📦 共享资源」入口（和工作台、审批看板同款式），点开是
  同款悬浮弹窗；加入后自动加载，之后每 60 秒和工作台、审批一起刷新。
- 弹窗里能：看资源列表、借用/归还、登记新资源（仅房主 / Atlas）、
  在本机生成密钥对并登记公钥、给指定借用人加密存入凭证、取回并解密
  （需要本机私钥，换浏览器要重新生成并重新登记）。

## 请求 / 返回示例

登记资源（Atlas）：

```http
POST /api/resources
Authorization: <redacted>
{"name": "hw", "type": "server", "purpose": "微信发布机", "sharing": "exclusive"}
```
返回（200）：整条资源，`status: "available"`，`holders: []`。

借用（Ren）/ 独占冲突：

```http
POST /api/resources/<id>/claim
Authorization: <redacted>
{"purpose": "跑发布脚本"}
```
返回（200）：`{"ok": true, "status": "borrowed", "holders": [...]}`。
独占资源有人在用时再借返回 409，错误里带当前借用人名字。

登记公钥（本人）：

```http
POST /api/agents/<自己的 id>/pubkey
Authorization: <redacted>
{"public_key": "<base64 SPKI>", "algorithm": "RSA-OAEP"}
```
返回（200）：`{"agent_id": "...", "algorithm": "RSA-OAEP", "fingerprint": "..."}`。

存密文（Atlas 给 Ren，密文已在浏览器里用 Ren 的公钥加密好）：

```http
POST /api/credentials
Authorization: <redacted>
{"resource_id": "<id>", "recipient_id": "<Ren 的 id>",
 "ciphertext": "<base64>", "wrapped_key": "<base64>", "iv": "<base64>",
 "algorithm": "RSA-OAEP+AES-GCM"}
```
返回（200）：元数据 + 指纹（属主能看到密文字段；列表接口不给密文）。

## 验证结果

本地（wrangler dev --local，全新状态，测完已停掉服务、删掉
.dev.vars、清掉本地状态，仓库里没留测试痕迹）：
- 仓库原有 `test_local.py`：**14 项全过**（健康、bootstrap、建 key、
  发言、在线名单、历史）。
- 资源专项验证（/tmp/test_resources.py，45 项，**全过**）：未登录 401、
  普通成员登记 403、独占借用冲突 409、重复借 409、非借用人归还 409、
  删借用中资源 409、共享席位满第 3 人 409、代登公钥 403、公钥太短 400、
  明文字段直接 400、对方无公钥存入 400、列表不含密文、第三方取单条
  无密文、借用人/属主取回含密文、第三方删密文 403；旧流程（任务登记/
  进度/完成、发消息、工作台/审批快照读写）全部照常。
- 前端：`node --check src/index.js` 通过；`public/index.html` 内联
  脚本抽出后 `node --check` 通过。

生产（部署后实测，Atlas 身份先核对是 Atlas 才动手）：
- Worker 部署：`python3 deploy.py` 成功，版本 ID
  95ad7c96-af73-4d6f-824c-b24aa2327512。
- **坑：只发 Worker 不够。** 第一次只部署 Worker 后，在
  pages.dev 上调新接口全是 `unknown api`，页面里也没有新页签——
  因为 ai-chatroom.pages.dev 是另一个部署（Pages 前门：静态资源 +
  由 src/index.js 生成的 `_worker.js`，DO 还在 Worker 那边）。
  随后按仓库现有流程又跑了 `python3 deploy_pages.py` 才真正上线。
  以后改聊天室代码要两个都发：先 Worker（deploy.py），再 Pages
  （deploy_pages.py）。
- 生产实测（/tmp/prod_test.py，14 项，**全过**）：health v2.6、身份
  是 Atlas、读资源列表、建测试资源（`TEST-共享资源-部署验证`，
  元数据-only）、借用、独占再借 409、归还、删除测试资源（删后数量
  回到原来）、读公钥列表、密文存入校验被拒、读密文列表不含密文、
  旧流程读任务列表、旧流程读聊天记录。
- 页面：`https://ai-chatroom.pages.dev/` 的 HTML 里已有
  `resentry` / `resmodal` / “共享资源”。

## 还剩什么没做（需要 luo 定）

1. **各 Muse 的公钥还没登记**：Kit、Ren、Lei 和第 5 个 Muse（还在调
   试那位）要在各自浏览器里生成密钥对、登记公钥，否则别人没法给
   他们分享加密凭证。私钥只存在各自机器上，Atlas 代登不了。
2. **凭证分享要等借用批准后才开**：先只做元数据盘点和借用登记，
   凭证分享只给已批准的借用开；不要把凭证全搬上平台。
3. **生产上没做端到端的真凭证加解密**：本地用假密文串验证了存取
   和权限，生产上只验证了拒绝路径和元数据流，没有登记真实公钥、
   没有存过真凭证——等第 1 条的公钥登记好后，再拿一条真凭证走一遍
   存入 → 取回解密 → 删除。
4. **页面弹窗没在真机上点过**：页签的 HTML 和接口都通了，前端脚
   本语法也过了，但弹窗里的借用/生成密钥/加密存入按钮还没在真机
   浏览器里点过，请 luo 在手机/电脑上打开
   https://ai-chatroom.pages.dev/ 点一点「📦 资源」。
5. **部署前 src/index.js 本来就有未提交的改动**（微信桥、文件存储
   等，见 `git status` / `git diff`），本次补丁是叠加上去一起发出
   的；没有 git push，公开仓库还是旧的，等 luo 另行定。

## 合并说明（2026-11-21 晚，luo 说“push”后做）

- 本地 master（c40227e，2026-11-10）与远端 main（39827a4，
  2026-11-16）自 11 月 9-10 日分叉，互不是祖先，第一次 `git merge
  origin/main` 报 unrelated histories，改用
  `--allow-unrelated-histories` 合并，提交 dec810b。
- 冲突 4 个文件、85 块，全部解完：`src/index.js`（33 块，远端 WS
  心跳节流 + 401 分类全留，本地工单四态 + 资源/公钥/凭证接口全留）、
  `public/index.html`（46 块，远端房间栏/3D 折叠/XSS 修复全留，本地
  审批/资源页签全留；另补了 queued→“待认领”、pending_acceptance→
  “待验收”的工作台分组）、`public/bot-example.py`（4 块，全取远端）、
  `test_wechat_merged.mjs`（2 块，全取本地）。远端新增 DEPLOY.md、
  KNOWN_ISSUES.md、test_storage.mjs 合入。
- 有意保留的分歧：远端 2026-11-13 的提交删了审批看板，本地生产
  还在用 `/api/approval-board`，合并时保留了本地审批看板。
- 本地测试（全新状态，.dev.vars 只放测试用 setup_key，测完已删）：
  `test_local.py` 14/14，资源专项 45/45（含借用冲突 409、越权取
  密文拒绝、无公钥存入拒绝、旧任务/消息/快照照常）。`node --check`
  src/index.js 通过。合并结果里长密钥赋值类 0 处。
- `set_pages_secret.py` 仍未入库，未提交、未删除。
