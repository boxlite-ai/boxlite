# `apps/` 全量详细解读

本文档对 `apps/` 下每个子项目做源码级讲解。**速览图**与**职责拆分**见 [apps-overview.md](./apps-overview.md);本文聚焦"每个 app 内部是什么"。

> 仓库管理:Nx workspace(`apps/nx.json` + 每项目 `project.json`)+ Go workspace(`apps/go.work`)+ Yarn Berry(`apps/.yarnrc.yml`)。所有 Go module 命名空间 `github.com/boxlite-ai/*`。

---

## 1. `apps/api` — 控制面核心(NestJS)

| 维度 | 内容 |
|---|---|
| 框架 | NestJS 11 + Express + TypeORM 0.3 + Postgres + Redis + ClickHouse + ioredis + nestjs-pino |
| 形态 | Docker 容器,默认端口 `:3000` |
| 入口 | `src/main.ts`,主装配在 `src/app.module.ts` |

### 顶层模块结构(`src/`)

```
admin/    analytics/  api-key/  audit/  auth/  boxlite-rest/  clickhouse/
common/   config/     docker-registry/   email/   encryption/   exceptions/
filters/  health/     interceptors/      notification/   object-storage/
openapi.config.ts     organization/      region/  sandbox/  sandbox-telemetry/
usage/    user/       webhook/           main.ts  tracing.ts   generate-openapi.ts
```

每个模块严格五件套(Module / Controller / Service / Entity / DTO),细节见 [`apps-api-overview.md`](./apps-api-overview.md)。

### 关键横切

- **认证**:`auth/CombinedAuthGuard`(OIDC token via Dex OR 长期 API Key);`OrganizationResourceActionGuard` 做 RBAC。
- **审计**:自家 `@Audit` 装饰器 → `AuditModule` 落审计表。
- **限流**:`@nestjs/throttler` + Redis 存储 + `FailedAuthRateLimitMiddleware`。
- **缓存**:TypeORM 二级缓存走 Redis;鉴权链路另外做 key 校验缓存(Service 里手动 `redis.del`)。
- **事件**:`@nestjs/event-emitter` + 自家 `@OnAsyncEvent`(支持事务感知)。
- **OpenAPI**:`@nestjs/swagger` + `generate-openapi.ts` 导出 `dist/apps/api/openapi.json`,驱动所有客户端生成。
- **追踪**:`tracing.ts` 装配 OTel(`@opentelemetry/instrumentation-{pg,ioredis,pino}`)→ `apps/otel-collector`。

### 数据访问

- 运行时:`TypeOrmModule.forRootAsync`(`app.module.ts:72-106`),`autoLoadEntities: true`。
- 迁移:三个独立 DataSource(`migrations/{,pre-deploy/,post-deploy/}data-source.ts`),Nx target `migration:generate` / `migration:run:*`。

---

## 2. `apps/dashboard` — 用户控制台 SPA

| 维度 | 内容 |
|---|---|
| 框架 | React + Vite + TypeScript + Tailwind |
| 形态 | 静态资产;`api` 通过 `@nestjs/serve-static` 托管 `dashboard/`(见 `app.module.ts:116-123`),CDN 上也通过 CloudFront 发布 |

### 入口与组织

- `index.html` + `src/main.tsx` + `src/App.tsx`
- `src/pages/` — 路由级页面:`Dashboard.tsx`、`Keys.tsx`、`Runners.tsx`、`Regions.tsx`、`Registries.tsx`、`OrganizationMembers.tsx`、`OrganizationRoles.tsx`、`OrganizationSettings.tsx`、`AccountSettings.tsx`、`AuditLogs.tsx`、`Limits.tsx`、`LinkedAccounts.tsx`、`Playground.tsx`、`Onboarding.tsx`、`EmailVerify.tsx`、`Callback.tsx`、`Logout.tsx`、`Experimental.tsx`、`LandingPage.tsx`、`NotFound.tsx`
- `src/{components,hooks,contexts,providers,services,types,enums,mocks}` — 常见前端结构
- `src/api/` + `src/billing-api/` — 调 `apps/api` 用 `libs/api-client`(TS,同样 OpenAPI 生成)

### 与控制面的关系

Dashboard 调的是 **`libs/api-client`(TS)**,跟 `apps/api-client-go`(Go)是同一份 OpenAPI 生成的兄弟客户端。

---

## 3. `apps/dex` — OIDC 身份提供方

| 维度 | 内容 |
|---|---|
| 形态 | 容器,基于上游 [Dex](https://dexidp.io/) |
| 内容 | `config.yaml` + `Dockerfile` + `entrypoint.sh`,**只装配置**,不写代码 |

### 关键点

- `issuer: ${DEX_ISSUER}` — 由环境变量注入,部署时 SST 填入。
- `storage: { type: sqlite3, file: /var/dex/dex.db }` — 单节点本地存储(适合中小规模)。
- 给 `apps/api` 提供 OAuth2/OIDC 接入点;`apps/api/src/auth/` 用 `openid-client` 验签。
- 部署时 SST 把 Dex 放在 `:5556`(`infra/sst.config.ts:PORTS.DEX`)。

---

## 4. `apps/proxy` — HTTP 边缘反代

| 维度 | 内容 |
|---|---|
| 模块 | `github.com/boxlite-ai/proxy` |
| 框架 | Go 1.25 + Gin + `common-go/pkg/{cache,proxy,errors}` |
| 端口 | `:4000`(`infra/sst.config.ts:PORTS.PROXY`) |

### 入口

`cmd/proxy/main.go`(~70 行):读 envconfig → 启动 `proxy.StartProxy(ctx, cfg)` → SIGINT/SIGTERM 做去抖优雅停机(连按两下强退)。

### 核心包 `pkg/proxy/`

| 文件 | 职责 |
|---|---|
| `proxy.go` | Gin 主服务,装配中间件 + 路由 |
| `auth.go` | Bearer / Cookie 鉴权,跟 `api` 校验 token |
| `auth_callback.go` | OAuth 回调处理 |
| `get_sandbox_target.go` | 解析 sandbox URL → 找到对应 runner 后端 |
| `get_sandbox_build_target.go` | 构建日志专用反代 |
| `get_snapshot_target.go` | snapshot manager 反代 |
| `retry.go` | 失败重试 |
| `warning_page.go` | 不安全 sandbox 内容的拦截警告页 |

### 典型流量

```
浏览器 → https://22222-<sandboxId>.boxlite.io
              │
              ▼
       apps/proxy (Gin)
   - 鉴权 cookie / API key
   - 查 api 拿 runner 地址 + sandbox 路由信息
   - 反代到 runner 上的 sandbox 端口
   - 缓存映射(common_cache)
```

支持 **签名预览 URL**(由 `api` 颁发,proxy 验签)、**WebSocket 升级**、**CORS**(`gin-contrib/cors`)。

---

## 5. `apps/ssh-gateway` — SSH 边缘反代

| 维度 | 内容 |
|---|---|
| 模块 | `github.com/boxlite-ai/ssh-gateway` |
| 端口 | `:2222`(默认) |
| 大小 | 单文件 `main.go`,~几百行 |

### 用法(`README.md`)

```bash
ssh -p 2222 <SSH_ACCESS_TOKEN>@<gateway-host>
```

### 工作原理

1. **Username 即 token**:gateway 拿 `<token>` 调 `apps/api` 的 `validateSshAccess` 端点。
2. **拿到目标 runner 信息** + 沙箱内的 SSH **keypair**。
3. **拨号到 runner 的 2220 端口**(runner 的 sshgateway),凭密钥登入。
4. **双向转发**会话(`golang.org/x/crypto/ssh.NewClient/Session/Channel`)。

不存任何状态,完全靠 `api` 做 token → sandbox 映射。

---

## 6. `apps/snapshot-manager` — 私有 Docker Registry

| 维度 | 内容 |
|---|---|
| 模块 | `github.com/boxlite-ai/snapshot-manager` |
| 框架 | `github.com/distribution/distribution/v3`(Docker 官方 registry 库) |
| 端口 | `:5000` |

### 入口

`cmd/main.go` + `internal/{config,logger,server}`(总共 ~6 个 Go 文件)。

### 实现要点(`internal/server/server.go`)

```go
import (
  "github.com/distribution/distribution/v3/configuration"
  "github.com/distribution/distribution/v3/registry/handlers"
  _ "github.com/distribution/distribution/v3/registry/auth/htpasswd"
  _ "github.com/distribution/distribution/v3/registry/storage/driver/filesystem"
  _ "github.com/distribution/distribution/v3/registry/storage/driver/s3-aws"
)
```

- 把官方 `handlers.App` 包成 `http.Server`,生命周期接 `context.Context`。
- **存储**:`filesystem`(开发)或 **S3**(生产,SST 自动配 IAM)。
- **鉴权**:`htpasswd` 文件;凭据由 `apps/api/src/docker-registry/` 颁发与轮换。
- **客户**:runner 在 `BuildSnapshot` / `PullSnapshot` 时通过 Docker SDK 与本地 registry 对接。

---

## 7. `apps/runner` — 沙箱调度执行节点

| 维度 | 内容 |
|---|---|
| 模块 | `github.com/boxlite-ai/runner` |
| 框架 | Go 1.25 + Gin + Docker SDK + 自家 `boxlite` 后端 + Prometheus + OTel |
| 端口 | `:3003`(API),`:2220`(SSH inner gateway) |
| 部署 | 容器 **或** 直接跑在 EC2 上(嵌套 KVM,需要 `c8i.2xlarge` 等支持 nested 的机型) |

### 顶层目录

```
cmd/runner/         # main + config
internal/           # buildinfo / metrics / util / constants
pkg/
  api/              # Gin HTTP 控制面(server.go + controllers/ + middlewares/)
  apiclient/        # 调 apps/api 的封装
  backend/          # SandboxBackend 接口(Docker / BoxLite 两实现)
  boxlite/          # BoxLite microVM 后端(走 sdk-go → libkrun)
  cache/            # 内存缓存
  common/           # 错误、辅助
  daemon/           # 拉取 / 嵌入 daemon 二进制
  models/           # 内部领域模型 + enums
  runner/           # v1 入口 + v2 架构
    runner.go
    v2/
      poller/       # 从 api 拉作业
      executor/     # 真正干活的 worker(create/start/stop/backup/destroy)
      healthcheck/  # 健康上报
  services/         # 业务服务(snapshot pull、metrics 上报)
  shellutil/        # shell 包装
  sshgateway/       # 内嵌 :2220 SSH 跳板(被 apps/ssh-gateway 转发到这里)
  storage/          # 本地 metadata 存储
  telemetry/        # 过滤器与 OTel 装配
```

### HTTP 路由(`pkg/api/server.go`)

被 `apps/api` 与 `apps/proxy` 调:

```
GET    /                              # health
GET    /api/*any                      # Swagger UI
GET    /metrics                       # Prometheus
GET    /info                          # runner 元数据

POST   /sandboxes                     # create
GET    /sandboxes/:id                 # info
POST   /sandboxes/:id/start | stop | destroy | backup | resize | recover
POST   /sandboxes/:id/is-recoverable
POST   /sandboxes/:id/network-settings

POST   /snapshots/pull | build | tag | remove | inspect
GET    /snapshots/exists | info | logs

# BoxLite microVM API(v1/boxes)
POST   /v1/boxes/:boxId/exec
GET    /v1/boxes/:boxId/executions/:execId        (+ /attach)
DELETE /v1/boxes/:boxId/executions/:execId
POST   /v1/boxes/:boxId/executions/:execId/signal | resize
PUT    /v1/boxes/:boxId/files                     # upload
GET    /v1/boxes/:boxId/files                     # download
GET    /v1/boxes/:boxId/metrics
```

### v2 架构(关键)

- **`poller`** — 周期性拉作业(避免 webhook 在 NAT 后失败)
- **`executor`** — 执行,内部按 `SandboxBackend` 抽象:
  - **Docker 后端** — 传统容器沙箱
  - **BoxLite 后端**(`pkg/boxlite/`) — 通过 `libs/sdk-go` 与 libkrun microVM 对接,nested KVM
- **`healthcheck`** — 心跳 + 节点容量上报
- 后端切换让同一个 runner 既能跑 Docker 也能跑 microVM(BoxLite 项目名同时来源于此)。

### 与 `apps/daemon` 的关系

Runner 创建容器/VM 时,把预编译的 `daemon` 二进制注入到镜像中,作为 PID 1 启动,并通过 env 注入 `SandboxId`/`OrganizationId`/`OtelEndpoint`。

---

## 8. `apps/daemon` — 沙箱内部 agent

| 维度 | 内容 |
|---|---|
| 模块 | `github.com/boxlite-ai/daemon` |
| 框架 | Go 1.25 + Gin + gliderlabs/ssh + go-git + go-plugin + OTel |
| 端口 | Toolbox(动态)、Terminal `:22222`、SSH、Recording Dashboard |
| 形态 | 二进制,被打入 sandbox 镜像作为 entrypoint |

### `cmd/daemon/main.go` 启动的 4 个服务

1. **Toolbox Server**(Gin)— 主菜
2. **Terminal Server** `:22222` — WebSocket 终端
3. **Recording Dashboard** — computer-use 录屏回放面板
4. **SSH Server** — gliderlabs/ssh 实现的内置 sshd

外加 **entrypoint session**:`daemon <cmd...>` 把 entrypoint 作为异步 session 跑,日志写 `~/.boxlite/sessions/<entrypointId>/output.log`,`daemon entrypoint logs` 可读。

### Toolbox API 路由(`pkg/toolbox/server.go`,~68 个操作)

| 路由组 | 干什么 |
|---|---|
| `/files` | 列目录 / 下载 / 上传 / 搜索 / 移动 / 权限 / 替换 / 删除(含批量) |
| `/process/execute` | 一次性执行 |
| `/process/session/*` | 持久 shell 会话(多命令复用,带 input/logs) |
| `/process/pty/*` | PTY(WebSocket connect + resize) |
| `/process/interpreter/*` | Jupyter-like Python/Node 解释器(context 创建/执行/删除) |
| `/git/*` | clone / status / branches / checkout / commit / push / pull / add / history(`go-git`) |
| `/lsp/*` | LSP server 子进程管理 + JSON-RPC 转发 |
| `/computeruse/*` | screenshot / mouse / keyboard / display / window / 进程管控 |
| `/computeruse/recordings/*` | 录屏 start/stop/list/download |
| `/port` | 沙箱内部端口侦测 |
| `/proxy` | 端口代理 |

### 关键 pkg

```
pkg/session/               长生命周期 shell session 管理
pkg/ssh/                   gliderlabs SSH server
pkg/terminal/              浏览器 WebSocket 终端
pkg/toolbox/computeruse/   桌面自动化(LazyCheckMiddleware 按需启动)
pkg/toolbox/lsp/           LSP 子进程 + JSON-RPC
pkg/toolbox/process/{session,pty,interpreter}/  三种执行模式
pkg/recording/ + pkg/recordingdashboard/        录屏与回放
pkg/git/, pkg/gitprovider/                      git 操作
```

`apps/daemon` 是 `apps/api-client-go.ToolboxAPI` 的**服务端**。

---

## 9. `apps/otel-collector` — 观测数据汇聚

| 维度 | 内容 |
|---|---|
| 形态 | OpenTelemetry Collector 自定义发行版,通过 `ocb`(OTel Collector Builder)从 `builder-config.yaml` 构建 |
| 入口 | 容器镜像;`config.yaml` 是 pipeline 配置 |

### 目录

```
otel-collector/
├── builder-config.yaml     # 生产构建用 ocb 配置
├── builder-config.dev.yaml # 本地开发
├── config.yaml             # pipeline(receivers / processors / exporters)
├── config.dev.yaml
├── Dockerfile              # 多阶段:node + go;打包 Yarn workspace + go.work
└── exporter/               # 自家 OTel exporter(Go module)
    ├── exporter.go
    ├── factory.go
    ├── config.go
    └── internal/
```

### 自家 `exporter/`

是一个 **OTel Collector exporter 组件**(实现 `component.Exporter`),作用:把指标/日志推回 `apps/api`(或 ClickHouse),用 `api-client-go` 调用。下游模块依赖它:

```
runner / daemon / api / proxy / ssh-gateway / snapshot-manager
       │   OTLP
       ▼
  apps/otel-collector
       │  含自家 exporter
       ▼
  Jaeger UI(:16686) / apps/api / ClickHouse
```

---

## 10. `apps/cli` — `boxlite` 终端二进制

| 维度 | 内容 |
|---|---|
| 模块 | `github.com/boxlite-ai/boxlite/cli` |
| 框架 | Go 1.25 + Cobra + bubbletea(TUI)+ OAuth2 + Docker SDK + mcp-go |
| 发布 | 二进制(Homebrew tap、GitHub Releases) |

### 顶层结构

```
main.go              # rootCmd 装配 + 子命令
cmd/                 # cobra 命令树
  auth/              # login / logout(OAuth 设备流)
  sandbox/           # create / delete / info / list / start / stop / archive / exec / ssh / preview_url
  snapshot/
  volume/
  organization/
  mcp/               # MCP server 子命令
  common/            # 共享 helpers
  autocomplete.go / docs.go / generatedocs.go / version.go
apiclient/
  api_client.go      # GetApiClient() 工厂:profile + token 刷新 + 版本校验 transport
  error_handler.go
auth/                # token 持久化 + 刷新
config/              # ~/.boxlite/config.json profile
docker/              # 本地 build/push(用于 snapshot create)
toolbox/             # 直接对 sandbox toolbox 的 streaming 调用(exec/ssh/computer-use)
mcp/                 # MCP server 实现(把 BoxLite 暴露给 Claude/IDE)
views/               # bubble tea 表格/进度
pkg/, util/, hack/   # 工具与脚本
docs/                # 自动生成的 CLI 文档
```

### 关键点

- **跟 `api-client-go` 的关系**:`apiclient/api_client.go` 包了一层 profile / token 自动刷新 / 版本不匹配警告(`versionCheckTransport`),输出 `*apiclient.APIClient` 给所有 cmd 用。
- **MCP server**:`boxlite mcp` 把 sandbox 能力暴露成 MCP 协议,Claude Code 等 IDE 可直接挂载。
- **快捷命令**:`boxlite create/delete/start/...` 是 `sandbox create/...` 的顶层 alias(`main.go:createSandboxShortcut`)。

---

## 11. `apps/api-client-go` — 自动生成 Go 客户端

| 维度 | 内容 |
|---|---|
| 模块 | `github.com/boxlite-ai/boxlite/libs/api-client-go` |
| 来源 | **完全由 OpenAPI Generator 自动生成**(`Code generated; DO NOT EDIT`) |
| 内容 | 19 Service + 177 Model + 11 基础设施 + `api/openapi.yaml`(总 207 个 `.go`) |

详见 [`api-client-go.md`](./api-client-go.md)。

### 生成流水线(`project.json:generate:api-client`)

```bash
# 上游
nx run api:openapi              # dist/apps/api/openapi.json

# 本项目
rm -f libs/api-client-go/*.go
yarn run openapi-generator-cli generate -g go \
  -i dist/apps/api/openapi.json \
  --additional-properties=packageName=apiclient,generateInterfaces=true,...
bash hack/go-client/postprocess.sh
```

### 下游联动(`project.json:set-version`)

发版同步更新 `apps/cli`、`libs/sdk-go`、`apps/otel-collector/exporter` 的 `go.mod`。

---

## 12. `apps/common-go` — 通用 Go 工具库

| 维度 | 内容 |
|---|---|
| 模块 | `github.com/boxlite-ai/common-go` |
| 用户 | `daemon`、`runner`、`proxy`、`ssh-gateway`、`snapshot-manager`、`otel-collector/exporter` |

### 包

```
pkg/cache/      # 通用缓存接口(LRU / Redis 封装)
pkg/errors/     # 标准错误类型 + HTTP 映射
pkg/log/        # slog handler(tint 彩色 + 文件 + multi-handler) + ParseLogLevel + DebugLogWriter
pkg/proxy/      # 反代/请求转发辅助
pkg/telemetry/  # OTel 初始化(InitLogger / InitTracer / InitMetric + Shutdown)
pkg/timer/      # 计时器/速率/退避
pkg/utils/      # 一杂烩
```

### 为什么单独抽

跨服务统一日志/遥测/错误形态,避免每个 Go module 各写一份。

---

## 13. `apps/infra` — AWS 部署(SST IaC)

| 维度 | 内容 |
|---|---|
| 框架 | SST(`@serverless-stack`)+ TypeScript |
| 入口 | `sst.config.ts` |

### 部署蓝图(`sst.config.ts` 头部注释)

```
BoxLite 控制面在 AWS (ap-southeast-1)。

部署顺序:
  1. secrets (auto-generated)     7. edge services (Proxy, SshGateway)
  2. platform (VPC/DB/Redis/S3)   8. observability (Jaeger, OtelCollector)
  3. IAM                          9. admin UIs (PgAdmin/RegistryUI/MailDev)
  4. auth (Dex)                  10. CDN (CloudFront)
  5. registry (SnapshotManager)  11. runner (EC2 + nested KVM)
  6. API
```

### 端口约定(节选)

```ts
const PORTS = {
  API: 3000,            PROXY: 4000,        SSH_GATEWAY: 2222,
  DEX: 5556,            SNAPSHOT_MANAGER: 5000,
  RUNNER: 3003,         JAEGER_UI: 16686,   OTLP_HTTP: 4318,
  OTEL_HEALTH: 13133,   MAILDEV_UI: 1080,
  PGADMIN: 80,          REGISTRY_UI: 80,
};
```

### 第三方镜像锁定

```ts
const IMAGES = {
  jaeger: "jaegertracing/all-in-one:1.67.0",
  pgadmin: "dpage/pgadmin4:9.2.0",
  registryUi: "joxit/docker-registry-ui:main",
  maildev: "maildev/maildev:latest",
};
```

### Runner EC2

```ts
const RUNNER = { instanceType: "c8i.2xlarge", ... };
```

C8i 系列支持 nested KVM,是跑 BoxLite microVM 后端的前提。

---

## 14. `apps/libs/` — 前端与多语言客户端库

| 库 | 内容 |
|---|---|
| `libs/api-client/` | `apps/api` 的 **TypeScript** 客户端(同样 OpenAPI 生成);Dashboard 在用 |
| `libs/toolbox-api-client/` | `apps/daemon` Toolbox API 的 TS 客户端 |
| `libs/runner-api-client/` | `apps/runner` 的 TS 客户端 |
| `libs/analytics-api-client/` | 分析/计费 API 客户端 |
| `libs/computer-use/` | computer-use 协议层 / TypeScript 适配 |
| `libs/sdk-typescript/` | `@boxlite-ai/sdk` — 面向最终用户的 TS SDK(在上述客户端之上封装) |

> 仓库根目录 `sdks/` 还有 `python/`、`node/`、`c/`、`go/`,那是用户向 SDK(暴露 BoxLite 抽象,如 `Sandbox.exec()`);`apps/libs/` 这边偏向直接对应 OpenAPI 操作的"原始客户端"。

---

## 15. `apps/local-dev/` — 本地开发支撑

空目录(或仅存放脚本/`docker-compose` 文件,根据 SST 的 dev 模式),作为开发者起本地依赖(Postgres、Redis、Dex、Jaeger 等)的入口。

---

## 横向交叉关注点

### A. 服务间通信矩阵

| 调方 → 被调方 | 协议 | 客户端 |
|---|---|---|
| cli/SDK/Dashboard → api | HTTPS | `api-client-go` / `libs/api-client` |
| api → runner | HTTPS | api 内部用 `runner-api-client` |
| proxy → api | HTTPS | `api-client-go` |
| proxy → runner | HTTP / WebSocket | 直接反代 |
| ssh-gateway → api | HTTPS | `api-client-go` |
| ssh-gateway → runner | SSH | `golang.org/x/crypto/ssh` |
| runner → daemon | HTTP(沙箱内 Toolbox) | runner 内部直连 |
| runner → snapshot-manager | Docker registry v2 | Docker SDK |
| 所有 Go 服务 → otel-collector | OTLP | OTel SDK |
| otel-collector → api | HTTPS | 自家 exporter,用 `api-client-go` |

### B. 鉴权三种形态

| 形态 | 路径 | 用途 |
|---|---|---|
| OIDC token(via Dex) | 浏览器/CLI 登录 → token | 主用户身份 |
| **API Key**(`bb_xxx_yyy`) | `Authorization: Bearer <api-key>` | 自动化/CI |
| **SSH access token** | `ssh -p 2222 <token>@gateway` | SSH 入站 |

### C. OpenAPI 自动生成矩阵

```
apps/api          ──swagger──► dist/apps/api/openapi.json
                                │
                                ├──► apps/api-client-go         (Go)
                                ├──► libs/api-client            (TS)
                                └──► sdks/python, node, c       (用户 SDK 上层)

apps/runner       ──swagger──► dist/apps/runner/openapi.json
                                └──► libs/runner-api-client    (TS)

apps/daemon       ──swagger──► dist/apps/daemon/openapi.json
                                └──► libs/toolbox-api-client    (TS)
                                     api-client-go 的 ToolboxAPI 也由 api 聚合后生成
```

### D. Telemetry / 日志栈

- **日志**:NestJS 侧 `nestjs-pino`;Go 侧 `slog` + `lmittmann/tint` + `common-go/pkg/log`(支持 multi-handler 写文件)。
- **OTel**:Trace / Logs / Metrics 三路全推 `otel-collector`,collector 把 trace 落 Jaeger、metrics/logs 走自家 exporter 推回 `api` / ClickHouse。
- **Prometheus**:`runner` 暴露 `/metrics`(promhttp)。

### E. 版本同步

`apps/api-client-go/VERSION` 是真理之源(`v0.159.0` 当前)。Nx target `set-version` 同步写入:
- `apps/cli/go.mod`
- `libs/sdk-go/go.mod`
- `apps/otel-collector/exporter/go.mod`
保证整个 Go 链路始终用同一份 client。

### F. License

- 主体 AGPL-3.0(`apps/LICENSES/AGPL-3.0.txt`)
- 第三方依赖 Apache-2.0(`apps/LICENSES/Apache-2.0.txt`)
- 起源:fork 自 Daytona Platforms,每个文件头都有 `Modified by BoxLite AI, 2025-2026`
- 完整声明见 `apps/NOTICE`

---

## 最小心智模型

如果只能记三件事:

1. **`api` 是大脑**——所有业务逻辑、OpenAPI 单一真相源;NestJS。
2. **`runner` + `daemon` 是肌肉**——`runner` 在主机上调度容器/microVM,`daemon` 在沙箱里把能力开洞暴露出来;两边都是 Go。
3. **`proxy` + `ssh-gateway` 是入口**——把外部流量按 sandbox 维度路由到正确的 runner;`api-client-go` / `cli` / `dashboard` / SDK 全是 `api` 的客户端形态。

其它(`otel-collector`、`snapshot-manager`、`dex`、`infra`、`common-go`)都是支撑或基础设施。
