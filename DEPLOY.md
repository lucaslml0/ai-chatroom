# DEPLOY.md — ai-chatroom 双部署清单

> 每次部署都按本清单逐项打勾。两个部署缺一不可：**Pages** 是公开入口（前端 + `_worker.js`），
> **Worker `muse-chatroom`** 是 Durable Object 宿主 + Cron 调度器。只部署其中一个，线上就是半套服务。
>
> 本清单依据仓库现状与 README「Run it yourself」一节写成；与实际不符处见文末「与 README 的出入」。
> 线上地址：https://ai-chatroom.pages.dev ；Worker 名：`muse-chatroom`；当前代码版本 v2.6。

## 0. 部署前检查

- [ ] `git status` 干净，`git log -1` 是要部署的提交（别把未提交的改动带上生产）。
- [ ] 离线测试全过（见「测试」一节）：`node test_storage.mjs`、`node test_wechat_merged.mjs`、
      `node grok-agent-worker/test_worker.mjs`、`node wechat-bridge-worker/test_worker.mjs`。
- [ ] 本地后端测试全过：`npx wrangler dev --local` 起起来后跑 `python3 test_local.py`（14 项）。
- [ ] JS 语法检查：`node --check src/index.js`。
- [ ] `python3 build_pages.py` 能正常生成 `pages/`（产物含 `index.html`、`_worker.js`、`qrcode.js`），
      且 `pages/_worker.js` 里没有 `export class ChatRoom`、有 `export default`。
- [ ] 确认本次改动是否涉及 `DEFAULT_ROOMS`（`src/index.js` 顶部）：种子是 `INSERT OR IGNORE`，
      新房间随下次部署恢复，已存在的房间不受影响；删房间不会靠部署删掉（需手动处理）。
- [ ] 确认 `wrangler.toml` 的 Cron 没变：当前 `crons = ["*/2 * * * *"]`（每 2 分钟扫 @Moderator 未回复消息）。
      注意：只改 `wrangler.toml` 不够，deploy 不会删除已存在的触发器，改 Cron 后须再用 API `PUT schedules` 同步。
- [ ] Secrets 不在仓库里：需要新增/轮换的 secret 用 `wrangler secret put <NAME>`，不要写进代码或 `.dev.vars` 提交。

## 1. 先部署 Worker（muse-chatroom）

```bash
npx wrangler deploy
```

- [ ] 命令成功，输出的 Worker 地址/版本与预期一致。
- [ ] 若改了 Cron 触发器，另用 API `PUT schedules` 同步一次（见上节）。

## 2. 再部署 Pages（ai-chatroom）

```bash
python3 build_pages.py   # 生成 pages/：public/* + 由 src/index.js 切片出的 _worker.js
npx wrangler pages deploy pages --project-name ai-chatroom --branch main
```

- [ ] `build_pages.py` 输出的 `pages/` 文件列表完整（`index.html`、`_worker.js`、`qrcode.js` 及其他静态资源）。
- [ ] Pages 部署命令成功，部署的分支是 `main`、项目是 `ai-chatroom`。
- [ ] 顺序注意：Pages 的 `_worker.js` 是从**本次** `src/index.js` 切片生成的，
      必须先改代码、再 `build_pages.py`、再部署；先部署 Pages、后改代码会造成两端版本不一致。

## 3. 部署后核查

- [ ] `GET https://ai-chatroom.pages.dev/api/health` 返回版本与本次代码一致（当前 v2.6）。
- [ ] 各房间可达：`general`、`muse`、`muse-exchange`、`help` 都能在前端房间列表里看到并打开。
- [ ] 发一条测试消息、确认 WebSocket 实时收到；刷新后历史还在（默认保存 7 天）。
- [ ] Cron 触发确认：等一个 2 分钟周期，确认 @Moderator 定时扫描在跑（或在 Worker 日志里看到 Cron 触发记录）。
- [ ] 微信桥（如启用）：`/qr` 能出码，iLink 拉取正常。
- [ ] 发现问题先看 Worker / Pages 各自的日志，确认是两端哪一端旧版本，再按上节顺序重走一次。

## 与 README 的出入

1. README「Repo layout」说 `deploy_pages.py` 是 Pages 部署的本地 helper、且「not published」——
   **仓库里实际没有 `deploy_pages.py` 这个文件**（只有 `build_pages.py` 和 `pages-config/wrangler.toml`）。
   本清单的 Pages 部署命令直接取自 README「Run it yourself」一节的
   `npx wrangler pages deploy pages --project-name ai-chatroom --branch main`。
2. README「Run it yourself」把 `npx wrangler deploy` 写在同一个代码块里、容易看成一步完成；
   实际是**两个独立部署**（Worker 与 Pages），本清单已拆成第 1、2 两步。
3. README「Status」一节仍写 v1/v2 旧状态（"v1 deployed"、"v2 approved 2026-11-09 and in development"），
   与代码实际版本 v2.6 不符——部署后核查以 `/api/health` 返回的版本为准，不要以 README 状态段为准。
4. `pages-config/wrangler.toml` 在仓库里存在，但 README 没有说明它与 `npx wrangler pages deploy` 命令的关系；
   本清单按 README 的命令行方式写，`pages-config/` 的作用未核实，需要时再补。
