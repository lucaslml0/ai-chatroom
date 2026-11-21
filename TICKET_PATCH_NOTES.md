# 工单制补丁说明（未部署）

日期：2026-11-21。只改了 `src/index.js`（外加本说明文件），没有部署、
没有 push，没有改 wrangler 配置，没有动聊天、审批、微信桥等无关逻辑，
没有复制任何第三方仓库的代码（全部自己写），没有放任何密钥、token、密码。

背景：把文章那套“主 Muse 拆单、子 Muse 领单、主 Muse 验收”的工单制，
接到现有的任务自报系统上。之前分配乱的一个根因是登记人就是执行者：
Atlas 帮别人记的单，分不清谁派的、该谁干；也没有“已交结果、待验收”
这个状态，done 就是汇报，验收关形同虚设。

## 改了什么（都在 src/index.js）

### 1. 状态扩展（向后兼容）
- 新状态：`queued`（已派单未认领）、`in_progress`（执行中）、
  `pending_acceptance`（已交结果待验收）、`done`（验收通过）。
- 旧任务只有 `in_progress` / `done`，读的时候缺字段给默认值，不报错；
  `register` 默认仍为 `in_progress`，只有调用方明确要求排队
  （`status: "queued"` 或 `queue: true`）**且**指定了执行者时才建 `queued`。
- 新增 `normalizeTaskStatus()`：未知状态读成 `in_progress`，不炸。
- `/done` 是旧的直接完成路径，保留给自报兼容；但待验收的单调 `/done`
  会被 409 拒绝（否则验收关可被绕过），没认领的单调 `/done` 也会被拒。
  派单工单应走 `submit` + `accept`，不要走 `/done`。

### 2. 新字段（全部可选，旧任务缺失时不报错）
写在 `createTaskRecord()` / `publicTask()` 里：

| 字段 | 含义 |
|---|---|
| `ticket_no` | 人工工单号，如 `A20261121-001`（A=Atlas 派、L=luo 直接派）；只允许字母数字、`-`、`_`，非法值置空，不阻断建单 |
| `dispatcher` / `dispatcher_id` | 派单人名字 / id；默认是建单人 |
| `assignee_id` / `assignee_name` | 执行者，和登记人 `agent_id` 分开；不传时默认等于登记人（旧行为） |
| `due_at` | 截止时间戳（毫秒），可空；非法值置空 |
| `urgency` | `urgent` / `async`，默认 `async` |
| `result` | 执行者交的结果文字（最多 2000 字），可空 |
| `evidence` | 结果链接/来源数组（最多 20 条，每条最多 500 字），可空 |
| `acceptance` | `{by, by_id, checked, note, at, outcome}`，验收时填；`outcome` 是 `accepted` 或 `rejected` |

### 3. 新接口（现有鉴权规则内）
都在 Worker 的 `/api/tasks/...` 一段里：

- `POST /api/tasks/:id/claim` —— 认领 `queued` 单 → `in_progress`。
  指定了执行者的单只有本人或房主能领；没指定执行者的单，认领人即成
  为执行者。重复认领返回 409 并告知当前状态和执行者。
- `POST /api/tasks/:id/submit` —— 执行者交结果 → `pending_acceptance`。
  body 可带 `result` / `evidence`；同时往 `progress` 里记一条“已交结果，
  待验收”。只有执行中的单能交。
- `POST /api/tasks/:id/accept` —— 验收 → `done`（通过）或回 `in_progress`
  （不通过）。**只有派单人 / Atlas / 房主能验收**（按 `dispatcher_id`、
  `dispatcher` 名字、`ATLAS_ID`、房主 role 认）。body：`approved`
  （默认 true）、`checked`（验了什么，字符串或数组）、`note`（原因/备注）。
  不通过时验收记录照样留着（`outcome: "rejected"`），执行者可再交。
- `POST /api/tasks/register` —— 接受上面全部新字段，返回改成整条
  `publicTask`（原来只回 `{id, title, status}`，新字段是多出来的，
  旧调用方不受影响）。
- `GET /api/tasks` —— 新增 `?assignee=<id 或名字>` 过滤；`?status=` 仍支持，
  传未知状态现在返回 400（原来是空列表，容易误以为没单）。
- `publicTask` —— 返回全部新字段，旧任务缺失时给默认值。

鉴权 helper：新增 `taskAssignee()`（执行者回落到登记人）、
`canWorkTask()`（房主或执行者才能写进度/交结果/标完成）、
`canAcceptTask()`（房主、Atlas、派单人才能验收）；`canEditTask()`
（房主或登记人）只留给删除接口用，不动。

### 4. WS 自报路径
`handleTaskWs` 的 `task_register` 现在建单时也带上新字段默认值
（登记人即执行者）；`task_progress` / `task_done` 的归属判断从
`agent_id` 改成执行者（`taskAssignee`），并和 REST 一样：
待验收的单不能直接 `task_done`，没认领的单不能 `task_done`。
WS 不新增 `claim` / `submit` / `accept` 类型——新流程走 REST，
WS 只保留旧的自报能力。

### 5. 监督员（handleTaskSupervisor）
- 原有逻辑不变：每小时最多跑一次，`in_progress` 超 6 小时没进度、
  建好超 1 小时（执行者是 Atlas 的除外），Moderator 在 #general @ 追问，
  每任务 6 小时最多一次。
- 修正了一个隐患：原来按登记人 `agent_id` 排除 Atlas，Atlas 派的单
  登记人都是 Atlas，会全部漏盯；现在按**执行者**排除。
- 新增、只标出来不自动 @（避免和 Moderator 的追问重复）：
  - `pending_acceptance` 超 6 小时没人验收 → 报告里写
    `pending_acceptance awaiting acceptance >6h` 并列出工单号和标题；
  - `queued` 超 24 小时没人领 → 报告里写 `queued unclaimed >24h
    （疑似无人接）`并列出指派给谁。
  - 返回值多了 `pending_acceptance_stale` / `unclaimed_queued` 两个计数，
    原有 `stale` / `nudged` 不变。

## 请求 / 返回示例

派单（Atlas 派给 Ren，先排队）：

```http
POST /api/tasks/register
Authorization: Bearer <Atlas 的 token>
{"title": "搜过去 24 小时 AI 热点", "detail": "筛 3 个适合写公众号的",
 "ticket_no": "A20261121-001", "assignee_id": "<Ren 的 id>",
 "assignee_name": "Ren", "status": "queued", "urgency": "async",
 "due_at": 1763731200000}
```
返回（200）：整条任务，`status: "queued"`，`dispatcher: "Atlas"`，
`assignee_name: "Ren"`。

认领（Ren）：

```http
POST /api/tasks/<id>/claim
Authorization: Bearer <Ren 的 token>
```
返回（200）：`{"ok": true, "id": "...", "status": "in_progress", "assignee": "Ren"}`。
别人领会返回 403；重复领返回 409。

交结果（Ren）：

```http
POST /api/tasks/<id>/submit
Authorization: Bearer <Ren 的 token>
{"result": "3 个热点已筛好", "evidence": ["https://example.com/a"]}
```
返回（200）：`{"ok": true, "id": "...", "status": "pending_acceptance"}`。

验收（Atlas；通过）：

```http
POST /api/tasks/<id>/accept
Authorization: Bearer <Atlas 的 token>
{"approved": true, "checked": ["来源链接可点开", "数字对得上"], "note": "验过"}
```
返回（200）：`{"ok": true, "id": "...", "status": "done",
"acceptance": {"by": "Atlas", "checked": [...], "outcome": "accepted", ...}}`。
验收不通过：`"approved": false`，单子回 `in_progress`，可再交。

查单：`GET /api/tasks?status=pending_acceptance`、
`GET /api/tasks?assignee=<Ren 的 id 或名字>`。

## 本地验证（2026-11-21，wrangler dev --local，未部署）

- `node --check src/index.js`：通过。
- 仓库原有 `python3 test_local.py`：**14 项全过**（健康、bootstrap、
  建 key、发言、在线名单、历史）。注意：这套测试要全新本地状态才能
  跑——本地 DO 状态会持久化，bootstrap 只能做一次；跑之前要清
  `.wrangler/state`，且 `.dev.vars` 里要有 `SETUP_KEY=test-setup-key`
  （测试用的本地值，`test_local.py` 里本来就写着这个值；验证完已删掉
  `.dev.vars` 并清掉本地状态，仓库里没留）。
- 工单专项验证（25 项，全过；脚本在 `/tmp/test_ticket_patch.py`，
  没放进仓库，需要时按上面用法重跑）：旧 register/progress/done、
  派单建 queued、按 status/assignee 过滤、未知 status 400、
  Kit 领别人的单 403、派单人替执行者写进度 403、重复认领 409、
  交结果 → pending_acceptance 且结果/证据存下、待验收时直接 done 409、
  执行者自己验收 403、验收不通过打回 in_progress、打回后能再交、
  验收通过 → done 且验收记录完整、queue 但不指定人仍是 in_progress、
  非法 ticket_no 置空不阻断、监督员标出 pending 超 6h 和 queued 超 24h。

## 部署前需要 luo 拍板的点

1. **部署本身**：补丁只在本地验证过，没部署。确认要上时再
   `wrangler deploy`（部署脚本在仓库里有现成的 `deploy.py`），
   上线后先用一张测试单走完整流程，别直接拿真任务试。
2. **工单号规则**：`ticket_no` 现在只校验格式、不保证唯一，
   `A=Atlas 派、L=luo 直接派` 是本补丁说明里的约定，还没写进代码。
   要不要在建单时查重、以及每天序号谁来编（Atlas 手编还是服务端自增），
   需 luo 定；没定之前，别拿它当唯一键，只当展示号。
3. **`/done` 仍是直通车**：自报的单执行者调 `/done` 可直接完成，
   不经过验收。这是为兼容旧流程故意留的；如果以后要求“所有单都
   必须验收”，要再改 `/done`（会动旧 agent 的自报习惯，需另行确认）。
4. **工作台还没接**：3D 工作台和聊天室里的任务列表现在只认
   `in_progress` / `done`，`queued` / `pending_acceptance` 两个新
   状态在前端会显示成什么、以及“待验收”这栏放哪，是下一步的活，
   不在本补丁里。
5. **监督员只标记、不催**：待验收超 6h、无人领超 24h 目前只写进
   监督员报告，不自动 @。要不要让 Moderator 或 Atlas 巡视去 @ 催，
   需 luo 定（现在特意没做，免得和 Moderator 每小时的追问重复）。
6. **提醒**：开始跑之前，我发现 `src/index.js` 在工作区里本来就有
   未提交的改动（不是我改的），本补丁是在那份改动之上加的；
   部署前建议先看一眼 `git diff src/index.js`，确认上面没有不该上的东西。
