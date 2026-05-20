# `apps/infra/` vs `apps/infra-local/` 对比

> 输入背景:`docs/apps/cloud-mvp-plan.md` §5b(M0 Local Dev Foundation)
> 当前进度:`apps/infra-local/` Phase 0+1 已完成,Phase 2-8 待做(Foundation 优先)

---

## 1. `apps/infra-local/` 整体方案概要

**一句话**:用 docker-compose + 少量 host-native 进程 + Lima Linux VM,**在一台 MacBook 上跑出 `apps/infra/`(AWS SST)的等效全栈**,让 6 个工程师不依赖 AWS staging 就能开发、调试、压测、跑 autoscaler 端到端。

### 1.1 核心拓扑

```
macOS host(M5)
├─ docker compose (boxlite-local 网桥)
│   ├─ postgres + redis              (状态)
│   ├─ dex                           (OIDC)
│   ├─ minio + minio-init            (对象存储,S3 协议)
│   ├─ registry:2                    (镜像仓库,替代 SnapshotManager)
│   ├─ caddy                         (边缘,*.boxlite.test wildcard TLS)
│   ├─ otel-collector                (可观测,轻量)
│   ├─ proxy + ssh-gateway           (边缘服务,直接用 apps/ 的镜像)
│   └─ mock-runner / (无 runner)      (老 compose 提供;新方案不在这层)
│
├─ host-native 进程(hot reload)
│   ├─ yarn nx serve api             (NestJS @ :3000)
│   ├─ yarn nx serve dashboard       (Vite @ :5173)
│   └─ dns-shim(launchd)            (响应 *.boxlite.test → 127.0.0.1)
│
└─ Lima Linux VM(动态起停)
    ├─ runner-1                     (Go,真 microVM via libkrun + KVM)
    ├─ runner-2                     (LimaInfraProvider 通过 limactl 扩缩)
    └─ ...
```

### 1.2 关键设计决策(已确定,Foundation-first 视角)

- ✅ **Lima Linux VM 跑真 runner**(跳过 Native HVF,**详见 §2**)
- ✅ **Caddy 完整路由**(api / dashboard / `*.proxy` / ssh / auth / registry / s3 / jaeger / pgadmin / registry-ui)
- ✅ **完整观测栈**:OtelCollector + Jaeger UI(`jaegertracing/all-in-one:1.67.0`,跟生产同款)
- ✅ **选择性 admin UI**:PgAdmin + RegistryUI 上(debug 价值高);MailDev 不上(无邮件流场景)
- ✅ **目标平台**:macOS Apple Silicon(M-series)单一支持,Intel/Linux/Windows out of scope

---

## 2. 为什么 Lima 而不是 Hypervisor.framework(决策档案)

BoxLite runtime 已经**同时支持**两种 hypervisor 后端:

```
macOS:   Hypervisor.framework + libkrun  →  microVM
Linux:   KVM + libkrun                   →  microVM
```

直观看 macOS 本地用 HVF 应该最省事——少一层 Lima VM、启动即时、内存占用低。但 Foundation 视角下,**Lima 路线才是对的**。决策原因如下。

### 2.1 概念区分:Hypervisor 不等于 Runner Host

容易混淆的一点:

| 层 | 单位 | 数量级 |
|---|---|---|
| **microVM(sandbox)** | 一个 libkrun 实例 | 一个 runner 可同时管几十~上百个 |
| **runner** | 一个 Go 进程,在 host 上管理 microVM | 一个 host 通常一个 runner |
| **runner host** | EC2 实例 / Lima VM / 物理机 | autoscaler 调整这一层 |
| **hypervisor 后端** | HVF / KVM | 决定 microVM 怎么跑,跟 runner host 是正交的 |

BoxLite 的 "HVF 支持" 解决的是 **"microVM 在 macOS 上怎么跑"**,**不是** "macOS 上能不能跑多个 runner host"。这是两件事。

### 2.2 Native HVF 路线的根本短板

如果选 Native HVF,实际形态:

```
   MacBook M5(host)
      │
      ├─ runner 进程(macOS native binary)
      │   └─ 用 HVF 创建 N 个 microVM
      │
      └─ ❓ 想加第二个 runner?
         ├─ 在同一 Mac 上再起一个 runner 进程
         ├─ 端口冲突自己管(3003 / 3004 / ...)
         ├─ 共享 Mac 的 CPU/RAM,资源无隔离
         ├─ 在生产里"runner 2 是另一台 EC2"——这里是同一台 Mac 的另一个进程
         └─ 不是同一种东西
```

**autoscaler 真正要扩的是 "runner host" 这一层**。Native HVF 路线下,一台 Mac 本质上**只有一个 runner host**(就是这台 Mac 自己),**没法模拟"加一台新 host"** 这个 autoscaler 的核心动作。

可以在同一 Mac 上跑多个 runner 进程做"伪多 runner",但:

| 问题 | 后果 |
|---|---|
| 共享 host 网络命名空间 | 没法测网络分区 / 跨 host 路由 |
| 共享 CPU / RAM / 磁盘 | 没法测资源耗尽 / 资源隔离 |
| 端口分配靠手工 | 测试脚本复杂,易冲突 |
| 杀进程 ≠ 杀 host | 模拟不了 "EC2 instance failure" 这种核心故障 |
| 跟生产架构不对应 | autoscaler 在本地写出的逻辑,移到 AWS 上可能行为不同 |

### 2.3 Lima 路线的形态

```
   MacBook M5(host)
      │
      ├─ 控制面(host process + docker-compose,见 §1.1)
      │
      ├─ Lima VM 1(Ubuntu arm64,vz driver)
      │   └─ /dev/kvm available
      │       └─ runner 进程(Linux native binary)
      │           └─ 用 KVM + libkrun 创建 N 个 microVM
      │
      ├─ Lima VM 2(同上,自己 IP / 端口空间 / 资源)
      │   └─ runner 进程
      │
      └─ Lima VM 3(同上)
          └─ runner 进程
```

每个 Lima VM = 一个真正意义上的 "host":

- 独立 IP / 端口空间 / hostname
- 独立 CPU / RAM / 磁盘 quota(`limactl` 配置)
- 独立 Linux 内核(可单独 reboot / suspend)
- `limactl start/stop/delete` 直接对应 "EC2 RunInstances / TerminateInstances"

### 2.4 关键维度对比

| 维度 | Native HVF | Lima Linux | 备注 |
|---|---|---|---|
| **真正的多 runner host** | ❌ | ✅ | autoscaler 测试的核心需求 |
| **生产 parity**(数据面同源) | ❌ HVF 后端 | ✅ KVM 后端,跟 EC2 一样 | 见 §2.5 |
| **资源隔离** | ❌ 共享 Mac | ✅ VM 独立 quota | 测资源耗尽用 |
| **网络隔离** | ❌ 同一 host | ✅ 不同 IP/network | 测跨 host 路由 / NAT |
| **故障注入** | 杀进程(简单)、网络分区(做不到) | 杀 VM(`limactl stop`)、暂停(`limactl stop`)、断网(VM 内 iptables)| chaos test 必备 |
| **InfraProvider 抽象 fit** | 牵强(不知道 provisionRunner 该做什么)| 自然(`limactl start` ↔ `RunInstances`)| 见 §2.6 |
| **InfraProvider 实施工作量** | 几乎做不出有意义的实现 | 2-3 人天(写 LimaInfraProvider) | Lima 多 2-3 天前期 |
| **microVM 启动延迟** | 即时 | 即时(microVM 已在 Lima 内) | Lima VM 本身启动 ~30s,但 microVM 启动后跟 HVF 一样快 |
| **Mac 资源消耗** | 低(一个 runner 进程) | 高(每个 Lima VM 1-2GB RAM) | 24GB M5 可同时跑 2-3 个 Lima |
| **工具链成熟度** | 自己造 multi-runner 管理 | Lima 框架成熟,vz driver 默认 | Lima 是 lima-vm/lima 维护 |
| **维护负担(长期)** | 高(自己写多 runner 协调) | 低(Lima 已有) | |

### 2.5 生产 parity 这一项最关键

**Foundation 是要长期作为开发与测试的基线**,生产 parity 比启动速度重要得多。

```
生产数据面:
  EC2 c8i.2xlarge  ──►  Linux 内核  ──►  KVM  ──►  libkrun (KVM backend)  ──►  microVM

Lima 本地数据面:
  Lima VM (Ubuntu) ──►  Linux 内核  ──►  KVM  ──►  libkrun (KVM backend)  ──►  microVM
                       ↑                         ↑
                  完全一样                   完全一样的 libkrun 二进制路径

HVF 本地数据面:
  macOS            ──►  HVF        ──►        libkrun (HVF backend)  ──►  microVM
                       ↑                         ↑
                  跟生产不同                 不同的 libkrun 代码路径
```

**含义**:

- Lima 里测出来的 runner / microVM / autoscaler 行为,**几乎可以保证在生产 EC2 上一致**
- HVF 里测出来的,**可能在生产复现不了 / 生产 bug 在本地复现不了**——data plane 是两套代码路径
- 对于"长期可信的 Foundation",**parity 是不可妥协项**

### 2.6 InfraProvider 抽象的天然 fit

Autoscaler 通过 `IInfraProvider` 接口操纵 runner host:

```ts
interface IInfraProvider {
  provisionRunner(spec): Promise<RunnerEndpoint>
  terminateRunner(runnerId): Promise<void>
  describeRunner(runnerId): Promise<RunnerInstanceInfo>
}
```

| 接口方法 | AwsInfraProvider | LimaInfraProvider | "HvfInfraProvider"(假想) |
|---|---|---|---|
| `provisionRunner` | `RunInstances` + user-data | `limactl start` + systemd unit | **?** —— 在 Mac 上加一个进程?那不是"host" |
| `terminateRunner` | `TerminateInstances` | `limactl stop && limactl delete` | `kill <pid>`?不释放资源 |
| `describeRunner` | `DescribeInstances` | `limactl list` | `ps`?不知 host 健康 |

Lima 接口跟 AWS **形态完全对应**——`limactl` 命令的语义跟 EC2 API 一一对应,代码模式都一样。HVF 路线根本写不出有意义的 provider,因为它本来就不是 "host provisioning" 的工具。

### 2.7 资源预算(24GB M5)

| 单元 | 占用 | 数量 | 小计 |
|---|---|---|---|
| macOS 系统 + Docker Desktop + IDE | ~6 GB | 1 | 6 GB |
| docker compose 控制面(postgres/redis/dex/minio/registry/caddy/otel/jaeger/pgadmin)| ~3 GB | 1 | 3 GB |
| host 进程(api + dashboard 跑 Node)| ~2 GB | 1 | 2 GB |
| Lima VM(runner host) | ~2 GB | 2-3 | 4-6 GB |
| 每个 microVM | ~256 MB | 1-5 个并发 | 1-2 GB |
| **总计** | | | **16-19 GB** |

留 4-7 GB 缓冲给 Slack / 浏览器 / VS Code 各种插件,**24 GB 够用**。

> 如果想同时跑 5+ Lima runner 做压测,内存会吃紧——但 Phase 2 autoscaler 测试 2-3 个 runner 就够验证 up/down 逻辑。压测 N runner 留到生产 staging。

### 2.8 结论矩阵

| 决策维度 | 重要性 | 推荐 |
|---|---|---|
| Autoscaler 多 host 测试 | 🔴 关键 | **Lima** |
| 生产 parity | 🔴 关键 | **Lima** |
| 故障注入能力 | 🟡 重要 | **Lima** |
| 启动速度 | 🟢 次要 | HVF |
| Mac 资源消耗 | 🟡 重要(但够用) | HVF |
| 维护工具链复杂度 | 🟢 次要 | **Lima**(框架成熟) |
| upfront 实施成本 | 🟢 次要(2-3 天) | HVF |
| 长期 ROI | 🔴 关键 | **Lima** |

**6 红 vs 0 红 + 部分黄绿** → Lima。

### 2.9 何时此决策需要 revisit

- 若 BoxLite 决定**正式支持 macOS 作为生产 runner host**(比如 Mac mini cluster on-prem),HVF 路线的 parity 反而成为优势
- 若 Lima vz driver 在某个 macOS 版本上挂掉、长期无修复
- 若团队开发机器普及到非 Mac 设备(Linux 主力 dev box)

短期(2026 内)不预期触发任何一条,**决策稳定**。

---

## 3. 逐项对比表

| 维度 | **`apps/infra/`(生产)** | **`apps/infra-local/`(本地)** |
|---|---|---|
| **目标** | AWS 上跑 BoxLite cloud 控制面 + 数据面 | 一台 MacBook 上跑等效全栈,开发循环 < 30s |
| **IaC 工具** | **SST v4 + Pulumi**(`sst.config.ts`)| **Make + docker-compose + shell scripts**(`Makefile` + `scripts/*.sh`) |
| **部署命令** | `sst deploy` | `make -C apps/infra-local up` |
| **首次部署耗时** | ~20-40 分钟(VPC、RDS、ECS、CloudFront 都要创建)| ~10-15 分钟(主要是 docker pull + yarn install) |
| **日常启动耗时** | N/A(常驻)| ~30 秒(`docker compose up -d` + `yarn nx serve`)|
| **运行成本** | 几百~几千美金/月(VPC NAT、EC2、RDS、ElastiCache、CloudFront)| **$0**(本机) |
| **目标平台** | AWS `ap-southeast-1` | macOS Apple Silicon(M1/M2/M3/M4/M5)|
| **网络** | VPC + ALB(`Api` ALB:443、`Proxy` ALB:443、`SshGateway` NLB:2222)+ NAT EC2 | docker bridge `boxlite-local` + Caddy `*.boxlite.test:443` + `dns-shim` 响应 |
| **DNS** | Route53 + 客户自带域名 | **`dns-shim`**(Go,launchd 启动,响应 `*.boxlite.test` → `127.0.0.1`)+ macOS `/etc/resolver/boxlite.test` |
| **TLS** | ACM 颁发 + ALB 终止 | **mkcert 本地 CA + wildcard 证书** + Caddy 终止 |
| **数据库** | RDS `t4g.micro` Postgres 16 | `postgres:16-alpine` 容器,`pg-data` volume |
| **缓存** | ElastiCache Redis(单节点)| `redis:7-alpine` 容器 |
| **对象存储** | S3 Bucket(`Storage`)+ IAM 用户 | **MinIO**(S3 协议兼容)+ `mc` init 容器 |
| **镜像仓库** | `SnapshotManager` ECS Service(distribution/distribution + S3)| `registry:2`(`:5050`,本地文件系统;避开 macOS AirPlay 占用的 `:5000`)|
| **OIDC IdP** | **外部 Auth0/Okta**(`sst.config.ts:181` 显式注释 "No in-cluster Dex")| **`apps/dex/` 容器**(默认用户 `admin@boxlite.dev` / `password`)|
| **`api` 服务** | ECS Service,容器镜像,ALB :443 | **host-native `yarn nx serve api`**(:3000,hot reload)— 不跑容器 |
| **`dashboard`** | 静态资产 + CloudFront | **host-native `yarn nx serve dashboard`**(:5173,Vite hot reload) |
| **`proxy`** | ECS Service `:4000` | docker compose service(`profiles: [full]`)|
| **`ssh-gateway`** | ECS Service NLB `:2222` | docker compose service(`profiles: [full]`)|
| **`snapshot-manager`** | ECS Service(自家 Go) | **不跑**(直接用 `registry:2`,只在 `--profile full` 下挂个 SnapshotManager 容器走 parity 测) |
| **`runner`** | **EC2 单实例** `c8i.2xlarge`(nested KVM,user-data 拉二进制)| **mock-runner**(Node 桩,默认)+ **Lima Linux VM**(真 microVM via libkrun + KVM,LimaInfraProvider 扩缩) |
| **`daemon`(在 sandbox 内)** | 由 runner 通过镜像 bake 进 sandbox OCI | 同生产(Lima 内的 microVM 用同一镜像) |
| **`otel-collector`** | ECS Service(自家发行版 + boxlite_exporter)| 同(容器,轻量配置)|
| **Jaeger UI** | ECS Service `:16686` | **容器 `jaegertracing/all-in-one:1.67.0`**(跟生产同款),Caddy 暴露 `jaeger.boxlite.test` |
| **PgAdmin / RegistryUI / MailDev** | ECS Services(`Daytona` 留的运维 UI)| **PgAdmin + RegistryUI 上**(debug 高频);**MailDev 不上**(无邮件流场景)|
| **CDN** | CloudFront(`ApiCdn` Router)| **不需要**(本机直连)|
| **Autoscaler InfraProvider** | `AwsInfraProvider`(`ec2.RunInstances` + Launch Template) | **`LimaInfraProvider`**(`limactl start/stop/delete`) |
| **Sandbox 隔离** | KVM(EC2 nested)+ libkrun microVM | KVM(Lima Linux VM)+ libkrun microVM(完全同源) |
| **Sandbox 网络** | gvproxy + 192.168.127.0/24(VM 内)| 同 |
| **Sandbox URL(port preview)** | `https://<port>-<sandboxId>.proxy.<your-domain>` | `https://<port>-<sandboxId>.proxy.boxlite.test`(Caddy 通配符路由)|
| **Secrets** | SST 自动生成 + Secrets Manager + IAM | **`.env` 文件**(明文,本地约定不进 git;`apps/local-dev/.env` 模板)|
| **状态持久化** | RDS 持久化卷 + S3 + EC2 EBS | docker named volumes(`pg-data`、`minio-data` 等;`docker compose down -v` 可一键清空) |
| **多 runner 支持** | EC2 ASG / 手动加(Phase 2 autoscaler 完成后) | **多 Lima VM**(每个 Lima 一个 runner,limactl 管理)|
| **可观测性** | OTel → Jaeger / ClickHouse / Prometheus / CloudWatch | OTel collector + Jaeger UI(`:16686`);ClickHouse / CloudWatch 不上,日志 `docker logs` 替代 |
| **健康检查** | ALB 健康检查 + ECS task health | docker compose `healthcheck` + `make doctor` 脚本(系统/网络/工具/服务多层探测) |
| **日志** | CloudWatch Logs + OTel | docker logs + 标准 stdout |
| **回滚/版本** | SST + EC2 + ECR | `git checkout` + `docker compose down/up` |
| **新人 onboarding** | 需要 AWS 账号 + IAM + VPC 权限 | **3 个命令**(`brew install ...` + `make setup` + `make up`)|
| **谁用** | 客户、SRE、压测 | **6 人开发团队的日常**(M0 Foundation 之后) |
| **修改后反馈延迟** | `sst deploy` ~5-15 分钟 | **代码改动 → hot reload < 5 秒**(NestJS、Vite 都有) |
| **跨平台** | 仅 AWS | 仅 macOS Apple Silicon(Intel Mac 可跑但 native runner story 弱) |
| **依赖 docker?** | 仅 build 阶段 | **是,必装 Docker Desktop ≥ 4.30** |
| **License / 第三方** | 注册第三方 quota / 备案 | 全本机,无注册压力 |
| **CI 集成** | 通过 `sst deploy` 跑 ephemeral env | 可用 GitHub Actions Mac runner 跑 `make ci`(Foundation 之后再做)|

---

## 4. 不对称对照

### 4.1 local-infra **多出来**的东西(生产不需要)

| 项 | 为什么 local 才需要 |
|---|---|
| **`dns-shim`(Go)** | 生产用 Route53,本地需要劫持 `*.boxlite.test` |
| **`mkcert`** | 生产用 ACM,本地需要自签发 wildcard 证书 |
| **`/etc/resolver/boxlite.test`** | macOS scoped resolver 把指定 TLD 路由到 dns-shim |
| **`launchd` plist** | dns-shim 后台常驻 |
| **`doctor.sh`** | 检查 mkcert / lima / docker / dns / port 占用等 30+ 项 |
| **`apps/infra-local/patches/`** | 暂时让 API/Dashboard 在 host-mode 编译通过(M0 修完 TS 错就不需要)|
| **mock-runner** | 不想起 Lima 时的桩 |
| **`LimaInfraProvider`** | autoscaler 在本地的 InfraProvider 实现 |

### 4.2 local-infra **不要**的东西(生产才需要)

| 项 | 为什么本地不需要 |
|---|---|
| VPC / NAT / Subnets | docker bridge 替代 |
| ACM / Route53 | mkcert + dns-shim 替代 |
| ALB / NLB / TargetGroups | docker port publish + Caddy |
| ECS Cluster + TaskDefinition | docker compose |
| CloudFront | 本机直连 |
| RDS / ElastiCache / S3 | 容器化等价物 |
| IAM Roles + Policies | 本地无权限边界(信任开发者)|
| EC2 Launch Template | Lima 起 VM |
| SST Secrets Manager | `.env` 文件 |
| MailDev | 无邮件流场景,不上;ClickHouse / CloudWatch 用 `docker logs` + Jaeger 替代 |

---

## 5. 服务名 / 端口 / URL 一致性(关键)

**两套环境保留同样的"服务名 / 端口 / API URL 模式"**,代码无需感知运行在哪里:

| 概念 | 生产 | 本地 |
|---|---|---|
| api 域 | `api.<your-domain>` | `api.boxlite.test`(Caddy)/ `localhost:3000`(直连)|
| api 端口 | 3000(容器内)| 3000 |
| dashboard 域 | `<your-domain>` | `dashboard.boxlite.test` / `localhost:5173` |
| proxy 端口 | 4000(ALB :443 转)| 4000(Caddy :443 转)|
| ssh-gateway 端口 | 2222 | 2222 |
| port preview URL | `<port>-<id>.proxy.<your-domain>` | `<port>-<id>.proxy.boxlite.test` |
| OIDC issuer | `<auth0>.com/...` | `localhost:5556`(Dex)|
| OTLP HTTP | 4318(集群内 collector)| 4318(本机 collector)|
| 镜像仓库 | `<sst-out>.elb...:80` | `localhost:5050` |
| 对象存储 | S3 | MinIO `localhost:9000`(API)+ `localhost:9001`(console)|

---

## 6. 关键文件指引

| 路径 | 内容 |
|---|---|
| `apps/infra/sst.config.ts` | 生产 IaC,SST + Pulumi |
| `apps/infra-local/Makefile` | 本地一键命令入口(`make up/down/doctor/...`)|
| `apps/infra-local/scripts/doctor.sh` | 30+ 项环境健康检查 |
| `apps/infra-local/scripts/lib.sh` | 共享 shell 工具(平台 guard / colours / env 加载)|
| `apps/infra-local/dns/dns-shim/main.go` | DNS 拦截器(Go,响应 `*.boxlite.test`)|
| `apps/infra-local/runner/launchd/ai.boxlite.dns.plist` | launchd 接入 |
| `apps/infra-local/runner/install.sh` / `uninstall.sh` | LaunchAgent 装卸 |
| `apps/infra-local/caddy/Caddyfile` | wildcard 域名 TLS + 路由 |
| `apps/infra-local/tls/README.md` | mkcert 流程说明 |
| `apps/local-dev/docker-compose.local.yml`(老版,部分会合并)| 6 个底层服务 |
| `apps/local-dev/mock-runner/server.mjs` | mock runner |
| `apps/local-dev/smoke.sh` | 烟雾测试 |
| `docs/superpowers/specs/2026-05-19-apps-infra-local-design.md` | 620 行设计 spec |
| `docs/superpowers/plans/2026-05-19-apps-infra-local.md` | 3046 行 8-phase 实施计划 |
| `docs/apps/cloud-mvp-plan.md` §5 | Phase 1 — Foundation 详解(8 phase 实施 + Lima runner 设计)|

---

## 7. 一句话总结

> `apps/infra/` 把 BoxLite 部到 AWS;`apps/infra-local/` 把同一套服务**就地等效化**到 MacBook —— 把每个云资源换成容器或 host 进程,把 Auto Scaling Group 换成 Lima VM 池,把 Route53 换成本机 DNS shim,把 ACM 换成 mkcert,**保持服务名 / 端口 / API 形态 / sandbox URL 模式与生产一致**,代价仅是几条 brew + `make up`。
