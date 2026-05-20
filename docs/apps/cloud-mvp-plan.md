# BoxLite Cloud — Foundation 优先 + MVP 路线

> 输入文档:`BoxLite cloud MVP.md`(MVP scope) + `docs/superpowers/specs/2026-05-19-apps-infra-local-design.md`(local dev spec)
> 基线分支:`main` + `feat/local-dev-fullstack`(已 14 commits ahead)
> 修订时间:2026-05-20
> **修订原因**:从"6 人团队 8 天赶 MVP" 改为 **"solo 开发者,Foundation 优先,质量优先"**(见 memory `project_infra_local_first.md`)

---

## 0. Executive summary

- **当前现实**:实际只有 1 名开发者(用户本人)。Linear 项目挂的 6 个成员暂时不参与。原 8 天 MVP 时间线 solo 装不下 10+ 人天工作量。
- **新方向**:**先把 `apps/infra-local/` 高质量做完作为 Foundation**,MVP 业务功能放到 Foundation 之后再做。质量 > 速度,长期收益 > 短期 demo。
- **Foundation 包含**:`apps/infra-local/` 全部 8 个 phase 的高质量交付——从 docker-compose 编排到真 Lima runner 到 Caddy 边缘到 Jaeger 观测到 admin UI,在 macOS 上跑出 `apps/infra/`(AWS SST)的等效全栈。
- **MVP 业务功能**(Box lifecycle / quota / admin UI / autoscaler / ...)以技术 gap 分析的形式记录在本文中,**但不绑日期**,等 Foundation 完成后按顺序推进。
- **完成判据**:`apps/infra-local/scripts/smoke.sh` 端到端跑通(create box / scale up / scale down / delete),所有命令幂等可重置;Foundation 文档与代码不脱节。

---

## 1. 现状

| 维度 | 情况 |
|---|---|
| 团队 | **1 人**(本人,michael.li@polygala.ai) |
| 时间预算 | **不绑死**,但每周内部里程碑保持节奏避免拖延 |
| 基线 | `main` 28159fc5 + `feat/local-dev-fullstack` 22a3de0c |
| 现有 Foundation 进度 | Phase 0-1 完成,Phase 2-8 待做 |
| 现有阻塞 | API 159 个 TS 编译错(Phase 2 的核心子任务) |
| MVP Linear 项目 | `boxlite-cloud-mvp-48a5cc5d2343`,5/28 截止——**需要跟 lead 协商延期**(用户的事,本文不规划)|

---

## 2. 整体路线

```
                  ┌───────────────────────────────────────────┐
                  │  Phase 1: Foundation                      │
                  │  apps/infra-local/ 全部 8 phase           │
                  │  目标:本地完整开发循环 + 真 microVM 测试  │
                  └───────────────────────────────────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────────────────┐
                  │  Phase 2: MVP 业务功能                    │
                  │  Box lifecycle / Quota / Admin UI /       │
                  │  Autoscaler / Observability               │
                  └───────────────────────────────────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────────────────┐
                  │  Phase 3: 上线打磨 + Demo                 │
                  │  压测 / 回滚预案 / 客户 demo              │
                  └───────────────────────────────────────────┘
```

**关键原则**:

1. **不并行做 Phase 1 和 Phase 2**——Foundation 没做完前,业务功能不开工(也开不动,API 都编译不过)
2. **每个 Phase 内部串行子任务**——solo,context switching 是最大的浪费
3. **每个子任务有可勾选的 DoD**(Definition of Done)
4. **质量门**:任一 Phase 完成判据未满足,不进下一 Phase
5. **MVP scope cut 思路保留**,但作为"长期决策"而非"赶工取舍"

---

## 3. MVP 需求 → 现有代码 Gap 分析(参考,不绑期)

记录 BoxLite Cloud MVP 文档里的需求与现有代码的差距。Phase 2 实施时按此清单推进。

| MVP 要求 | 现有代码位置 | 状态 | 工作量(solo)|
|---|---|---|---|
| **Box lifecycle**:create/start/stop/delete/inspect/recover | `apps/api/src/boxlite-rest/boxlite-box.controller.ts` + `sandbox.service.ts` + `runnerAdapter.v2.ts` + `apps/runner/pkg/api/controllers/sandbox.go` | ✅ 完整 | 0.5d e2e 验证 |
| 清晰的状态转换 | `sandbox-state.enum.ts` + `SandboxStateWaiterService` + state machine | ✅ 完整 | 0 |
| **Admin: users 管理** | `apps/api/src/admin/controllers/` + `user/user.module.ts` | ✅ 部分 | 1d(UI 接上)|
| Admin: usage 管理 | `apps/api/src/usage/` | ✅ 部分 | 1d |
| Admin: quotas 管理 | `organization/entities/region-quota.entity.ts` + service | ⚠️ 实体在,enforce 路径要核对 | 1-2d |
| Admin: machine(runner)状态 | `admin/controllers/runner.controller.ts` + Dashboard `Runners.tsx` | ✅ | 0.5d(UI 收尾)|
| Admin: box state | `admin/controllers/sandbox.controller.ts` + Dashboard `Sandboxes.tsx` | ✅ | 0.5d |
| **Runner add/remove** | `RunnerService.create()` + REST | ✅ | 0 |
| Runner 健康追踪 | `@Cron(EVERY_10_SECONDS) handleCheckRunners()` | ✅ | 0 |
| Runner 容量 expose | `Runner.entity.ts` 已有 cpu/memoryGiB/diskGiB + currentUsage | ✅ | 0(只需 UI)|
| **负载均衡调度** | `runner.service.ts:955` TOPSIS 评分 | ✅ | 0(已有,需文档化 + e2e)|
| **Observability**:用量 | `usage/` + `analytics/` 模块 | ✅ 部分 | 1d |
| Observability:CPU/mem/disk | runner 已上报 currentCpu/Memory/DiskUsagePercentage | ✅ | 0(查询 + UI)|
| Observability:metrics/logs | `otel-collector` + Jaeger + `runner /metrics`(Prometheus)| ✅ | 0(已部署)|
| **Quotas enforcement** | 实体存在,需核对所有 create 路径都做 enforce | ⚠️ | 2d |
| **Runner 自动扩缩容** | ❌ **不存在** | ❌ | **3-4d**(Phase 2 核心) |

**Phase 2 净增工作量约 11-15 人天**,solo 推进估计 **3-4 个日历周**(每天 6-7 小时有效工作)。

---

## 4. 长期裁剪清单(以下功能确认 BoxLite Cloud 不要 / 暂时下线)

**原则**:**禁用而非删除**——用 feature flag / 注释 module 隐藏,代码留着便于回退。

### 4.1 完整下线

| 组件 | 路径 | 理由 |
|---|---|---|
| Workspace API(老 Daytona 概念) | `apps/api/src/sandbox/controllers/workspace.deprecated.controller.ts` | 已 deprecated;BoxLite 用 box/sandbox 概念 |
| Toolbox deprecated controller | `apps/api/src/sandbox/controllers/toolbox.deprecated.controller.ts` | 同上 |
| Linked accounts / Email verify | dashboard `LinkedAccounts.tsx`、`EmailVerify.tsx` | 用 Auth0/Okta,不自营邮件流 |
| Wallet / Spending | dashboard `Wallet.tsx`、`Spending.tsx` + `billing-api/` | 计费 v1 之后 |
| Webhooks(对用户) | `webhook/` 模块对外 API + `Webhooks.tsx` | 暂不暴露给客户 |
| Computer-use 录屏面板 | `apps/daemon/pkg/recordingdashboard/` | 默认关 |
| Experimental page | `dashboard/src/pages/Experimental.tsx` | 顾名思义 |
| 旧的 swagger 双输出 | `apps/api/src/generate-openapi.ts` 多余 schema | 减暴露面 |
| Dex 自家部署(生产)| `apps/dex/` 在 SST 中 | 生产用外部 OIDC;Foundation 本地仍用 Dex |
| `apps/runner/pkg/daemon/{assets.go, util.go, static/}` | 死代码 | `WriteStaticBinary` 0 调用方 |

### 4.2 部分下线(保留功能,隐藏 UI / 限制角色)

| 组件 | 处理 |
|---|---|
| Volume / Snapshot / Region / Registry 前端 | admin-only,后端保留 |
| Organization roles / members | 简化为单层"组织 owner / member" |
| Audit logs 给用户的视图 | 后端持续写,前端 admin-only |

### 4.3 不动(Foundation 与 MVP 都用到)

- Authentication / OIDC integration
- API key 管理
- 全部 Toolbox API
- 全部 Runner v2 路径
- Sandbox warm-pool
- 5 个边缘 Go 服务(proxy/ssh-gateway/snapshot-manager/runner/otel-collector)

---

## 5. Phase 1 — `apps/infra-local/` Foundation 详解

**目标**:在 MacBook 上跑出 `apps/infra/`(AWS SST)的等效全栈,**长期作为开发与测试的基线**。质量标准:幂等、可重置、文档与代码不脱节、错误可观测。

### 5.1 已完成(分支 `feat/local-dev-fullstack` 14 commits)

| Phase | 内容 | commit |
|---|---|---|
| **0** | 骨架 / Makefile / doctor / lib.sh / .gitignore | `bed90c14`、`78accada` |
| **1** | DNS-shim(Go) + launchd plist + install/uninstall + mkcert wildcard + Caddyfile bootstrap | `58971f51`、`ff9a59ad`、`33d3ceee`、`22a3de0c` |

### 5.2 待做 Phase 详情

#### Phase 2 — API/Dashboard host-mode

**子任务**:

1. 修 `apps/api/tsconfig.json` 的 `extends` 路径(`../../` → `../`,根因 1)
2. 修 `apps/api/src/audit/decorators/audit.decorator.ts` 的 `targetIdFromRequest` 签名加 `string[]`(根因 2,消除 88 个 TS2322)
3. `apps/api/src/interceptors/metrics.interceptor.ts` 加 `headerToString` helper,替换 69 处直传(根因 3)
4. 删 `sandbox.module.ts` 里两个 deprecated controllers(顺带消 32 个错)
5. 解决 `@boxlite-ai/runner-api-client` paths mapping(根因 4)
6. 解决最后的 TS2503(根因 5)
7. **Nx WORKDIR**:让 `yarn nx serve api`、`yarn nx serve dashboard` 在 host 上跑通

**DoD**:
- [ ] `cd apps && ./node_modules/.bin/tsc -p api/tsconfig.app.json --noEmit` → 0 errors
- [ ] `yarn nx build api` → success
- [ ] `yarn nx serve api` → starts on :3000
- [ ] `yarn nx serve dashboard` → starts on :5173,可登录 dex

**工作量**:1.5-2d(含 Nx WORKDIR 调试)

#### Phase 3 — 完整 compose stack

**子任务**:

1. 把 `apps/local-dev/docker-compose.local.yml` 整合到 `apps/infra-local/compose.local.yml`(新统一目录)
2. 删 `apps/local-dev/`(完成后)
3. `.env.example` 完整定义所有变量
4. 6 个底层服务 healthcheck 配齐:postgres / redis / dex / minio / minio-init / registry
5. 加 proxy + ssh-gateway + snapshot-manager(`--profile full` 下挂)
6. `make up` / `make down -v` 幂等可重复

**DoD**:
- [ ] `make up` 跑两遍,第二遍 < 5s
- [ ] `make down -v && make up` 干净重来 < 3min
- [ ] `docker compose ps` 全绿
- [ ] `make doctor` `stack` 段全过

**工作量**:0.5-1d

#### Phase 4 — 真 runner via Lima Linux VM

**核心交付**:**`LimaInfraProvider`**,让 autoscaler 在本地能起真 runner。

**子任务**:

1. 设计 `IInfraProvider` 接口(`provisionRunner` / `terminateRunner` / `describeRunner`)
2. 编出 `boxlite-runner` 二进制(Linux arm64,Lima 内编译,用 `BOXLITE_DEPS_STUB=1` 加速)
3. 写 Lima yaml 模板(CPU/RAM/磁盘可参数化)
4. 写 systemd unit 模板让 runner 在 Lima 内开机自启
5. 实现 `LimaInfraProvider`(TypeScript,调 `limactl` 子进程)
6. 配 Lima `portForwards`,让 host 能访问 runner :3003
7. 接入 Runner self-registration 流程:Lima 起来后 runner 自动调 api `POST /admin/runners`
8. 写单元测试(mock `limactl`)+ 集成测试(真起一台)

**DoD**:
- [ ] `make lima-up` 起一台 Lima,5 分钟内 runner 注册到 api
- [ ] `boxlite-cli box create` 能调度到 Lima runner 并跑出真 microVM
- [ ] `make lima-down` 干净销毁
- [ ] LimaInfraProvider 单元测试通过
- [ ] 文档:Lima yaml 模板含义注释清楚

**工作量**:2-3d(solo)

#### Phase 5 — Caddy 完整路由(恢复 Foundation 质量)

**子任务**:

1. Caddy 路由:
   - `api.boxlite.test` → `localhost:3000`
   - `dashboard.boxlite.test` → `localhost:5173`
   - `*.proxy.boxlite.test` → proxy container
   - `ssh.boxlite.test` → ssh-gateway(TCP 模式)
   - `auth.boxlite.test` → dex
   - `registry.boxlite.test` → registry:2
   - `s3.boxlite.test` → minio
   - `console.boxlite.test` → minio console
   - `jaeger.boxlite.test` → jaeger UI(Phase 6 之后)
   - `pgadmin.boxlite.test` → pgadmin(Phase 7 之后)
2. 长连接 streaming 调优(SSH、WebSocket)
3. `make tls` 一键重生证书

**DoD**:
- [ ] 10 个域名都能 `curl https://X.boxlite.test` 成功(`-k` 不需要,因为 mkcert 是信任的 CA)
- [ ] `make doctor` `network` 段含 DNS / TLS / 路由 check 全过

**工作量**:0.5d

#### Phase 6 — 完整观测:Jaeger + OtelCollector

**子任务**:

1. OtelCollector 容器跑起来,接 api + runner OTLP
2. **Jaeger UI 容器**(`jaegertracing/all-in-one:1.67.0`,跟生产同款)
3. Caddy 加 `jaeger.boxlite.test` 路由
4. 验证 api / runner 的 trace 落到 Jaeger UI 可查

**DoD**:
- [ ] api 一次 box create 请求的 trace 在 Jaeger 里能看到完整 span 链
- [ ] runner 的指标(每 10s 健康检查、调度)有 trace
- [ ] OtelCollector logs 路径正常

**工作量**:0.5d

#### Phase 7 — 选择性 admin UIs

> Foundation 视角下重新评估,以下两个上,MailDev 不上。

1. **PgAdmin**(`dpage/pgadmin4:9.2.0`,跟生产同款)— 开发期 inspect DB 高频
2. **RegistryUI**(`joxit/docker-registry-ui:main`)— 看 sandbox 镜像 layer / tag 直观
3. **MailDev**:**不上**,Foundation 没有邮件流场景

**DoD**:
- [ ] `pgadmin.boxlite.test` 能登录,看到 boxlite DB
- [ ] `registry.boxlite.test/ui` 看到本地 push 的 sandbox 镜像
- [ ] 默认凭据写在 `.env.example`

**工作量**:0.5d

#### Phase 8 — E2E 验证(收口)

**核心交付**:`apps/infra-local/scripts/smoke.sh` 端到端验证。

**测试矩阵**:

```bash
# 0. 环境
make doctor              # 所有 probe 通过

# 1. 启动
make up                  # 底层服务
yarn nx serve api &
yarn nx serve dashboard &
make lima-up             # 一台 Lima runner

# 2. Auth
TOKEN=$(boxlite-cli auth login --api-key=...)

# 3. Box 全生命周期
BOX=$(boxlite-cli box create --image alpine:3.22 --json)
boxlite-cli box exec $BOX -- 'echo hello'
boxlite-cli box stop $BOX
boxlite-cli box start $BOX
boxlite-cli box delete $BOX

# 4. Port preview
BOX=$(boxlite-cli box create --image nginx:alpine)
URL=$(boxlite-cli box preview-url $BOX --port 80)
curl -fsSL "$URL"           # 走 Caddy *.proxy.boxlite.test

# 5. SSH
boxlite-cli box ssh $BOX -- 'uname -a'    # 走 ssh.boxlite.test

# 6. Scale 测试(autoscaler 完成后)
for i in {1..20}; do boxlite-cli box create --image alpine:3.22 & done
wait
sleep 120
[[ $(limactl list | grep -c boxlite-runner) -ge 2 ]] || { echo FAIL; exit 1; }

# 7. Cleanup
boxlite-cli box delete --all
sleep 900
[[ $(limactl list | grep -c boxlite-runner) -le 1 ]] || { echo FAIL; exit 1; }

# 8. Tear down
make lima-down
make down -v
```

**DoD**:
- [ ] 整个 smoke.sh 跑通,无 manual 介入
- [ ] 失败时有清晰错误归属(哪个 phase / 哪个服务)
- [ ] 跑两次 smoke.sh 都过(幂等)

**工作量**:0.5-1d

### 5.3 Phase 1 内部里程碑

```
M-A  Phase 2 done   → 修完 TS 错 + host-mode 跑通
M-B  Phase 3 done   → docker compose 整合
M-C  Phase 4 done   → ★ 关键节点 ★ Lima runner + LimaInfraProvider
M-D  Phase 5/6/7 done → 边缘 + 观测 + admin UI
M-E  Phase 8 done   → smoke 全通,Foundation 完工
```

不绑死日期。Solo 估算:M-A 2d / M-B 1d / M-C 3d / M-D 1.5d / M-E 1d = **总计 ~8-9 个有效日**。

---

## 6. Phase 2 — MVP 业务功能(Foundation 完成后)

按 §3 Gap 分析顺序推进。仅列优先级,不绑日期。

### 6.1 优先级排序

| 优先 | 任务 | 工作量 | 依赖 |
|---|---|---|---|
| P0 | Box lifecycle e2e + 错误信息可读化 | 1d | Foundation |
| P0 | Quota enforcement 全路径核对 | 2d | Foundation |
| P0 | **Autoscaler 设计与实现**(§7) | 3-4d | Foundation Phase 4 |
| P1 | Admin Dashboard 5 页精简 + 数据接通 | 2d | Foundation |
| P1 | TOPSIS 调度日志增强 | 0.5d | Foundation |
| P1 | Usage / Resource utilization 视图 | 1d | Foundation |
| P2 | SLI 监控(box-create 失败率、runner-overload)| 1d | Foundation |
| P2 | feature flag 框架接入 OpenFeature | 0.5d | Foundation |

### 6.2 MVP 完成判据

- [ ] 客户通过 `/v1/boxes` API 完成 create → start → exec → stop → delete
- [ ] 操作员通过 admin dashboard 看到 5 个核心页且数据真实
- [ ] AutoscalerService 在本地 Lima 触发 up 一次、down 一次,无 box 丢失
- [ ] AutoscalerService 在 staging AWS 跑通一次 EC2 up/down
- [ ] 配额触发场景返回 403 + 明确错误,不创建 box 实体
- [ ] runner crash 后 health check 自动剔除,新 box 不再去
- [ ] Demo 视频 ≤ 3 分钟跑通

---

## 7. Autoscaler 设计(技术细节,Phase 2 实施)

### 7.1 现有"扩缩容判断材料"(Daytona 已给)

| 已有 | 用途 |
|---|---|
| `Runner.entity` 上的 `currentCpu/Memory/DiskUsage` | 实时容量 |
| `RunnerService.computeAvailabilityScore()` TOPSIS 评分 | 单 runner 健康度 |
| `Runner.draining` / `Runner.unschedulable` 字段 | 排空标记 |
| `handleCheckDecommissionRunners` cron | 自动 decommission 流 |
| `RunnerEvents.STATE_UPDATED` | 状态变更事件 |

Daytona 已经给了"判断材料",缺的是"扳动 EC2/Lima 的手"。

### 7.2 三层 InfraProvider

```
                ┌──────────────────────────────────────┐
                │  AutoscalerService(新增,NestJS)     │
                │  @Cron(EVERY_MINUTE)                  │
                │                                       │
                │  1. 拉取 runners 列表 + score        │
                │  2. 判断:                            │
                │     - 平均 score < 0.4 + 失败排队 N+ │
                │       → scaleUp()                    │
                │     - score > 0.8 + 最低载 runner    │
                │       连续 15min 无新 box            │
                │       → scaleDown(low runner)        │
                │  3. 调 InfraProvider 落地           │
                └──────────────────────────────────────┘
                            │
                            ▼
                ┌──────────────────────────────────────┐
                │  IInfraProvider 抽象接口              │
                │  - provisionRunner(spec)             │
                │  - terminateRunner(runnerId)         │
                │  - describeRunner(runnerId)          │
                └──────────────────────────────────────┘
                    │              │              │
                    ▼              ▼              ▼
            ┌──────────────┐ ┌──────────────┐ ┌────────────────┐
            │ AwsInfra-    │ │ LimaInfra-   │ │ MockInfra-      │
            │ Provider     │ │ Provider     │ │ Provider        │
            │ (生产)       │ │ (本地)       │ │ (单元测试)      │
            └──────────────┘ └──────────────┘ └────────────────┘
```

接口签名(TypeScript):

```ts
interface IInfraProvider {
  /** 创建新 runner 实例,返回 endpoint。包含 user-data / cloud-init 全部 wiring */
  provisionRunner(spec: RunnerSpec): Promise<RunnerEndpoint>

  /** 销毁 runner 实例(仅在 DECOMMISSIONED 状态后调用)*/
  terminateRunner(runnerId: string): Promise<void>

  /** 健康探测:实例是否还存在(用于调和 DB 与云侧/Lima 侧状态) */
  describeRunner(runnerId: string): Promise<RunnerInstanceInfo>
}
```

### 7.3 关键决策

| 问题 | 决策 |
|---|---|
| Scale 触发指标 | TOPSIS 平均 score + 调度失败计数 + 队列深度(三选一) |
| Scale-up 冷却 | 2 分钟(避免抖动) |
| Scale-down 冷却 | 15 分钟(确保不是临时低载) |
| 最小池子 | 2 台(单点风险) |
| 最大池子 | 可配置,默认 5(防失控) |
| Provision 方式 | AWS:RunInstances + user-data;Lima:`limactl start` + systemd unit |
| Terminate 安全 | 必须 `draining=true` → `state=DECOMMISSIONED` → 再 terminate,不跳步 |
| Spot 实例 | MVP 不引入,统一 on-demand;Spot 留 v2 |

### 7.4 为什么不直接用 AWS ASG

| 方案 | 优点 | 缺点 | 选择 |
|---|---|---|---|
| 自家 AutoscalerService | 直接复用 TOPSIS + drain 流;细粒度 | 自己写 | ✅ |
| AWS Auto Scaling Group | 现成 | 不能感知 sandbox-aware 的 drain;实例替换会丢沙箱 | ❌ |
| Kubernetes + Cluster Autoscaler | 生态完整 | runner 不是 K8s pod | ❌ |
| Karpenter | 现代化 | 同上 | ❌ |

---

## 8. 风险与对策(solo 视角)

| 风险 | 影响 | 概率 | 对策 |
|---|---|---|---|
| **Phase 4 Lima 集成卡住**(网络/编译/launchd 兼容) | 阻塞 Foundation | 中 | 提前在 Lima 内手工编一次 runner 二进制验证可行性 |
| **AWS RunInstances IAM/配额** | 阻塞 Phase 2 autoscaler 生产侧 | 中 | Phase 1 中段就让 SRE 提前验证 IAM + 提交 quota 增加单 |
| **TS 错修完之后又冒新错** | 阻塞 Phase 2 | 中 | 一次性修彻底,跑两遍 `tsc --noEmit` 验证 |
| **solo 节奏失控**(context switching、拖延、完美主义) | 项目长期不收口 | **高** | **每个 Phase 设硬性"DoD 通过才进下一个"门**;**每周日盘点本周进度** |
| **Foundation 做完后,MVP scope 再次扩张** | 永远做不完 | 中 | §4 裁剪清单写死,后续不加新功能除非客户硬需求 |
| **Linear 项目 lead 不接受延期** | 外部压力 | 中 | 主动跟 lead 沟通,以"质量风险"为理由 + 提议分阶段交付 |

---

## 9. Foundation 完成判据(Phase 1 收口)

- [ ] `apps/infra-local/scripts/smoke.sh` 跑通(无 manual 介入)
- [ ] `make doctor` 全 probe 通过
- [ ] `make up && make down -v && make up` 幂等,无残留
- [ ] `make lima-up && make lima-down` 干净
- [ ] 10 个 `*.boxlite.test` 域名 HTTPS 都通
- [ ] Jaeger 能看到 box create 的完整 trace
- [ ] LimaInfraProvider 单元测试覆盖关键路径
- [ ] `apps/infra-local/README.md` 内 "what works today" 段与代码一致
- [ ] 老 `apps/local-dev/` 已删除(整合完成)

---

## 10. Phase 1 完成后(下一步预案)

按 §6 优先级,**逐项串行做**:

1. Box lifecycle 端到端补强 + 错误信息可读化(P0)
2. Quota enforcement(P0)
3. Autoscaler 实现(P0,本地用 LimaInfraProvider 测,staging 用 AwsInfraProvider)
4. Admin Dashboard 5 页 + 数据接通(P1)
5. TOPSIS 调度日志增强(P1)
6. Usage 视图(P1)
7. SLI(P2)

每完成一个就在本文记下,不积压。

---

## 11. MVP 之后(Phase 2 完成后)

仅记录,不做:

- 计费 / Wallet / Spending
- 多 region 调度
- Spot 实例
- Webhooks 给用户
- Linked accounts / 自助注册
- 整体 Go 服务精简(`snapshot-manager` 用上游 `registry:2.8.2`、`otel-collector` 用 `otelcol-contrib`)
- 仓库目录重命名 `apps/` → `cloud/`(语义更准)
- 把 `apps/runner/pkg/daemon/` 死代码删干净
- Native HVF runner(如果还有人想要)

---

## 12. 下一步动作(今天 / 明天)

**立即开干 Phase 2:修 159 个 TS 错**——这是 Foundation 整个链条的硬阻塞。

### 12.1 具体步骤(参照 §5.2 Phase 2)

1. 备份当前分支状态(已有)
2. 把 `feat/local-dev-fullstack` 合到 / cherry-pick 到当前工作分支
3. 一次性改 5 处根因(详见之前盘点):
   - `apps/api/tsconfig.json` extends 路径
   - `apps/api/src/audit/decorators/audit.decorator.ts` 类型
   - `apps/api/src/interceptors/metrics.interceptor.ts` helper
   - `apps/api/src/sandbox/sandbox.module.ts` 删 2 个 deprecated controllers
   - paths mapping 验证
4. 跑 `cd apps && ./node_modules/.bin/tsc -p api/tsconfig.app.json --noEmit` 验证 0 错
5. 跑 `yarn nx build api` 验证 webpack 也过
6. 跑 `yarn nx serve api` 验证服务起来
7. 处理 Nx WORKDIR(让 host serve 真的工作)
8. 验证 `yarn nx serve dashboard` 也起来,可以登录 dex

预计 **1-2 个工作日**(solo,含调试 + 验证)。

### 12.2 在本文记录进度

完成一个 Phase 就在 §5.2 对应小节打 `✅`,失败时附简短原因,持续推进。

---

## 13. 备份

旧版本(MVP 8 天版,有 6 人团队分工):`docs/apps/cloud-mvp-plan.md.bak-mvp-deadline-version`
