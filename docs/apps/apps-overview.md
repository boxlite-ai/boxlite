# `apps/` 一览

`apps/` 是 BoxLite 控制面 + 数据面 + 客户端的**单仓多服务**目录,由 **Nx workspace**(`apps/nx.json`)和 **Go workspace**(`apps/go.work`)双重管理。NestJS 控制面、Go 数据面、React 控制台、自动生成的 SDK 全部并存。

## 来源与谱系

### Fork 自 Daytona Platforms

整个 `apps/` 工作区**派生自 [Daytona Platforms](https://daytona.io) 的开源代码**。仓库根 `NOTICE` 与 `apps/NOTICE` 明确写到:

> Upstream source commit: **`f982c45a42e52c98631002c7dc1df565c44d7aac`**
>
> Daytona — Copyright the various Daytona software authors.
> The initial developer of the software is Daytona Platforms, Inc.

`apps/` 下 **866 个源文件**(`.go` + `.ts`)的文件头都标注 `Modified by BoxLite AI, 2025-2026`,意味着 BoxLite 不是从 Daytona 复制后整体替换,而是 **fork + 增量改造**。

### License 分布

混合许可,以 `apps/NOTICE` 为准:

| 许可 | 范围 |
|---|---|
| **AGPL-3.0**(沿用 Daytona)| `apps/api`、`apps/cli`、`apps/daemon`、`apps/dashboard`、`apps/infra`、`apps/libs/computer-use`、`apps/otel-collector`、`apps/proxy`、`apps/runner`、`apps/snapshot-manager`、`apps/ssh-gateway` |
| **Apache-2.0**(可自由使用)| `apps/common-go` + 所有自动生成的 SDK/client(`apps/api-client-go`、`libs/{api,toolbox,runner}-api-client` 等) |

仓库根的 BoxLite **runtime + SDK**(`src/`、`sdks/`、`libs/`)是 Apache-2.0,与 `apps/` 边界清晰。

### 名称与命名空间映射

| Daytona | BoxLite | 含义 |
|---|---|---|
| Daytona CLI / API / Daemon / Runner | `apps/{cli,api,daemon,runner}` | 直接 fork |
| `daytona.io/...` Go module | `github.com/boxlite-ai/{runner,daemon,proxy,...}` | 全量 rename |
| Workspace 与镜像 | `daytona-*` → `boxlite-*` / `bb_*` API key 前缀 | 整体 rebrand |
| `sandbox`(Docker 容器) | `box`(BoxLite microVM) **并存** | 见下文 BoxLite REST |

### 语言、框架、组件全景

#### 编程语言

| 语言 | 版本 | 用在哪里 |
|---|---|---|
| **TypeScript** | 5.x | `api`(NestJS)、`dashboard`(React)、`libs/*-api-client`、`libs/sdk-typescript`、`infra`(SST) |
| **Go** | 1.25.4 主流(`ssh-gateway` 1.24,`snapshot-manager` 1.25.0) | `cli`、`daemon`、`runner`、`proxy`、`ssh-gateway`、`snapshot-manager`、`otel-collector/exporter`、`api-client-go`、`common-go` |
| **JavaScript** | ES2022 | 前端构建、Nx 脚本 |
| **YAML / Dockerfile / Bash** | — | 各 `Dockerfile`、`dex/config.yaml`、`otel-collector/*.yaml`、`hack/*.sh` |
| **HTML / CSS** | — | `dashboard` 模板与 Tailwind |

> 仓库根另有 **Rust**(`src/boxlite`、libkrun)与 **Python/C**(`sdks/`)。`apps/` 不直接持有 Rust 代码,但 `apps/runner/pkg/boxlite/client.go` 通过 CGO `sdks/go` 间接驱动 Rust microVM runtime。

#### 控制面(`apps/api`)— NestJS 全家桶

| 关注点 | 组件 | 版本 |
|---|---|---|
| Web 框架 | `@nestjs/core` + `@nestjs/platform-express` | ^11.1.8 |
| ORM / 数据库 | `@nestjs/typeorm` + `typeorm` + `pg` + **PostgreSQL** | ^11 / ^0.3 / ^8.13 |
| 入参校验 | `class-validator` + `class-transformer` | ^0.14 / ^0.5 |
| OpenAPI | `@nestjs/swagger` | ^11.0.3 |
| 缓存 + 锁 + 限流 | `@nestjs-modules/ioredis` + `ioredis` + `@nestjs/cache-manager` + `@nestjs/throttler` + `@nest-lab/throttler-storage-redis` + **Redis** | — |
| 定时任务 | `@nestjs/schedule` | ^6.0 |
| 领域事件 | `@nestjs/event-emitter` | ^3.0 |
| 鉴权 | `@nestjs/passport` + OIDC(自家 + Dex) | — |
| 日志 | `nestjs-pino` + Pino | ^4.4 |
| 健康检查 | `@nestjs/terminus` | ^11 |
| WebSocket | `@nestjs/websockets` + `@nestjs/platform-socket.io` | ^11 |
| Feature flag | `@openfeature/nestjs-sdk` + PostHog provider | — |
| 分析仓库 | `@clickhouse/client` + **ClickHouse** | ^1.16 |
| HTTP 客户端 | `@nestjs/axios` | ^4 |
| 追踪 | OpenTelemetry(`instrumentation-pg/pino/ioredis`) | — |

#### 前端(`apps/dashboard`)— React 19 现代栈

| 关注点 | 组件 |
|---|---|
| 框架 + 构建 | **React 19** + **Vite** + TypeScript |
| 路由 | `react-router-dom` 6.29 |
| 状态/数据 | `@tanstack/react-query` 5.x、`@tanstack/react-form` 1.x、`@tanstack/react-table` 8.x |
| UI 原子 | **Radix UI**(`@radix-ui/react-{accordion,alert-dialog,checkbox,dialog,dropdown-menu,label,popover,radio-group,scroll-area,select,...}`)|
| 样式 | **Tailwind CSS** + `tailwind-merge` + `tailwindcss-animate` + `tailwind-scrollbar` |
| 鉴权 | `react-oidc-context` 3.x(直接对接 Dex) |
| HTTP | `axios` + `axios-retry` + `axios-debug-log` |
| 实时 | `socket.io-client` 4.x |
| 表单 / 校验 | `react-hook-form` + `zod` |
| 其它 | `react-day-picker`、`react-instantsearch`(Algolia)、`react-error-boundary`、`react-resizable-panels`、`react-number-format` |

#### Go 数据面 & 边缘 — 共享技术栈

| 关注点 | 组件 | 用于 |
|---|---|---|
| HTTP 框架 | **Gin** (`gin-gonic/gin`) + Gin Swagger + `slog-gin` | `daemon`、`runner` |
| 自家反代框架 | `common-go/pkg/proxy` + `gorilla/websocket` + `gin-contrib/cors` | `proxy`、`runner` |
| SSH | `golang.org/x/crypto/ssh`(client)+ `gliderlabs/ssh`(server)+ `pkg/sftp` | `ssh-gateway`(client)、`daemon`(server)、`runner/sshgateway` |
| CLI 框架 | **Cobra** (`spf13/cobra`) + **bubbletea**(TUI) + `lmittmann/tint`(彩色 slog) | `cli` |
| 日志 | `slog`(stdlib)+ `lmittmann/tint`+ `nestjs-pino`(Node 侧)+ `common-go/pkg/log` 多 handler | 全 Go 服务 |
| OAuth2 | `golang.org/x/oauth2` | `cli`(用户登录) |
| Docker SDK | `github.com/docker/docker` v28 + `docker/go-connections` (固定 v0.4.0) | `cli`(本地 build)、`runner`(Docker 后端) |
| Git | `go-git/go-git/v5` 5.19 | `daemon`(`/git/*` 路由) |
| LSP | `sourcegraph/jsonrpc2` | `daemon`(`/lsp/*`) |
| PTY | `creack/pty` 1.1 | `daemon`(`/process/pty`) |
| Plugin | `hashicorp/go-plugin` 1.6 | `daemon`(`computeruse` 插件化) |
| 系统信息 | `shirou/gopsutil/v4` | `daemon`、`runner` 指标采集 |
| MCP server | `mark3labs/mcp-go` 0.32 | `cli mcp` 子命令 |
| 配置 | `kelseyhightower/envconfig` + `gopkg.in/ini.v1` | 全 Go 服务 |
| Validator | `go-playground/validator/v10` | `daemon`、`runner` |
| 并发字典 | `orcaman/concurrent-map/v2` | `daemon` 会话表 |
| WebSocket | `gorilla/websocket` 1.5 | `daemon` 终端 / proxy |
| Browser 跳转 | `pkg/browser` | `cli` 登录 |
| 半结构化 ID | `google/uuid` 1.6 | 全栈 |
| Semver | `Masterminds/semver/v3` | `daemon`、`cli` 版本比较 |
| 测试 | `stretchr/testify` 1.11 | 全 Go 服务 |
| Swagger 生成 | `swaggo/swag` + `gin-swagger` | `daemon`、`runner` 自动生成 OpenAPI |
| Prometheus | `client_golang/prometheus/promhttp` | `runner /metrics` |

#### OpenAPI / 客户端代码生成

| 工具 | 输入 → 输出 |
|---|---|
| **OpenAPI Generator** (`openapi-generator-cli`) | `dist/apps/api/openapi.json` → `apps/api-client-go`(Go,177 model + 19 service) |
| 同上 | → `libs/api-client`(TS,Dashboard 用) |
| 同上 | → `libs/runner-api-client`、`libs/toolbox-api-client`、`libs/analytics-api-client`(TS) |
| `swaggo/swag` | `daemon`/`runner` 源码注解 → `pkg/*/docs/` |

#### 持久化 / 中间件

| 类别 | 选型 |
|---|---|
| 关系数据库 | **PostgreSQL**(`api` 主数据) |
| 缓存 + 锁 + 队列 | **Redis**(`@nestjs-modules/ioredis`,TypeORM 二级缓存、Throttler 存储、自家 `RedisLockProvider`) |
| 分析数据库 | **ClickHouse**(`api/clickhouse` 模块,Telemetry / 用量统计) |
| 镜像仓库 | **`distribution/distribution` v3**(`snapshot-manager`)+ S3 / Filesystem driver |
| 对象存储 | **S3**(SST 配 IAM,生产 snapshot 落 S3) |
| 邮件 | SMTP(开发用 `maildev/maildev` 镜像) |

#### 鉴权 / 安全

| 类别 | 组件 |
|---|---|
| OIDC IdP | **Dex**(`apps/dex`,SQLite 存储) |
| OAuth2 | `golang.org/x/oauth2`(`cli` 设备流) |
| Token 加密/签名 | `go-jose/go-jose/v4`、`gorilla/securecookie`、自家 `apps/api/src/encryption/` |
| 密码哈希 | `bcrypt`(via `golang.org/x/crypto`) |
| API Key | 自家(`bb_*` 前缀 + SHA-256 哈希存 PG) |
| SSH 公钥/证书 | `golang.org/x/crypto/ssh` + 自家 `validateSshAccess` |

#### 可观测性

| 类别 | 组件 |
|---|---|
| Trace / Logs / Metrics 协议 | **OpenTelemetry**(OTLP gRPC/HTTP) |
| Collector | `apps/otel-collector`(基于 OTel Builder + 自家 exporter) |
| Backend | **Jaeger**(trace,锁定 1.67.0)+ ClickHouse(metrics/logs)+ Prometheus(`runner /metrics`) |
| 日志聚合 | `pino` + `slog` + 自家 multi-handler;通过 OTel 推 collector |
| 错误监控 | PostHog(feature flag + event) |

#### 部署 / 基础设施

| 类别 | 组件 |
|---|---|
| IaC | **SST v4** + Pulumi(`@pulumi/aws`、`@pulumi/random`) |
| 云 | **AWS** `ap-southeast-1`(VPC / RDS Postgres / ElastiCache / S3 / ECS / EC2 / CloudFront / IAM) |
| 容器编排 | ECS(主)+ EC2(Runner,nested KVM 用 `c8i.2xlarge`) |
| CDN | CloudFront |
| 镜像基底 | `node:22-alpine` + `golang:1.25.4-alpine` 多阶段构建 |

#### 构建 / 工程化

| 类别 | 组件 |
|---|---|
| Monorepo 编排 | **Nx**(`apps/nx.json` + 每项目 `project.json`)+ `@nx-go/nx-go` |
| TS 包管理 | **Yarn Berry**(`apps/.yarnrc.yml` + `yarn.lock`) |
| Go 工作区 | `apps/go.work` 把 10 个 Go module 聚合 |
| 构建器 | Vite(前端)、Webpack(api,`webpack.config.js`)、`@nx-go/nx-go:build`(Go) |
| Lint / Format | ESLint(`eslint.config.mjs`)+ Prettier(TS)+ `golangci-lint`(Go) |
| 测试 | Jest(NestJS / Dashboard)+ `go test` + `testify` + Vitest(部分前端) |
| CI 资产 | GitHub Actions(根 `.github/workflows/`) |

---

## 架构体系

整套系统是一个 **平台型 sandbox-as-a-service**,分四层:

```
┌────────────────────────────────────────────────────────────────────┐
│  ① 客户端层  (Client)                                              │
│     apps/cli  ·  apps/dashboard  ·  libs/sdk-typescript / sdk-go   │
│     ─ 所有客户端都消费同一份 OpenAPI 生成的客户端                  │
└────────────────────────────────────────────────────────────────────┘
                                  │ HTTPS / WebSocket / SSH
┌────────────────────────────────────────────────────────────────────┐
│  ② 边缘层  (Edge)                                                  │
│     apps/proxy        — HTTP/WS 反代 + 预览 URL + warning page    │
│     apps/ssh-gateway  — SSH 反代,token → runner 路由               │
│     apps/dex          — OIDC 身份提供方                             │
└────────────────────────────────────────────────────────────────────┘
                                  │
┌────────────────────────────────────────────────────────────────────┐
│  ③ 控制面层  (Control plane)                                       │
│     apps/api         — 业务大脑 (NestJS + Postgres + Redis)        │
│     apps/snapshot-manager — 私有 Docker registry                   │
│     apps/otel-collector   — 观测数据汇聚                           │
└────────────────────────────────────────────────────────────────────┘
                                  │
┌────────────────────────────────────────────────────────────────────┐
│  ④ 数据面层  (Data plane)                                          │
│     apps/runner       — 沙箱调度执行节点(主机侧)                  │
│     apps/daemon       — 沙箱内 agent(沙箱内部)                    │
│     ─ 两种后端:Docker 容器(Daytona 原版) / BoxLite microVM(新增) │
└────────────────────────────────────────────────────────────────────┘

      └──────────────────── apps/infra (SST) ───────────────────┘
                  把上面所有组件部署到 AWS
```

### 架构特征

- **API-first**:`apps/api` 通过 `@nestjs/swagger` 导出 OpenAPI,**驱动**所有客户端(Go/TS/Python/Node/C)自动生成。改一处签名,全链路联动。
- **多客户端单服务**:Go 服务之间通过 HTTP + OpenAPI 客户端通信,而不是 gRPC/消息队列——简化部署,代价是无强类型 IDL(但 OpenAPI 客户端补齐了)。
- **数据面双后端**:`runner` 抽象出 `SandboxBackend` 接口,Docker 与 BoxLite microVM 后端并存可切换。
- **极简调度**:**poller pull 模式**(`runner/v2/poller`)而非 webhook push,简化 NAT/防火墙穿透。
- **OTel 全链路**:Trace/Logs/Metrics 三路统一从 `daemon` → `runner` → `otel-collector` → `Jaeger`/`api`。

---

## BoxLite 在 Daytona 基础上的定制开发

整体上 BoxLite **保留** Daytona 的控制面与边缘层骨架,**重构** runner 数据面以引入 microVM,同时整体 rebrand。

### 重点 1:引入 BoxLite microVM 作为新的 sandbox 后端 ★

Daytona 原版只用 **Docker 容器** 做隔离;BoxLite 新增一个完整的 **microVM 后端**,提供硬件级隔离。

`apps/runner/pkg/boxlite/client.go` 的注释直白:

> Package boxlite provides a BoxLite-backed implementation of the sandbox runtime,
> **replacing Docker with VM-based isolation** via the BoxLite Go SDK.

具体落地:

| 文件 | 职责 |
|---|---|
| `apps/runner/pkg/backend/backend.go` | 抽象 `SandboxBackend` 接口(BoxLite 新增的抽象层) |
| `apps/runner/pkg/backend/boxlite_adapter.go` | BoxLite 适配器 |
| `apps/runner/pkg/boxlite/client.go` | 包装 `sdks/go`(BoxLite Go SDK)以暴露与 Docker client 同形态的 API |
| `apps/runner/pkg/boxlite/exec_manager.go` | microVM 内执行管理 |
| `apps/runner/pkg/boxlite/registry.go` | microVM 镜像 registry |
| `apps/runner/pkg/boxlite/volumes.go` | 卷管理 |

底层走 BoxLite microVM 引擎(libkrun / WHPX / KVM),依赖仓库根 `sdks/go` → `src/boxlite`。

### 重点 2:新增 `boxlite-rest` 模块 — 用户向 microVM REST API

`apps/api/src/boxlite-rest/` 是 **BoxLite 独有** 的模块,在 Daytona 的 sandbox API 之上,**面向最终用户**提供一套以 "Box(microVM)" 为一等公民的 REST 接口:

```
apps/api/src/boxlite-rest/
├── boxlite-rest.module.ts
├── boxlite-box.controller.ts      # /v1/boxes  CRUD
├── boxlite-config.controller.ts   # 配置
├── boxlite-me.controller.ts       # 当前用户/会话
├── boxlite-proxy.controller.ts    # HTTP 代理
├── boxlite-ws-proxy.service.ts    # WebSocket 代理
├── dto/                           # Box / CreateBox 等新 DTO
└── mappers/sandbox-to-box.mapper.ts   # 把内部 Sandbox 实体映射成对外 Box
```

> `sandbox-to-box.mapper.ts` 这个文件名很说明问题:**内部仍用 Daytona 的 `Sandbox` 模型,对外重新包装成 `Box` 概念**,既复用了原有持久化与调度,又给最终用户一套全新的语义层。

对应在 `runner` 侧也有 `/v1/boxes/:boxId/exec` 系列路由(`apps/runner/pkg/api/server.go:164-174`),完整覆盖 exec / file upload-download / metrics / attach / signal / resize。

### 重点 3:Runner v2 架构(`pkg/runner/v2/`)

`apps/runner/pkg/runner/` 下同时存在 **v1**(`runner.go`)与 **v2**(`v2/`)。v2 是 BoxLite 的演进:

```
v2/
├── poller/        # 主动拉作业(原 v1 偏 push)
├── executor/      # 真正干活:create / start / stop / backup / destroy
└── healthcheck/   # 心跳上报
```

这种分层让 runner 在 NAT/限制网络下更稳,也便于双后端(Docker / BoxLite)统一调度。

### 重点 4:rebrand 与命名空间整体重写

非业务但工作量大的部分:

- Go module 全部从 Daytona 命名空间迁到 `github.com/boxlite-ai/*`(`apps/{api-client-go,cli,common-go,daemon,proxy,runner,snapshot-manager,ssh-gateway}/go.mod`)
- API key 前缀:`dt_*` → `bb_*`(见 `apps/api/src/api-key/api-key.entity.ts` 及 `api-key-list.dto.ts` 的 `bb_***def` 示例)
- 默认 header:`X-BoxLite-Organization-ID`、`X-BoxLite-Source`、`X-BoxLite-Api-Version`
- 客户端默认 server / UI 文案 / Swagger title / package 名(`@boxlite-ai/*`)全量替换
- 一致的版权头模板:`Copyright (c) BoxLite AI (originally Daytona Platforms Inc.) — Modified by BoxLite AI, 2025-2026`(866 个文件)

### 重点 5:中文 / 多区域部署友好

`apps/infra/sst.config.ts` 把默认部署区域改成 `ap-southeast-1`(新加坡),并固化了 BoxLite microVM 需要的 EC2 机型 `c8i.2xlarge`(nested KVM 支持)。第三方组件镜像版本全部锁定。

### 重点 6:与 BoxLite 主项目的纵向打通

`apps/` 不再是孤立的控制面——它通过 `apps/runner/pkg/boxlite/client.go` 直接依赖仓库根 **`sdks/go`**(BoxLite Go SDK),最终接到 `src/boxlite`(Rust runtime,libkrun/WHPX/KVM)。也就是把仓库根的 microVM runtime **嵌入** Daytona 的控制面骨架,形成 "Daytona 控制面 + BoxLite 数据面" 的杂交体。

---

### 小结一句话

BoxLite 拿 Daytona 的 **控制面、边缘、调度框架** 当地基(866 个文件级修改 + 全量 rebrand),**重写数据面引入 microVM 后端**(`pkg/backend` + `pkg/boxlite`),并**新增一套面向 microVM 的对外 REST API**(`boxlite-rest/`、`/v1/boxes`),把它从 "container sandbox" 平台升级成 "**container + microVM 双形态**" 平台。

## 单图速览

```
                    ┌─────────────────────────────────────────┐
                    │             用户 / 客户端                │
                    └─────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────────┐
        │                         │                             │
   apps/cli                  apps/dashboard          apps/libs/sdk-typescript
   (boxlite 二进制)           (React 控制台)            libs/sdk-go (PyO3 上层)
        │                         │                             │
        └─────────────┬───────────┴─────────────┬───────────────┘
                      │  HTTPS                  │
                      ▼                         ▼
                ┌──────────────────────────────────────────────┐
                │  apps/api  (NestJS REST/控制面)              │  ← apps/api-client-go 自动生成自此
                │     + apps/dex (OIDC 认证)                   │
                └──────────────────────────────────────────────┘
                                  │
        ┌─────────────────┬───────┼────────────────────┬──────────────────┐
        │                 │       │                    │                  │
        ▼                 ▼       ▼                    ▼                  ▼
  apps/proxy        apps/ssh-gateway  apps/snapshot-manager   apps/runner          apps/otel-collector
  (HTTP 反代 +      (SSH 反代,token       (镜像 registry,         (调度 sandbox VM/         (Traces/Logs/Metrics
   预览 URL 网关)    身份 → 转发到 runner)  支持 S3 + FS)            container,nested KVM)    汇聚到 Jaeger 等)
                                                                  │
                                                                  │ 在每个 sandbox 内部
                                                                  ▼
                                                            ┌─────────────────┐
                                                            │  apps/daemon    │
                                                            │  (沙箱 agent)   │
                                                            └─────────────────┘
```

## 应用一览表(13 个 + 2 个支撑目录)

| 应用 | 语言 / 框架 | 角色 | 形态 |
|---|---|---|---|
| **`api`** | NestJS 11 + TypeORM 0.3 + Postgres + Redis + ClickHouse | 控制面核心 REST API | 容器 |
| **`dashboard`** | React + Vite + Tailwind | 用户控制台 SPA | 静态资产(被 api 托管或独立 CDN) |
| **`dex`** | Dex(配置) | OIDC 身份提供方 | 容器(社区镜像 + 自家 config) |
| **`proxy`** | Go + Gin | sandbox HTTP 流量反代、预览 URL 签名、warning page | 容器(边缘服务) |
| **`ssh-gateway`** | Go(`golang.org/x/crypto/ssh`) | SSH 流量反代,`ssh -p 2222 <token>@host` 自动定位到对应 runner | 容器(边缘服务) |
| **`snapshot-manager`** | Go + `distribution/distribution` | 私有 Docker registry(S3/FS storage) | 容器 |
| **`runner`** | Go + Gin + Docker SDK | 调度并管理 sandbox 生命周期(create/start/stop/backup/destroy + boxlite v1 接口) | 容器或裸 EC2(嵌套 KVM) |
| **`daemon`** | Go + Gin + gliderlabs/ssh + go-git | sandbox **内部** agent,暴露 Toolbox API | 二进制(打进 sandbox 镜像) |
| **`otel-collector`** | OpenTelemetry Collector + 自家 exporter(Go) | Traces / Logs / Metrics 汇聚 | 容器 |
| **`cli`** | Go + Cobra + bubbletea | `boxlite` 终端二进制 + MCP server | 二进制(发布给最终用户) |
| **`api-client-go`** | Go(OpenAPI 生成) | `apps/api` 的 Go 客户端 SDK | 库 |
| **`common-go`** | Go | 各 Go 服务共用的工具:log/telemetry/cache/proxy/errors/timer | 库 |
| **`infra`** | TypeScript + SST | AWS 一键部署:VPC/RDS/Redis/S3/ECS/EC2/CloudFront/IAM | IaC |
| `libs/` | TS / Python | 控制面前端用到的客户端库(`api-client`、`toolbox-api-client`、`runner-api-client`、`analytics-api-client`、`computer-use`、`sdk-typescript`) | 库 |
| `local-dev/` | 脚本 / docker-compose | 本地开发环境 | 工具 |

## 三大体系(按职责切分)

### A. 控制面(用户管/计/账面)

- **`apps/api`** — 全部业务逻辑:用户、组织、API key、配额、Webhook、审计、健康、地区、对象存储、Docker registry 凭据、沙箱编排入口。所有客户端调它。
- **`apps/dex`** — OIDC 认证。`api` 通过 OIDC 集成,把登录/会话外包给 Dex(支持各种上游 IdP)。
- **`apps/dashboard`** — React SPA,直接调 `api`。
- **`apps/api-client-go`** + `libs/api-client`(TS) + `libs/toolbox-api-client` + `libs/runner-api-client` — 由 `api`/`runner`/`daemon` 的 OpenAPI spec 自动生成的客户端库矩阵。

### B. 数据面(沙箱生命周期与流量)

- **`apps/runner`** — `api` 把"创建沙箱"指令转发给 runner;runner 是真正接触 Docker / VM / 嵌套 KVM 的执行节点。v2 架构:`poller`(轮询任务) + `executor`(执行) + `healthcheck` + `backend`(docker / boxlite 双后端抽象)。
- **`apps/daemon`** — 跑在沙箱内部的 agent,把"文件/进程/Git/LSP/桌面/端口/SSH/录屏"统一以 Toolbox HTTP API 暴露给外部。
- **`apps/proxy`** — 把沙箱 URL(如 `https://22222-<sandboxId>.<host>`)反代到 runner 上的 sandbox 内 port。处理签名预览 URL、warning 页(unsafe content)、auth callback。
- **`apps/ssh-gateway`** — 用户用 `ssh -p 2222 <token>@gateway` 时,网关用 token 找到目标 runner,拉取 sandbox SSH 凭据,转发会话。
- **`apps/snapshot-manager`** — 私有 Docker registry(基于 `distribution/distribution`),Runner build/pull/push sandbox 镜像走这里。

### C. 平台支撑

- **`apps/otel-collector`** — 自定义 OTel Collector 发行版(`builder-config.yaml` 构建),含一个把指标推回 `api` 的 **自家 exporter**(`exporter/`)。所有 Go 服务 + `daemon` + `api` 都把 OTel 推给它。
- **`apps/common-go`** — 通用 Go 工具库,定义所有 Go 服务共享的 logger、telemetry、cache、proxy、errors。
- **`apps/cli`** — 用户终端入口。包装 `api-client-go` + cobra + TUI + OAuth2 设备流 + 本地 Docker + MCP server。
- **`apps/infra`** — SST 写的 AWS IaC,把上面所有组件部署成完整云形态(`apps/infra/sst.config.ts`)。

## 工作区元数据

- **Nx workspace**:`apps/nx.json` + 每个项目的 `project.json`。统一管 `build` / `test` / `lint` / `generate:*` target。
- **Go workspace**:`apps/go.work` 把 10 个 Go module 拉到一个工作区,本地开发可跨 module 调试。
- **包管理**:`apps/package.json` + `yarn.lock`(Yarn Berry,`.yarnrc.yml`)。
- **License**:AGPL-3.0 + Apache-2.0(详见 `apps/LICENSES/`、`apps/NOTICE`),代码源自 Daytona Platforms 的 fork 并由 BoxLite AI 修改。

## 完整调用路径示例

**用户 `boxlite sandbox create` 一行命令背后:**

```
1. apps/cli (Go)
     │  GetApiClient() → 加 Bearer + X-BoxLite-Source: cli + X-BoxLite-Organization-ID
     │  client.SandboxAPI.CreateSandbox(ctx).Execute()
     ▼
2. apps/api (NestJS)  POST /sandbox
     │  Guard(Auth/Org/RateLimit) → DTO 验证 → Service → TypeORM 写 PG
     │  选 Runner(按 region/load)→ 远程调
     ▼
3. apps/runner (Go)   POST /sandboxes
     │  poller/executor → SandboxBackend(Docker/BoxLite) → 起容器或 microVM
     │  注入 daemon 二进制 + 配置(SandboxId、OrgId、OtelEndpoint)
     ▼
4. apps/daemon (Go)  容器内启动
     │  起 Toolbox HTTP(Gin)、SSH(gliderlabs)、Terminal WS、Recording Dashboard
     │  把端口注册回 runner → runner 注册回 api
     ▼
5. 返回链 → api 持久化 sandbox 实体 → 返回给 cli
6. 后续访问:
   - 用户 HTTP 流量 → apps/proxy(签名验证)→ runner → daemon
   - 用户 SSH 流量  → apps/ssh-gateway(token 验证)→ runner → daemon
   - 镜像拉取      → apps/snapshot-manager
   - 全程 OTel    → apps/otel-collector → api/Jaeger
```

## 详细解读

每个应用的源码级解读见 **[apps-comprehensive.md](./apps-comprehensive.md)**。单独的深度文档:

- [apps-api-overview.md](./apps-api-overview.md) — `apps/api` 的 NestJS / TypeORM CRUD 全景
- [api-client-go.md](./api-client-go.md) — `apps/api-client-go` 的自动生成原理
