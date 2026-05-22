# infra-local 现状总览

> Snapshot 时间:**2026-05-22**(L2 闭环 + region/runner 全打通后)
> Branch:`feat/cloud-mvp`
> 平台:**Apple Silicon M5(arm64),全 native,不走 Lima**

## 🟢 真服务,真在跑(18 个进程,M5 native)

### L1 — Infra-local 10 boxes(BoxLite microVMs,libkrun on M5 HVF)

| Box | Image | 端口 | 真用途 |
|---|---|---|---|
| `postgres` | `postgres:17-alpine` | 25432 | 真 PG,**真 prod schema 已 load**(27 tables, 88 migrations) |
| `redis` | `redis:7-alpine` | 26379 | 真 cache + signed-url token store + lock provider |
| `minio` | `minio/minio` | 29000 / 29001 | 真 S3,bucket `boxlite` 已创建 |
| `registry` | `registry:2` | 25000 | 真 OCI registry,snapshot image 实际存这 |
| `dex` | `dexidp/dex:v2.42.0` | 25556 | 真 OIDC,浏览器真走 OAuth2 |
| `jaeger` | `jaegertracing/all-in-one:1.67.0` | 26686 | 真 Trace UI |
| `otel` | `otel/opentelemetry-collector:latest` | 24317 / 24318 / 23133 | 真 OTLP receiver |
| `caddy` | `caddy:2-alpine` | 28080 / 12019 | 真反代,含 wildcard `*-*.localhost` 路由到 proxy |
| `pgadmin` | `dpage/pgadmin4:9.2.0` | 25051 | 真 DB 管理 UI |
| `registry-ui` | `joxit/docker-registry-ui` | 25052 | 真 registry 浏览 UI |

启动:`cd apps/infra-local && make up-with-schema`

### L2 — Application 控制面(4 个 native 进程,host 上)

| 服务 | 端口 | 真用途 |
|---|---|---|
| **NestJS API** | 3001 | 真,完整 88 migrations + 6 个 PostHog flag bootstrap = true |
| **Go Runner**(M5 native!不走 Lima)| 3003 | 真,M5 arm64 cgo + libkrun;注册到 API,heartbeat 5s 一次 |
| **Go Proxy** | 4000 | 真,sandbox port-preview 流量都走这(`*-*.localhost:28080` → :4000) |
| **Dashboard Vite dev** | 3000 | 真 React,真 OIDC,已拆 MSW |

### L3 — Sandbox microVMs(用户真创建的)

| | |
|---|---|
| 数量 | 按需可创建 N 个;每个 = 真 libkrun arm64 microVM,`boxlite-shim` PID 在跑 |
| Terminal | 真 — 浏览器 → Caddy → Proxy → Runner → microVM shell(`root@boxlite:~#`) |

---

## 🟡 还是 Mock / Stub / Bootstrap-Default

| 项 | 现状 |
|---|---|
| **PostHog 服务** | 没接(SaaS,需要真 key)。**6 个 feature flag 用 bootstrap 默认值 = true**(local 端 + dashboard 端两边都 bootstrap) |
| **Billing(Stripe / 自研)** | 没接。Dashboard 的 billing 相关页面(invoices / wallet / tier)调 `BILLING_API_URL=http://localhost:3000/api/billing` 走 dashboard 自己路由,实际由 MSW 留下的 mock 数据接(剩余的 billing handlers 还在 `handlers.ts` 里,因为 billing 子路径用不同 host) |
| **Svix Webhooks** | 没接。`SVIX_AUTH_TOKEN` 空 → webhook 模块返 disabled,console 报 cosmetic 500 / 404 |
| **PostHog Analytics 上报** | 没用(就是 PostHog 一码事) |
| **PostHog SaaS 控制平面** | 没接 |

---

## 🔴 完全没有(可延后)

| 缺的 | 影响 |
|---|---|
| **Snapshot Manager**(`apps/snapshot-manager`,Go binary)| 不能从 Dockerfile build 自定义 snapshot;只能 pull 现成 OCI image 当 snapshot(我们用 `ubuntu:22.04` 就这条路径) |
| **SSH Gateway**(`apps/ssh-gateway`,Go binary)| dashboard 不能 SSH 进 sandbox(配了 env var 但服务没起);Terminal / WS 走另一条路所以不受影响 |
| **dns-shim + TLS**(`*.boxlite.test` HTTPS)| 需要 sudo,parked |
| **ClickHouse** | 没装。Audit telemetry / sandbox metrics 走降级路径(`getClient() → null`,不写不报错) |
| **OpenSearch**(audit log 长存)| 没装,`AUDIT_PUBLISH_ENABLED=false` |
| **SMTP**(组织邀请发邮件)| 没装 |
| **Pylon**(in-app 客服)| 没装,空 token 禁掉 |

---

## 一句话

**L1(基础设施)+ L2(API / Runner / Proxy / Dashboard)+ L3(真 microVM sandbox)= 100% 真;PostHog / Billing / Webhooks / SSH Gateway / Snapshot Manager / ClickHouse 这 6 个外围依赖 = 没起,功能要么用 bootstrap 默认值跳过,要么对应 UI 功能直接缺失。**

完整 sandbox 生命周期(create → start → terminal → stop → destroy)、OIDC login、组织管理、API key CRUD、Region 创建、Snapshot 拉取与挂载 — 全部走真链路,可在 dashboard 上完整操作。

---

## 关键 commits(本 session 累积达到此状态的关键修改)

| Commit | 说明 |
|---|---|
| `a5dd1319` | `feat(api): bootstrap PostHog feature flags for local-dev (mirror dashboard)` — 解锁 Create Region / Runners 列表等 server-side flag 守门的路由 |
| `69a82bed` | `fix(runner): pull images for host architecture instead of hardcoded amd64` — 让 M5 拉 arm64 image,解决 `ENOEXEC` |
| `8dad81b5` | `feat(infra-local): wire Caddy → apps/proxy for sandbox port-preview URLs` — terminal / preview iframe 全链路打通 |
| `3d5829aa` | `feat(dashboard): bootstrap PostHog feature flags for local-dev` — Create Sandbox 按钮 + 其他 UI surface 在无 PostHog 下可见 |
| `11625a81` | `feat(L2): API booting + runner binary compiled` — L2 起点 |
| `f5a30940` | `feat(infra-local): pin PG to 17-alpine + load prod schema baseline` — L1 收尾 |

## 启动 / 重启 cheatsheet

```bash
# L1:infra-local 10 boxes(含 prod schema)
cd apps/infra-local && make up-with-schema

# L2-1:API
cd apps && set -a; source .env; set +a; corepack yarn nx serve api

# L2-2:Runner(M5 native arm64)
BOXLITE_API_URL=http://localhost:3001/api \
BOXLITE_RUNNER_TOKEN=local-shared-runner-token-aaaa1111 \
API_VERSION=2 API_PORT=3003 \
RUNNER_DOMAIN=127.0.0.1 \
BOXLITE_HOME_DIR=$HOME/.boxlite-runner \
INSECURE_REGISTRIES=127.0.0.1:25000 \
AWS_REGION=us-east-1 \
DYLD_LIBRARY_PATH=/Users/lilongen/github/boxlite-cloud-mvp/sdks/go \
/tmp/boxlite-runner

# L2-3:Proxy
PROXY_PORT=4000 PROXY_PROTOCOL=http \
PROXY_API_KEY=boxlite-proxy-key \
BOXLITE_API_URL=http://localhost:3001/api \
OIDC_CLIENT_ID=boxlite OIDC_AUDIENCE=boxlite \
OIDC_DOMAIN=http://localhost:25556/dex \
REDIS_HOST=127.0.0.1 REDIS_PORT=26379 \
SHUTDOWN_TIMEOUT_SEC=10 \
/tmp/boxlite-proxy

# L2-4:Dashboard
cd apps && corepack yarn nx serve dashboard
```

入口 URLs:

| 服务 | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| API | http://localhost:3001/api |
| Dex (OIDC) | http://localhost:25556/dex |
| Jaeger | http://localhost:26686 |
| pgAdmin | http://localhost:25051 |
| Registry UI | http://localhost:25052 |
| MinIO Console | http://localhost:29001 |
| Caddy (统一入口) | http://localhost:28080 |
