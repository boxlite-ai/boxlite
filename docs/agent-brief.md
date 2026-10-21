> **历史文档：2026-10-21 的一日交接简报，不再描述现状。** 已过时的内容：应用网址不再是 `<CP>/<app>/` 路径前缀，每个环境有自己的源（`BOXLITE_APP_URL`）；`?__key=` 已删除，私有 App 用控制台 **Open app** 的一次性票据，agent 用 `Authorization: Bearer`；终端用户登录已实现，平台 cookie 在 https 上是 `__Host-bxl_*`、`Path=/`，不按路径隔离。现状以 `agent/SKILL.md`、`docs/contracts.md`、`docs/architecture.md` 为准。

你接手 BoxLite Micro-cloud 原型的研发和交付。目标：用户在 BoxLite 控制台建一个 App，复制提示词交给自己本地的 coding agent，之后 agent 独立把一个完整的应用（数据库、文件存储、登录、部署、回滚）搭在 BoxLite Cloud 上，用户在控制台里看到它在运行，能查看和操作它的数据库。这是真实可用的产品，不是 mock。

## 完成的定义（全部满足才算交付）

在 dev 环境上，按用户视角走完下面 6 步，每一步都要有证据（截图、命令输出或 SQL 结果）：
1. 在控制台 Apps 页点 New App，只填名字，创建成功；Overview 上出现含 App key 的提示词，可一键复制。
2. 把提示词加一句需求交给一个全新的 agent 会话（`claude -p "<提示词>" --dangerously-skip-permissions --output-format stream-json --verbose`，在空目录里跑），之后人不再介入。
3. agent 只靠提示词、`<CP>/agent.md` 和 `boxlite-app` CLI 完成：初始化、开数据库/卷/登录、迁移、部署、自验、回报网址。
4. 打开 agent 回报的网址（登录过控制台的浏览器直接能开，不需要拼 `?__key=`），需求里的每个功能都能用，数据写进了数据库。
5. 控制台里该 App 显示 Running；Deployments 能看到 agent 的每次部署和回滚；Logs 能看到运行日志和 Activity；Services 能看到服务状态。
6. Database 页签能看表、翻数据、在 SQL console 执行查询；Volumes 能看到文件；Variables 能看到变量；Auth › Users 能看到登录过的用户。

用下面 5 句需求各跑一遍第 2–6 步，全部通过：
- “做一个 Markdown 笔记应用，先不用登录”
- “做一个记账应用，数据要能保存”
- “做一个图片墙，可以上传照片”
- “做一个带 GitHub 登录的待办应用，每个人只看到自己的”
- “做一个博客，任何人能看，只有我能登录写文章”

agent 在哪一步卡住或绕路，先改 `agent/SKILL.md`，改不了再改产品；改完重跑同一句需求，直到它零介入通过。单元测试通过不等于完成。

## 先读这些（按顺序）

1. `docs/contracts.md`：三个程序之间的接口，规范性文档。
2. `docs/decisions.md`：已做的决策和理由。你新做的决策追加在末尾，一行一条，写日期和理由。
3. `agent/SKILL.md`：agent 实际读的说明（CP 以 `/agent.md` 提供）。
4. PRD（Notion，只读）：https://app.notion.com/p/PRD-Micro-cloud-3ff8d8d9717981a4af02e4d2411a89dc 。产品行为以它为准；和代码冲突时以 PRD 为准，并记进 decisions.md。不要编辑这个 Notion 页面，用户在上面直接改。

## 仓库和环境

- 原型仓库 `~/CodeProject/boxlite-microcloud`（pnpm workspace）：
  - `supervisor/`：Go，跑在每个应用 Box 里，负责构建、启停服务、健康检查、网关、日志。
  - `control-plane/`：TypeScript，Node 22，sqlite，跑在 Box `microcloud-cp` 里。
  - `shared/` + `cli/`：`boxlite-app` CLI。
  - `agent/`：SKILL.md 和提示词模板。
  - `deploy/deploy-cp.sh`：一键构建并部署控制面，地址不变。
- 控制面地址：https://8080-d-76416e6f374b4352547a7a68.proxy.dev.boxlite.ai 。管理员令牌在 `.cp-admin-token`。线上已有测试 App：`hello`、`ledger`。
- 密钥只在 `.env.local`（权限 600、gitignored）：`BOXLITE_API_KEY`（dev，含 boxes/volumes 权限）、`NEON_API_KEY`、`NEON_ORG_ID`、`GITHUB_CLIENT_ID/SECRET`。不要打印、不要提交、不要写进其他文件。
- 控制台前端：git worktree `~/CodeProject/boxlite_repo/boxlite-micro-cloud-app`，分支 `micro-cloud-console`（基于 `micro-cloud-app`），由 `deploy/build-console.sh` 构建到 `console-dist/`，CP 在 `/console/` 提供。提交用 `git -c user.name=Mandalorian-Wang`，邮箱沿用该仓库 git log 里的作者邮箱，提交信息末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不要 push，不要动 boxlite 主仓库其他分支。

## 已经实测过的事实（不要再踩）

- BoxLite REST 在 `https://api.dev.boxlite.ai/v1`。所有不带 body 的 POST 必须带 `Content-Length: 0`，否则 411。卷按名字挂载、按 id 删除，按名字删返回 404。卷只能在建 Box 时挂载，改卷就得重建 Box。`/v1` 不支持只读挂载。
- 镜像只能用 `ghcr.io/boxlite-ai/boxlite-agent-{base,python,node}:v0.1.0`，x86_64，Node 22，用户 `boxlite`。Box 每次启动都会以 PID 1 重新执行 `cmd`；`$HOME` 保留，`/tmp` 清空。最大可以开 4 核 / 8 GB / 10 GB 磁盘。
- Box 的 tunnel 是公网可达的，所以进应用 Box 的每个请求都必须带 `X-BoxLite-Gateway`。
- Neon 是 free 组织：按时间点恢复只覆盖 6 小时；一次 restore 约 5 分钟；建项目的响应里默认分支在 `branch`（单数）；连接串用 `sslmode=verify-full`。
- ~~应用网址是 `<CP>/<app>/` 路径前缀（用户决定，不用独立域名），所以 agent.md 要求应用用相对链接。~~ 已过时：每个环境一个源，应用在源的 `/` 下（`decisions.md` 2026-10-21“One origin per app env”）。
- GitHub OAuth App 的唯一回调地址是 `<CP>/auth/callback/github`，所有 App 共用，state 里带 app 和 env。Google 还没注册。
- 一次完整部署约 15 秒；休眠后被访问时显示“Starting…”，约 6 秒恢复；回滚约 10 秒。以上都已实测通过。

## 剩下的工作

1. **控制台接真实接口（做了一大半，未提交）**：worktree 里有未提交的前端改动，CP 侧有 `routes/console.ts`、`console-views.ts`、`console-auth.ts`、`console-access.ts`，截图在 `docs/console-shots/`。先读懂现状再续写，所有页签的数据都来自 CP，缺数据就隐藏，不许编数字。登录过控制台的人打开私有 App 不需要 `?__key=`。保持控制台现有设计语言（`components/ascii.tsx`、`ui/tabs` 分段样式、Volumes 表格样式），不许重新设计样式。
2. **终端用户登录（已完成，见 `contracts.md` §3 与 4.1 “End-user sign-in”）**：按 PRD 3.8 “情况一”实现：
   - `/.boxlite/auth/login|logout|me|jwks.json`（当时写作 `<prefix>/…`，现在在每个环境自己的源上），GitHub OAuth 带 PKCE 和签名 state。
   - 会话 cookie ~~按 App 路径隔离~~（已过时：每个源一个 host-only 的 `__Host-bxl_session`，`Path=/`）；用户池按环境区分；用户镜像写进应用库的 `boxlite.users`，提供 `boxlite.current_user_id()`。
   - 代理注入 `X-BoxLite-User-*` 和 RS256 的 `X-BoxLite-Identity`，并剥掉外部伪造的同名头。
   - `[auth].protect` 路径未登录时，浏览器请求 302 跳登录页，接口请求返回 401。
   - 支持封禁和踢下线；提供 `test-session` 让 agent 自验。
   - CLI 加 `app auth …` 命令；`init` 默认写入 `[auth] providers = ["github", "google"]`，没配置的 provider 只给警告。
   - 同步更新 SKILL.md 第 8 条和第 5 节。
3. **部署并验收**：`deploy/deploy-cp.sh` 加 `deploy/build-console.sh`，然后按上面“完成的定义”跑 5 句需求。
4. **交付报告**：写在 `docs/acceptance.md`。每句需求一节，包含 agent 用时、部署次数、它卡在哪、你改了什么、6 个检查点的证据（截图放 `docs/acceptance-shots/`）。最后列出已知限制。

## 工作方式

- 每改一处就部署到 dev 真跑一遍，再往下做。不要攒一大批改动最后一起验。
- 独立的工作可以开子 agent 并行（例如控制台和登录），给它们明确的文件边界；两边都要改的文件（例如 `routes/proxy.ts`），要求只加最小的调用点。
- 工程上越简单越好：能复用 BoxLite 现有能力就不自己造，能少一个进程就少一个。
- 测试中创建的资源（Box、卷、Neon 项目）用完就删，只保留验收用的 App。
- 遇到平台缺陷（例如 BoxLite API 的 bug），先绕过并记进 decisions.md，不要停下来等。

## 只在这些情况停下来问用户

- 产品决策：例如要不要把某个 App 改成公开，或者 PRD 没覆盖、两种做法会让用户看到不同结果。
- 只有人能做的事：用自己的 GitHub 账号在浏览器里真实登录一次。你不能输入密码；请用户在内置浏览器面板里点授权，再继续。
- 会花钱或不可逆的操作：升级 Neon 套餐、删除用户自己建的资源。

其他一律自己决定并记录。最终回报用中文，先写结论（6 个检查点 × 5 句需求的通过情况），再写证据位置和已知限制。
