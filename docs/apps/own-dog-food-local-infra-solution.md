# Own-Dogfood Local Infra Solution

> **设计目标**:基于 BoxLite Python SDK 重新实现 `apps/infra-local/`,**用 BoxLite box 取代 docker 容器** 跑控制面服务,落实 "eat your own dogfood" 原则。
> **关联**:
> - 上一版方案见 [`docs/apps/infra-vs-local-infra.md`](./infra-vs-local-infra.md)
> - 原则记录:memory `feedback_eat_your_own_dogfood.md`
> - 平台目标:Mac M5,24GB(memory `feedback_infra_local_target_mac_m5.md`)
> - **状态**:**Phase 0 + 1 + 2 + 3a/3b/3c/3d + 完整 E2E ✅ 全部完成**(2026-05-21)。**11-box stack 端到端跑通**:pg / redis / minio / minio-init(one-shot)/ registry / dex / jaeger / pgadmin / registry-ui / otel-collector / caddy。**Caddy 反向代理打通全部上游**(`http://127.0.0.1:28080/<svc>/`)。
> - 现在的状态:`apps/infra-local/` 是一个 self-contained 的 dev stack。`make up` 一键拉起,`make wipe` 一键清空。
> - **测试覆盖**:35 unit tests + 1 smoke integration test + **10 comprehensive E2E tests**(真协议:pg SQL / redis SET-GET-INCR / minio S3 PUT-GET / registry v2 catalog / dex JWKS / jaeger query API / otel OTLP HTTP / caddy all 6 routes + 30s 稳定性 + 内存预算 3.5/8 GiB)。`make itest-all` 86s 跑完全部。
> - PoC 代码:`apps/infra-local/poc/single_service.py` + `multi_service.py` + `diagnose_network.py`
> - 实现代码:`apps/infra-local/boxlite_local/`
> - SDK 实战 gotcha(11 条):memory `feedback_boxlite_python_sdk_gotchas.md` + `apps/infra-local/README.md` § Known limitations
> - Spec 链:
>   - Phase 2 walking skeleton: [`docs/superpowers/specs/2026-05-20-infra-local-phase2-walking-skeleton.md`](../superpowers/specs/2026-05-20-infra-local-phase2-walking-skeleton.md)
>   - Phase 3a foundation: [`docs/superpowers/specs/2026-05-21-infra-local-phase3a-foundation-services.md`](../superpowers/specs/2026-05-21-infra-local-phase3a-foundation-services.md)
>   - Phase 3b admin-UI + dex: [`docs/superpowers/specs/2026-05-21-infra-local-phase3b-admin-ui-and-observability.md`](../superpowers/specs/2026-05-21-infra-local-phase3b-admin-ui-and-observability.md)
>   - Phase 3c Caddy + otel: [`docs/superpowers/specs/2026-05-21-infra-local-phase3c-caddy-and-otel.md`](../superpowers/specs/2026-05-21-infra-local-phase3c-caddy-and-otel.md)
> - 留给后续手动 + sudo 的工作(infra-local 之外):
>   - **dns-shim** + **mkcert -install**(需 root) → 启用 Caddy TLS + `*.boxlite.test` 域名 UX
>   - **custom otel-collector binary build**(需要完整 boxlite repo 的 nx/go/node toolchain) → 用 `apps/otel-collector/` 的真正 collector
>   - **Lima runner**(原 Phase 4) → 跑 sandbox 工作负载

---

## 0. Executive summary

**核心改动**:把原方案里所有 docker compose 服务,改为 BoxLite Python SDK 启动的 BoxLite box,每个 box 直接跑该服务的官方 OCI image。

```
原方案(docker):                       本方案(BoxLite):
─────────────────                     ──────────────────
docker compose up                     python -m boxlite_local up
  ├─ docker container: postgres         ├─ BoxLite box: postgres (OCI: postgres:16-alpine)
  ├─ docker container: redis            ├─ BoxLite box: redis    (OCI: redis:7-alpine)
  ├─ docker container: dex              ├─ BoxLite box: dex      (OCI: ghcr.io/dexidp/dex:v2.x)
  ├─ docker container: minio            ├─ BoxLite box: minio    (OCI: minio/minio)
  ├─ ...                                ├─ ...
  └─ docker container: jaeger           └─ BoxLite box: jaeger   (OCI: jaegertracing/all-in-one:1.67.0)
```

**关键设计选择**:

1. **不用 docker 也不用 docker-compose**——`apps/infra-local/` 目录里**零 Dockerfile**(除已有 BoxLite app 镜像引用)
2. **每个服务 = 一个独立 BoxLite box**(microVM 隔离,跟生产 sandbox 同源)
3. **Orchestrator 单一 Python entrypoint**,声明式 service registry(YAML/Python dataclass 混合,详见 §4)
4. **Runner 例外**:`boxlite-runner` 必须有 nested KVM,仍跑在 Lima Linux VM 内(详见 §3.3)
5. **网络模型**:host-as-hub(各 box 端口转发到 host,box 之间通过 host loopback 互访,详见 §3.4)

**收益**:

- ✅ Dogfood:任何 BoxLite 短板第一时间被团队感知
- ✅ Box 与生产 sandbox 完全同源(同一份 libkrun + KVM + OCI)
- ✅ 不需要 Docker Desktop(只需要 BoxLite + Lima)
- ✅ `boxlite-cli` 自动成为 admin 工具(`boxlite-cli ps`,`boxlite-cli logs`,`boxlite-cli exec` 直接可用)

**代价**:

- ⚠️ 每 box 内存高 (~256MB+ vs docker ~50MB) → §5.6 资源核算
- ⚠️ 启动慢(microVM boot ~5-10s vs docker ~1s)
- ⚠️ BoxLite 的某些 OCI 特性可能未全覆盖(需 PoC 验证,详见 §10)

---

## 1. BoxLite Python SDK 熟悉(Familiarization)

### 1.1 核心类与 API

```python
from boxlite import Boxlite, SimpleBox, BoxOptions

# 隐式 runtime(全局 default)
async with SimpleBox(image="postgres:16-alpine") as box:
    result = await box.exec("psql", "-c", "SELECT version()")
    print(result.stdout)
```

| 类 / 方法 | 作用 |
|---|---|
| `Boxlite.default()` | 拿全局 runtime |
| `Boxlite.rest(BoxliteRestOptions(...))` | 连接远程 boxlite serve |
| `SimpleBox(image, name, cpus, memory_mib, ports, volumes, env, auto_remove, reuse_existing)` | 创建/包装一个 box |
| `async with SimpleBox(...) as box:` | 启动 + 自动清理(`auto_remove=True` 时) |
| `await box.exec(cmd, *args, env=...)` | 在 box 内执行命令,返回 `ExecResult` |
| `box.id` / `box.info()` | 取元数据 |
| `runtime.list_info()` | 列所有 box |
| `runtime.get_or_create(opts, name=...)` | 幂等创建 |

### 1.2 跑 daemon 服务的标准模式

对于 postgres / redis 这种需要"长期运行 + 提供端口" 的服务,关键模式是 **`reuse_existing=True` + `auto_remove=False`**:

```python
async def start_postgres():
    rt = boxlite.Boxlite.default()
    box, created = await rt.get_or_create(
        BoxOptions(
            image="postgres:16-alpine",
            cpus=1,
            memory_mib=512,
            auto_remove=False,
            ports=[(5432, 5432)],
            volumes=[
                ("~/.boxlite-local/data/pg", "/var/lib/postgresql/data"),
            ],
            env=[
                ("POSTGRES_USER", "boxlite"),
                ("POSTGRES_PASSWORD", "boxlite"),
                ("POSTGRES_DB", "boxlite"),
            ],
        ),
        name="boxlite-local-pg",
    )
    if created:
        await box.start()
        await wait_healthy(box, "pg_isready -U boxlite")
    print(f"postgres ready: box={box.id}, port=5432")
    # 不要 __aexit__ —— 让 box 持续运行
```

**关键点**:
- `auto_remove=False` 让 box 在 Python 进程退出后**仍然活着**
- `reuse_existing=True`(在 `get_or_create` 里隐式)避免二次启动报错
- 不进入 `async with`,因为 `async with` 退出时会 stop;改用显式 `await box.start()`

### 1.3 端口转发

```python
ports=[(5432, 5432)]   # (host_port, guest_port)
```

`gvproxy` 把 host `127.0.0.1:5432` 转发到 box 内 `0.0.0.0:5432`。**注意 guest 必须 bind `0.0.0.0`,不是 `127.0.0.1`**(详见 `examples/python/02_features/forward_ports.py`)。

### 1.4 卷挂载

```python
volumes=[
    ("/host/abs/path", "/guest/path"),
    ("~/.boxlite-local/data/pg", "/var/lib/postgresql/data"),
]
```

支持 `~` 展开。Host 路径可以是 file 或 dir。

### 1.5 网络访问

每个 box 跑在 `192.168.127.0/24` 子网(BoxLite 默认 gvproxy 网络):

| 地址 | 角色 | 用途 |
|---|---|---|
| `192.168.127.1` | 默认网关(gvproxy)| box 出网的下一跳;**不要**当成 host 地址来连服务 |
| `192.168.127.254` / `host.boxlite.internal` | **host hub**(`HOST_IP` / `HOST_HOSTNAME` 常量) | 从 box 内访问宿主机上转发的端口 — BoxLite 对 Docker `host.docker.internal` 的对应物 |
| host port forwarding | 反向 | host `127.0.0.1:<host_port>` → box guest `0.0.0.0:<guest_port>` |

**Box → Box** 通信:没有内置 service-name DNS。Box A 调 Box B 的服务,最简单方案:**经 host hub**——B 的端口转发到 host,A 从 box 内访问 `host.boxlite.internal:<host_port>`(或字面 `192.168.127.254:<host_port>`)。

> ⚠️ 历史版本曾写"经 `192.168.127.1` 访问 host" — **不对**,那是网关,不是 host。Phase 1 PoC 实测确认必须用 `host.boxlite.internal` / `192.168.127.254`。

(进阶方案与坑见 §3.4 / §3.8)

### 1.6 BoxLite 能力验证(2026-05-20 PoC Phase 0 + Phase 1 实跑结果)

| 能力 | 验证结果 | 实测数据 |
|---|---|---|
| OCI image 直接拉取(Docker Hub `postgres:16-alpine` / `redis:7-alpine` / `alpine:3.20`) | ✅ | Phase 0 + 1 全部顺利 |
| Box 内运行 daemon 进程(不退出)是否稳定 | ✅ | postgres + redis 同时持续运行,health check 全过 |
| Box 启动延迟 | ⚠️ 冷启动 ~17s,reuse ~0.3s | 比 docker ~1s 慢一个数量级,但可接受 |
| gvproxy host→guest 端口转发 | ✅ 即时无延迟 | TCP probe 0.0s |
| `box.exec` API 工作 | ✅ | 但**签名是 `box.exec(cmd, [args_list])` 非 variadic**,见 §1.7 |
| Box 内 entrypoint / cmd / env / volumes | ✅ | 用 `BoxOptions(env=[(k,v),...], volumes=[(h,g),...])` 工作 |
| `detach=True` 让 box 跨 Python 进程存活 | ✅ | Phase 1 `--verify-detach` 通过:fresh Python 仍看到 3 box RUNNING |
| **Box-to-box 网络(host-as-hub via `host.boxlite.internal`)**| ✅ | Phase H/I/J/K:client-box `nc` / `psql` / `redis-cli` 全部通过 host.boxlite.internal 走通 |
| **`host.boxlite.internal` DNS 解析 + NAT** | ✅ | Phase H 显示 `Connection to host.boxlite.internal (192.168.127.254) <port> succeeded`;原报告的 #01 是环境冲突,非 SDK bug |
| 多 box 同跑(10+)资源测试 | 🟡 3 box 同跑通过,**全 10 box 待 Phase 3 验证** | M5 24GB 预算见 §5.1 |
| BoxLite OCI image remote pull 是否支持 private registry | ❓ | 待验证,生产无关 |

**结论**:**dogfood 方案技术可行,继续推进 PoC Phase 2**(orchestrator 骨架)。

### 1.7 PoC Phase 0 暴露的 SDK 使用约束(必读)

实跑过程中撞出几条 SDK 使用规则,详见 memory `feedback_boxlite_python_sdk_gotchas.md`。这里列影响 orchestrator 设计的几条:

#### A. `box.exec` 签名

**Native Box.exec 是 `exec(command, args=None, env=None, ...)`,args 是 list,不是 variadic *args**:

```python
# ❌ 会抛 TypeError("argument 'args': Can't extract `str` to `Vec`")
await box.exec("pg_isready", "-U", "postgres")

# ✅ 正确
await box.exec("pg_isready", ["-U", "postgres", "-t", "1"])
```

#### B. exec 返回 streaming Execution,不是 final result

```python
execution = await box.exec("ls", ["-la"])
stdout_chunks = []
async for chunk in execution.stdout():
    stdout_chunks.append(chunk)
result = await execution.wait()       # ← 等待并拿 exit_code
exit_code = result.exit_code
```

Orchestrator 需要封装 `exec_collect(box, cmd, args) → (exit_code, stdout, stderr)` 工具函数,屏蔽这个 streaming 细节。

#### C. `env` 类型不一致

| 接口 | `env` 类型 |
|---|---|
| `BoxOptions(env=...)` | `list[tuple[str, str]]` |
| `box.exec(cmd, env=...)` | `list[tuple[str, str]]` |
| `SimpleBox.exec(cmd, env=...)` | `dict[str, str]` |

orchestrator 内部统一用 `list[tuple]`,SDK 边界做转换。

#### D. detach reuse path 问题

`runtime.get_or_create(opts, name=...)` 复用已有 box 时,**忽略 opts 里的 detach / ports / volumes / env**,继续用现有 box 的配置。

含义:Orchestrator 必须显式处理 "现有 box 配置与请求不匹配" 的情况。建议设计:

```python
async def ensure_service(spec: ServiceSpec):
    info = await runtime.list_info()  # 找现有 box
    existing = next((i for i in info if i.name == f"boxlite-local-{spec.name}"), None)
    if existing and _config_differs(existing, spec):
        # 配置变了 —— 销毁重建
        await runtime.remove(existing.name)
        existing = None
    if existing is None:
        # 新建
        box = await runtime.create(spec.to_box_options(), name=...)
        await box.start()
    return box
```

或更简单:**始终用 `detach=True` 启动**,这样即使没显式 `--recreate`,box 也至少不会因 Python 退出而停。

#### E. import 路径选择

```python
# 防御性:.so 与 __init__.py 不同步时 fallback
try:
    from boxlite import Boxlite, BoxOptions
except ImportError:
    from boxlite.boxlite import Boxlite, BoxOptions
```

Orchestrator 顶层统一用这个 pattern。

#### F. Host port 卫生原则

BoxLite host-side port forward bind 在 `*:<port>`(wildcard)。macOS 内核路由按"最具体 socket 优先":如果开发机上有另一个进程 bind 在 `127.0.0.1:<port>`(具体地址),它会赢,box 内的流量会落到那个进程而非 box,症状是 TCP 通但应用层报错(role 不存在、密码不对、schema 不对…),极易误判成 SDK 问题。

**Orchestrator 设计原则**:
- 所有控制面服务使用 **非默认 host port**(见 §3.8 端口分配策略),guest 内部 port 保持 image 默认。
- `doctor` 子命令做**端口预检**:`lsof -nP -iTCP:<port> -sTCP:LISTEN`,如果非 boxlite 进程占用,即时报错而不是让用户 debug 半天。

---

## 2. 架构

### 2.1 整体拓扑

```
                  macOS host (M5, 24GB)
   ┌────────────────────────────────────────────────────────────────┐
   │                                                                │
   │  Python orchestrator (boxlite_local CLI)                       │
   │  └─ 用 BoxLite Python SDK 拉起 / 管理 / 监控 services           │
   │                                                                │
   │  BoxLite runtime (Boxlite.default() ── 单 runtime,多 box)     │
   │  │                                                              │
   │  ├─ Box: postgres        port host:5432 → guest:5432           │
   │  ├─ Box: redis           port host:6379 → guest:6379           │
   │  ├─ Box: dex             port host:5556 → guest:5556           │
   │  ├─ Box: minio           ports 9000+9001                       │
   │  ├─ Box: registry        port host:5050 → guest:5000           │
   │  ├─ Box: caddy           ports host:80,443 → guest:80,443      │
   │  ├─ Box: otel-collector  port host:4318                        │
   │  ├─ Box: jaeger          port host:16686                        │
   │  ├─ Box: pgadmin         port host:5050(可调)                 │
   │  ├─ Box: registry-ui     port host:5051(可调)                 │
   │  │                                                              │
   │  └─ Box: dns-shim       │   只有 dns-shim 与 Caddy 是必须 host  │
   │                         │   驻留(launchd / 端口 53、443)      │
   │                                                                │
   │  host process:                                                  │
   │  ├─ yarn nx serve api          (开发期 hot reload)              │
   │  └─ yarn nx serve dashboard    (开发期 hot reload)              │
   │                                                                │
   │  Lima VM (runner host)                                          │
   │  └─ boxlite-runner binary                                      │
   │      └─ 用 KVM + libkrun 创建 sandbox(BoxLite box)            │
   │         (每个 sandbox 也是 BoxLite box —— 与本地控制面同源)     │
   │                                                                │
   └────────────────────────────────────────────────────────────────┘
```

### 2.2 三层都是 dogfood

| 层 | 形态 | dogfood 状态 |
|---|---|---|
| **L1: 沙箱**(用户工作负载) | BoxLite box,OCI image | ✅(本来就是) |
| **L2: 控制面服务**(postgres / redis / dex / ...) | BoxLite box,OCI image | ✅(**本设计的新增**) |
| **L3: Runner** | Linux 二进制 in Lima VM | ⚠️ 例外(需 nested KVM) |

**"任何 OCI image 的执行都通过 BoxLite"** ——除了 runner 本身,因为它是 OCI executor 的实现层。

### 2.3 服务清单(10 个 BoxLite box)

| Box name | OCI image | 角色 | Host ports |
|---|---|---|---|
| `boxlite-local-pg` | `postgres:16-alpine` | 关系数据库 | 5432 |
| `boxlite-local-redis` | `redis:7-alpine` | 缓存 + 锁 + throttler | 6379 |
| `boxlite-local-dex` | `ghcr.io/dexidp/dex:v2.x`(用 `apps/dex/Dockerfile` build 的也行) | OIDC IdP | 5556 |
| `boxlite-local-minio` | `minio/minio` | S3 兼容存储 | 9000, 9001 |
| `boxlite-local-minio-init` | `minio/mc` | 一次性 bucket bootstrap | -(short-lived) |
| `boxlite-local-registry` | `registry:2` | OCI image registry | 5050 (→5000) |
| `boxlite-local-caddy` | `caddy:2-alpine` | 边缘 TLS + 路由 | 80, 443 |
| `boxlite-local-otel` | `otel/opentelemetry-collector:latest`(或本仓 `apps/otel-collector/Dockerfile`) | OTLP 接收 | 4318, 13133 |
| `boxlite-local-jaeger` | `jaegertracing/all-in-one:1.67.0` | Trace UI | 16686 |
| `boxlite-local-pgadmin` | `dpage/pgadmin4:9.2.0` | DB 管理 UI | 5051 |
| `boxlite-local-registry-ui` | `joxit/docker-registry-ui:main` | Registry 管理 UI | 5052 |

> MailDev 仍砍(无邮件流场景)。

### 2.4 Runner 路径(例外)

Runner 不在 BoxLite box 内,因为需要 `/dev/kvm`(nested virt 在 Mac HVF 上不可靠)。Runner 跑在 **Lima Linux VM**(已在前述方案中确定)。

Lima 内启动的 runner 二进制,**会创建的 sandbox 也是 BoxLite box** —— 跟控制面 box **复用同一个 runtime 抽象**,只是 namespace 不同(控制面 box 由本地 Python orchestrator 管,sandbox box 由 runner 管)。

### 2.5 dns-shim 与 launchd

`dns-shim`(响应 `*.boxlite.test` → 127.0.0.1)**只能跑在 host**,因为它需要劫持 macOS 系统 DNS。这部分**不变**,沿用现有 `apps/infra-local/dns/dns-shim/`。

---

## 3. 关键设计议题与决策

### 3.1 网络:Box 间通信

**问题**:Box A(api)需要连 Box B(postgres)。BoxLite 默认没有 service-name DNS。

**决策**:**Host-as-hub 模式**——所有 box 把自己端口转发到 host,box 间通信通过 BoxLite 的 host hub 地址 `host.boxlite.internal`(由 gvproxy DNS + NAT 解析到 host 上的 `127.0.0.1`)再回弹到目标 box。

```
   Box: api (in box, needs postgres)
       │
       │ connect → host.boxlite.internal:<PG_HOST_PORT>
       │           (gvproxy DNS 解析为 192.168.127.254)
       ▼
   Host (127.0.0.1:<PG_HOST_PORT>)   ← BoxLite host-side port forward bind 在 *:<PG_HOST_PORT>
       │ gvproxy 转发回 box
       ▼
   Box: postgres (guest 0.0.0.0:5432)
```

**优点**:
- 简单,所有服务都已经为 host 暴露端口(无额外配置)
- 跟生产 parity:生产里每个 EC2 也通过自己的 ALB/private IP 互访,概念上类似
- BoxLite SDK 不需要扩展(只用已有的 `host.boxlite.internal` + port forward 能力)

**缺点**:
- 每跳多一次 gvproxy 转发,延迟比 docker bridge 高 10-30×(实测 redis PING 13-50 ms vs docker ~0.5 ms),对开发循环可接受
- 端口在 host 上是全局的,**会跟开发机本地服务撞车**(见 §1.7.F 和 §3.8)

**应用规则**(写到 §6 service spec):
- 每个服务的 `BOXLITE_HOST_HUB` 注入为字符串 `"host.boxlite.internal"`(默认值,可被 env override)
- 服务间互访都用 `BOXLITE_HOST_HUB:<host_port>` 而不是 service name 或字面 IP
- **host port 用非默认值**(见 §3.8),guest port 保持 image 默认
- 文档化端口分配表(§3.8)

### 3.2 服务发现 / 配置注入

**问题**:api 需要知道 postgres 在 `host.boxlite.internal:25432`、redis 在 `host.boxlite.internal:26379`、dex issuer 在 `http://host.boxlite.internal:25556/dex`...

**决策**:**集中环境变量配置**(`.env` + service registry)+ **每个服务启动时注入**。

```python
# apps/infra-local/boxlite_local/config.py
@dataclass
class InfraConfig:
    # host hub address — box-side 用这个名字 reach back 到 host。
    # 默认 "host.boxlite.internal"(等价于 192.168.127.254 / HOST_IP),
    # 必要时可被 env BOXLITE_HOST_HUB override(比如 SDK 改 hostname 之后)。
    host_hub: str = "host.boxlite.internal"

    # 控制面服务的 host port 全部用非 5xxx 默认值,避免与开发机
    # 本地 brew / Docker Desktop / IDE-managed 服务撞车 — 见 §3.8。
    pg_host_port: int = 25432
    redis_host_port: int = 26379
    dex_host_port: int = 25556
    # ...

    @property
    def pg_url(self):
        return f"postgresql://boxlite:boxlite@{self.host_hub}:{self.pg_host_port}/boxlite"

    @property
    def dex_issuer(self):
        return f"http://{self.host_hub}:{self.dex_host_port}/dex"
```

每个 service spec 从这里取自己需要的环境变量,统一管理。

### 3.3 启动顺序与依赖

**问题**:api 启动前 postgres / redis / dex 必须就绪。

**决策**:**topological sort + 健康检查门**。

```python
SERVICES = {
    "postgres":     ServiceSpec(image=..., depends_on=[], healthcheck="pg_isready"),
    "redis":        ServiceSpec(image=..., depends_on=[], healthcheck="redis-cli ping"),
    "dex":          ServiceSpec(image=..., depends_on=["postgres"], healthcheck="curl /healthz"),
    "minio":        ServiceSpec(image=..., depends_on=[], healthcheck="curl /minio/health/live"),
    "minio-init":   ServiceSpec(image=..., depends_on=["minio"], one_shot=True),
    "registry":     ServiceSpec(image=..., depends_on=[]),
    "otel":         ServiceSpec(image=..., depends_on=[]),
    "jaeger":       ServiceSpec(image=..., depends_on=[]),
    "caddy":        ServiceSpec(image=..., depends_on=["minio", "registry", "dex", "jaeger"]),
    "pgadmin":      ServiceSpec(image=..., depends_on=["postgres"]),
    "registry-ui":  ServiceSpec(image=..., depends_on=["registry"]),
}
```

Orchestrator 拓扑排序后并行启动每一层,逐层等 healthcheck 通过。

### 3.4 持久数据卷

| 数据 | 路径 |
|---|---|
| Postgres | `~/.boxlite-local/data/pg/` |
| MinIO | `~/.boxlite-local/data/minio/` |
| Registry | `~/.boxlite-local/data/registry/` |
| Dex SQLite | `~/.boxlite-local/data/dex/` |
| Jaeger | (内存模式,不持久) |
| PgAdmin | `~/.boxlite-local/data/pgadmin/` |
| **配置文件**(host→box mount) | `apps/infra-local/configs/<svc>/` |

`make down -v` / `python -m boxlite_local down --wipe` 一键清空。

### 3.5 mkcert TLS 证书共享

`mkcert -install` 生成的 wildcard 证书是 host 上的文件。**Caddy box 需要读这个证书**——通过 volume mount:

```python
volumes=[
    ("~/.boxlite-local/tls/wildcard.pem", "/etc/caddy/wildcard.pem"),
    ("~/.boxlite-local/tls/wildcard-key.pem", "/etc/caddy/wildcard-key.pem"),
    ("apps/infra-local/caddy/Caddyfile", "/etc/caddy/Caddyfile"),
]
```

mkcert install 仍在 host 跑(`apps/infra-local/runner/install.sh` 已有)。

### 3.6 配置文件管理

每个服务的配置文件(dex `config.yaml`、caddy `Caddyfile`、otel `config.yaml`)放在 `apps/infra-local/configs/<svc>/`,**只读 mount 进 box**:

```python
# dex service spec
volumes=[
    ("apps/infra-local/configs/dex/config.yaml", "/etc/dex/config.yaml:ro"),
    ("~/.boxlite-local/data/dex", "/var/dex"),
]
```

跟 docker-compose 用法一致,迁移路径清晰。

### 3.7 Box 的"shell 友好性"

服务 box 跑的是官方 image,通常没有调试工具。开发者要排查问题怎么办?

**方案**:`boxlite-cli exec <box-name> -- sh`(BoxLite CLI 已有 exec 子命令),或 Python orchestrator 暴露 `python -m boxlite_local exec postgres -- psql`。

如需安装额外工具,可以选择跑 `:debug` 标签的 image(很多官方 image 有 `*-debian` 或 `*-busybox` 变体)。

### 3.8 Host port 分配策略

**问题**:开发者机器上往往装有 brew postgres / redis / 各种 dev 工具,它们 bind 在 `127.0.0.1:<default_port>`。BoxLite host-side port forward bind 在 `*:<port>`(wildcard),macOS kernel 按 "最具体 socket 优先" 路由 — 本机服务赢,box-side 服务收不到流量。症状是 TCP 通但应用层报错,极易误判(见 §1.7.F)。

**决策**:**控制面服务全部用非默认 host port**,guest 内部 port 保持 image 默认(image 内部约定不动)。

| 服务 | 默认 port | 本方案 host port | guest port |
|---|---|---|---|
| postgres | 5432 | **25432** | 5432 |
| redis | 6379 | **26379** | 6379 |
| dex | 5556 | **25556** | 5556 |
| minio API | 9000 | **29000** | 9000 |
| minio console | 9001 | **29001** | 9001 |
| registry | 5000 | **25000** | 5000 |
| otel HTTP | 4318 | **24318** | 4318 |
| otel health | 13133 | **23133** | 13133 |
| jaeger UI | 16686 | **26686** | 16686 |
| pgadmin | 80 | **25051** | 80 |
| registry-ui | 80 | **25052** | 80 |
| caddy HTTP | 80 | **80**(host hub 唯一占用 80/443 — TLS 端点不可移)| 80 |
| caddy HTTPS | 443 | **443**(同上) | 443 |

> Caddy 是唯一保留 80/443 的服务(因为 TLS endpoint 必须在 well-known port),其他服务全部通过 Caddy 反向代理对外暴露。开发者只通过 `https://<svc>.boxlite.test` 访问,**不直接连 25xxx 端口** — 那些只用于 box-to-box 调用。

**`doctor` 子命令的预检责任**(§4.3 CLI):

```bash
python -m boxlite_local doctor
# Output (示例):
#   ✓ BoxLite SDK importable
#   ✓ BoxLite runtime reachable
#   ✗ Port 25432 occupied by non-boxlite process: postgres (PID 723)
#     → 改 InfraConfig.pg_host_port 或停掉本机 postgres
```

`doctor` 必须在每次 `up` 之前自动跑,失败即拒绝启动。

---

## 4. 实现方式选择:Python 脚本风格

回答用户原问题:**"不同的 python 脚本 vs 同一个 python 接受不同配置"**——这两个都不是最佳。**推荐第三种:声明式 service registry + 单一 orchestrator**。

### 4.1 三种方案对比

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A. 每服务一脚本** | `start_postgres.py`、`start_redis.py`... | 直白,易拷贝 | 大量重复代码,依赖关系硬编码,启停顺序难管 |
| **B. 一个脚本 + 配置文件** | `start.py --config postgres.yaml` | DRY,易扩展 | 配置 schema 设计成本;复杂逻辑写不进 YAML |
| **C. 单 orchestrator + service registry**(推荐) | `python -m boxlite_local up`,内部按 `services/*.py` 注册的 spec 启动 | DRY + 复杂逻辑可读 + 类型友好 + 依赖图天然 | 初始设计成本稍高 |

### 4.2 推荐:Python dataclass service registry

每个服务一个 Python 模块,导出 `ServiceSpec`。Orchestrator 自动发现 + 拓扑排序 + 并行执行。

```python
# apps/infra-local/boxlite_local/services/postgres.py
from boxlite_local.types import ServiceSpec, HealthCheck

SPEC = ServiceSpec(
    name="postgres",
    image="postgres:16-alpine",
    cpus=1,
    memory_mib=512,
    ports=[(25432, 5432)],   # 非默认 host port,见 §3.8
    env=lambda cfg: {
        "POSTGRES_USER": cfg.pg_user,
        "POSTGRES_PASSWORD": cfg.pg_password,
        "POSTGRES_DB": cfg.pg_db,
    },
    volumes=lambda cfg: [
        (cfg.data_dir / "pg", "/var/lib/postgresql/data"),
    ],
    depends_on=[],
    healthcheck=HealthCheck(
        exec=["pg_isready", "-U", "boxlite"],
        interval_s=2,
        timeout_s=2,
        retries=30,
    ),
)
```

```python
# apps/infra-local/boxlite_local/__main__.py
import asyncio
from boxlite_local.orchestrator import Orchestrator

async def main():
    orch = Orchestrator.from_services_dir("apps/infra-local/boxlite_local/services")
    await orch.up()  # 拓扑排序 + 并行启动 + 等 health

asyncio.run(main())
```

### 4.3 用户接口(类 docker-compose UX)

```bash
# 启动所有服务(类 `docker compose up -d`)
python -m boxlite_local up

# 启动单个或子集
python -m boxlite_local up postgres redis

# 停掉所有
python -m boxlite_local down

# 停掉并清空数据
python -m boxlite_local down --wipe

# 状态
python -m boxlite_local ps

# 跟随日志
python -m boxlite_local logs -f postgres

# 进入 box
python -m boxlite_local exec postgres -- sh
python -m boxlite_local exec postgres -- psql -U boxlite

# 健康检查
python -m boxlite_local doctor

# 帮助
python -m boxlite_local --help
```

> 命令名故意跟 `docker compose` / `boxlite-cli` 对齐,降低学习成本。

---

## 5. 项目布局

```
apps/infra-local/
├── Makefile                          # 顶层入口(make up / make down / make doctor)
├── README.md                         # 团队 onboarding 文档
├── pyproject.toml                    # boxlite_local Python 包定义
│
├── boxlite_local/                    # ★ 新的 Python orchestrator
│   ├── __init__.py
│   ├── __main__.py                   # CLI 入口(argparse)
│   ├── config.py                     # InfraConfig dataclass + .env 读取
│   ├── types.py                      # ServiceSpec / HealthCheck / 等
│   ├── orchestrator.py               # 拓扑排序 + 并行启停 + 健康检查
│   ├── runtime.py                    # 包装 boxlite.Boxlite,管理共享 runtime
│   └── services/                     # 服务定义(自动发现)
│       ├── __init__.py
│       ├── postgres.py
│       ├── redis.py
│       ├── dex.py
│       ├── minio.py
│       ├── minio_init.py
│       ├── registry.py
│       ├── caddy.py
│       ├── otel.py
│       ├── jaeger.py
│       ├── pgadmin.py
│       └── registry_ui.py
│
├── configs/                          # 服务配置文件(挂载进 box)
│   ├── dex/
│   │   └── config.yaml
│   ├── caddy/
│   │   └── Caddyfile
│   ├── otel/
│   │   └── config.yaml
│   ├── pgadmin/
│   │   └── servers.json
│   └── minio/
│       └── init.sh
│
├── dns/                              # 保留:dns-shim + launchd
│   ├── dns-shim/
│   ├── boxlite.test
│   └── README.md
│
├── tls/                              # 保留:mkcert wildcard 证书
│   └── README.md
│
├── runner/                           # 保留:launchd 装卸 + Lima runner provision
│   ├── install.sh
│   ├── uninstall.sh
│   └── launchd/
│
├── lima/                             # 新:Lima runner host 配置
│   ├── runner.yaml                   # Lima VM template
│   └── runner-bootstrap.sh           # Lima 启动后跑的脚本(装 runner)
│
├── scripts/                          # 通用 shell 工具
│   ├── lib.sh
│   ├── doctor.sh                     # 系统/网络/工具 健康检查
│   └── smoke.sh                      # 端到端测试
│
└── docs/                             # 内部文档(设计决策等)
    └── decisions/

# 移除:docker-compose.local.yml(以及 apps/local-dev/ 整个目录)
# 保留 / 演进:dns-shim / mkcert / Caddy 等已有 Phase 0+1 成果
```

### 5.1 资源核算(M5 24GB)

| 单元 | 估算占用 | 数量 | 小计 |
|---|---|---|---|
| macOS + IDE | 4-6 GB | 1 | 4-6 GB |
| Postgres box | 512 MB + microVM overhead 200 MB | 1 | 0.7 GB |
| Redis box | 256 MB + 200 MB | 1 | 0.5 GB |
| Dex box | 256 MB + 200 MB | 1 | 0.5 GB |
| MinIO box | 512 MB + 200 MB | 1 | 0.7 GB |
| Registry box | 256 MB + 200 MB | 1 | 0.5 GB |
| Caddy box | 256 MB + 200 MB | 1 | 0.5 GB |
| OTel collector box | 256 MB + 200 MB | 1 | 0.5 GB |
| Jaeger box(memory mode)| 512 MB + 200 MB | 1 | 0.7 GB |
| PgAdmin box | 512 MB + 200 MB | 1 | 0.7 GB |
| Registry UI box | 128 MB + 200 MB | 1 | 0.3 GB |
| host `yarn nx serve` × 2 | 1 GB × 2 | 2 | 2 GB |
| Lima VM(runner host) | 2 GB | 1-2 | 2-4 GB |
| Sandbox(用户工作负载) | 256 MB | 1-3 并发 | 0.3-0.8 GB |
| **合计** | | | **~16-20 GB** |

留 4-8 GB 缓冲。**24 GB M5 够用,但比 docker 方案更紧**(docker 控制面服务总共 ~3 GB,本方案 ~5-6 GB 在控制面)。

**优化空间**:某些 box 用 `cpus=1, memory_mib=256` 紧贴下限。Caddy / Registry-UI 这种轻服务可以 128 MB 起步。

---

## 6. 单服务规范(示例 + 模板)

### 6.1 ServiceSpec 完整 schema(`boxlite_local/types.py`)

```python
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

@dataclass
class HealthCheck:
    """Box 健康判定。同 docker-compose 概念。"""
    exec: Optional[list[str]] = None         # 在 box 内 exec 的命令
    tcp_port: Optional[int] = None           # 或 TCP 端口探测
    http_url: Optional[str] = None           # 或 HTTP 探测
    interval_s: float = 2
    timeout_s: float = 5
    retries: int = 30                        # 总等待时间 = interval × retries
    start_period_s: float = 0                # 启动后等待多久才开始 health check

@dataclass
class ServiceSpec:
    """单个 BoxLite box 的声明式定义。"""
    name: str                                            # box name = "boxlite-local-{name}"
    image: str                                           # OCI image
    cpus: int = 1
    memory_mib: int = 256
    ports: list[tuple[int, int]] = field(default_factory=list)
    env: Callable[["InfraConfig"], dict[str, str]] = lambda cfg: {}
    volumes: Callable[["InfraConfig"], list[tuple[str, str]]] = lambda cfg: []
    cmd: Optional[list[str]] = None                      # 覆盖 image entrypoint
    working_dir: Optional[str] = None
    depends_on: list[str] = field(default_factory=list)
    healthcheck: Optional[HealthCheck] = None
    one_shot: bool = False                               # 一次性任务(如 minio-init)
    auto_remove: bool = False                            # 默认持久
```

### 6.2 示例:Postgres(`services/postgres.py`)

```python
from boxlite_local.types import HealthCheck, ServiceSpec

SPEC = ServiceSpec(
    name="postgres",
    image="postgres:16-alpine",
    cpus=1,
    memory_mib=512,
    ports=[(25432, 5432)],   # 非默认 host port,避开 brew postgres — 见 §3.8
    env=lambda cfg: {
        "POSTGRES_USER": cfg.pg_user,
        "POSTGRES_PASSWORD": cfg.pg_password,
        "POSTGRES_DB": cfg.pg_db,
        "POSTGRES_HOST_AUTH_METHOD": "trust",   # 本地 dev 简化,生产用真 auth
        "PGDATA": "/var/lib/postgresql/data/pgdata",
    },
    volumes=lambda cfg: [
        (cfg.data_dir / "pg", "/var/lib/postgresql/data"),
    ],
    healthcheck=HealthCheck(
        exec=["pg_isready", "-U", "boxlite", "-d", "boxlite"],
        interval_s=2,
        retries=30,
    ),
)
```

### 6.3 示例:Dex(配置注入)

```python
from boxlite_local.types import HealthCheck, ServiceSpec

SPEC = ServiceSpec(
    name="dex",
    image="ghcr.io/dexidp/dex:v2.41.1",
    cpus=1,
    memory_mib=256,
    ports=[(25556, 5556)],               # 非默认 host port
    depends_on=[],                       # Dex 用 sqlite,不依赖 pg
    env=lambda cfg: {
        "DEX_ISSUER": f"http://{cfg.host_hub}:{cfg.dex_host_port}/dex",
    },
    volumes=lambda cfg: [
        (cfg.repo_root / "apps/infra-local/configs/dex/config.yaml",
         "/etc/dex/config.yaml"),
        (cfg.data_dir / "dex", "/var/dex"),
    ],
    cmd=["dex", "serve", "/etc/dex/config.yaml"],
    healthcheck=HealthCheck(
        http_url="http://127.0.0.1:25556/dex/healthz",   # 从 host 探测,用 host port
        retries=30,
    ),
)
```

### 6.4 示例:Caddy(挂证书 + 配置)

```python
from boxlite_local.types import ServiceSpec, HealthCheck

SPEC = ServiceSpec(
    name="caddy",
    image="caddy:2-alpine",
    cpus=1,
    memory_mib=256,
    ports=[(80, 80), (443, 443)],
    depends_on=["dex", "minio", "registry", "jaeger", "pgadmin", "registry-ui"],
    volumes=lambda cfg: [
        (cfg.repo_root / "apps/infra-local/configs/caddy/Caddyfile",
         "/etc/caddy/Caddyfile"),
        (cfg.tls_dir / "wildcard.pem", "/etc/caddy/wildcard.pem"),
        (cfg.tls_dir / "wildcard-key.pem", "/etc/caddy/wildcard-key.pem"),
        (cfg.data_dir / "caddy", "/data"),
    ],
    cmd=["caddy", "run", "--config", "/etc/caddy/Caddyfile"],
    healthcheck=HealthCheck(
        tcp_port=443,
        retries=20,
    ),
)
```

### 6.5 示例:MinIO + 一次性 init(`one_shot=True`)

```python
# minio.py
SPEC_MINIO = ServiceSpec(
    name="minio",
    image="minio/minio:latest",
    ports=[(29000, 9000), (29001, 9001)],   # 非默认 host port
    env=lambda cfg: {
        "MINIO_ROOT_USER": cfg.minio_user,
        "MINIO_ROOT_PASSWORD": cfg.minio_password,
    },
    cmd=["server", "/data", "--console-address", ":9001"],
    volumes=lambda cfg: [(cfg.data_dir / "minio", "/data")],
    healthcheck=HealthCheck(http_url="http://127.0.0.1:29000/minio/health/live"),
)

# minio_init.py
SPEC_INIT = ServiceSpec(
    name="minio-init",
    image="minio/mc:latest",
    depends_on=["minio"],
    cmd=["/bin/sh", "/init.sh"],
    volumes=lambda cfg: [
        (cfg.repo_root / "apps/infra-local/configs/minio/init.sh", "/init.sh"),
    ],
    env=lambda cfg: {
        "MINIO_URL": f"http://{cfg.host_hub}:{cfg.minio_host_port}",
        "MINIO_USER": cfg.minio_user,
        "MINIO_PASSWORD": cfg.minio_password,
    },
    one_shot=True,
)
```

---

## 7. Orchestrator 核心逻辑

```python
# apps/infra-local/boxlite_local/orchestrator.py
import asyncio
import importlib
import pkgutil
from graphlib import TopologicalSorter
from boxlite import Boxlite, BoxOptions

from .types import ServiceSpec
from .config import InfraConfig

class Orchestrator:
    def __init__(self, services: dict[str, ServiceSpec], config: InfraConfig):
        self.services = services
        self.config = config
        self.runtime = Boxlite.default()

    @classmethod
    def from_services_dir(cls, pkg_path: str) -> "Orchestrator":
        services = {}
        pkg = importlib.import_module(pkg_path.replace("/", "."))
        for _, name, _ in pkgutil.iter_modules(pkg.__path__):
            mod = importlib.import_module(f"{pkg.__name__}.{name}")
            for attr_name in dir(mod):
                if attr_name.startswith("SPEC"):
                    spec = getattr(mod, attr_name)
                    if isinstance(spec, ServiceSpec):
                        services[spec.name] = spec
        return cls(services, InfraConfig.load())

    def topo_order(self) -> list[list[str]]:
        """按依赖关系把 services 排成多层,每层内并行启动。"""
        ts = TopologicalSorter()
        for name, spec in self.services.items():
            ts.add(name, *spec.depends_on)
        ts.prepare()
        layers = []
        while ts.is_active():
            layer = list(ts.get_ready())
            layers.append(layer)
            for n in layer:
                ts.done(n)
        return layers

    async def up(self, only: list[str] | None = None):
        for layer in self.topo_order():
            tasks = [self._start_service(name) for name in layer
                     if only is None or name in only]
            await asyncio.gather(*tasks)

    async def _start_service(self, name: str):
        spec = self.services[name]
        opts = BoxOptions(
            image=spec.image,
            cpus=spec.cpus,
            memory_mib=spec.memory_mib,
            auto_remove=spec.auto_remove,
            ports=spec.ports,
            volumes=spec.volumes(self.config),
            env=list(spec.env(self.config).items()),
            cmd=spec.cmd,
            working_dir=spec.working_dir,
        )
        box, created = await self.runtime.get_or_create(opts, name=f"boxlite-local-{name}")
        if created or not spec.one_shot:
            await box.start()
        if spec.healthcheck:
            await self._wait_healthy(box, spec.healthcheck)
        if spec.one_shot:
            # 等命令结束并清理
            await self._wait_one_shot(box)

    async def _wait_healthy(self, box, hc):
        # 实现各种 healthcheck 类型(exec/tcp/http)
        ...

    async def down(self, only: list[str] | None = None, wipe: bool = False):
        # 反向 topo,先停依赖方,再停被依赖
        for layer in reversed(self.topo_order()):
            tasks = [self._stop_service(name) for name in layer
                     if only is None or name in only]
            await asyncio.gather(*tasks)
        if wipe:
            shutil.rmtree(self.config.data_dir, ignore_errors=True)

    async def ps(self):
        infos = await self.runtime.list_info()
        for info in infos:
            if info.name and info.name.startswith("boxlite-local-"):
                print(f"{info.name:<30} {info.state.status:<10} {info.image}")
```

---

## 8. 与原 docker 版方案的对比

| 维度 | 原 `apps/infra-local/`(docker)| 本方案(BoxLite 自寄生)|
|---|---|---|
| 编排工具 | `docker-compose.local.yml` | `python -m boxlite_local up`(Python orchestrator)|
| 容器 runtime | Docker Desktop | **BoxLite runtime**(已有,$0 额外依赖) |
| 隔离机制 | docker 容器(共享内核) | **BoxLite microVM**(独立内核,跟生产 sandbox 同源) |
| Image 来源 | Docker Hub / 本地 build | 同 OCI image,只是用 BoxLite 拉 |
| 服务声明 | YAML | Python dataclass(类型友好) |
| Healthcheck | docker-compose 原生 | 自家实现(同等能力) |
| 服务间通信 | docker bridge + service DNS | **host-as-hub**(box 通过 host 互访) |
| 启停顺序 | depends_on + healthcheck | 拓扑排序 + 并行层 |
| 持久数据 | docker named volume | host filesystem(`~/.boxlite-local/data/*`) |
| 重置 | `docker compose down -v` | `python -m boxlite_local down --wipe` |
| 调试 | `docker exec` | `boxlite-cli exec` 或 `python -m boxlite_local exec` |
| Dogfood | ❌ | ✅ |
| Docker Desktop 依赖 | 必需 | **不需要**(可去除 brew dependency)|
| 内存占用 | 控制面 ~3 GB | 控制面 ~5-6 GB(每 box +200 MB microVM 开销) |
| 启动时间 | ~30s | ~60-90s(microVM boot 慢)|
| 跟生产 parity | 中等 | **高**(同一 BoxLite runtime) |
| 故障注入 | docker pause / kill | `box.stop()` / kill -9 PID(同等) |
| BoxLite bug 影响 | 不影响开发 | **直接影响**(dogfood 的代价 = feedback) |

---

## 9. 风险与开放问题

### 9.1 验证状态(2026-05-20 PoC Phase 0 + Phase 1 实跑后)

| 风险 | 状态 | 实测结果 / 后续 |
|---|---|---|
| BoxLite 能否稳定持续运行 daemon 进程(如 postgres / redis 同跑) | ✅ 短期通过 | Phase 1 三 box 同跑 12 phase 全过;**长期(多日)未验证** |
| BoxLite 拉公共 OCI image(`postgres:16-alpine` / `redis:7-alpine` / `alpine:3.20`) | ✅ 通过 | 无报错 |
| 10+ 个 box 同时跑在 M5 24GB 上是否稳定 | 🟡 待 Phase 3 | 单 box 占 ~512 MiB 符合预算,3 box 同跑无压力 |
| Box 内 entrypoint / cmd 覆盖是否正常(dex / caddy 需要) | ✅ 通过 | env / volumes / ports 都正常 |
| Volume mount 配置文件是否生效 | ✅ 通过(数据卷)| 配置文件 mount 待 Phase 2 实测(dex / caddy) |
| Host-as-hub 网络模型是否能跑 | ✅ **通过**(via `host.boxlite.internal`)| Phase H/I/J/K box→host→box TCP + psql + redis-cli 全通 |
| Box 启动后名字唯一性管理 | ✅ 通过 | `get_or_create` 幂等,`runtime.remove(name)` 工作 |
| `box.exec` API 跟期望签名一致 | ❌ **发现不一致** | `exec(cmd, [args])` 而不是 variadic,见 §1.7;已修复 PoC |
| `detach=True` 跨 Python 进程让 box 存活 | ✅ **通过** | Phase L + `--verify-detach` 双重验证:fresh Python 仍看到 3 box RUNNING |
| Host port 冲突(开发机本地服务 vs BoxLite forward)对 dogfood 影响 | ⚠️ 设计层处理 | 见 §3.8 非默认 port 策略 + §1.7.F;orchestrator 必须有 `doctor` 预检 |

### 9.2 已知妥协

| 妥协 | 说明 |
|---|---|
| Box 启动比 docker 慢 5-10× | microVM boot 决定;接受,因为不是开发循环高频路径 |
| 内存占用比 docker 高 60-80% | 同上;M5 24GB 仍够用但不富余 |
| BoxLite 本身的 bug 会拖累 dev 环境 | 这是 dogfood 的本意(feedback loop)|
| host-as-hub 网络模型多一跳 | 几百 μs,可接受 |
| Runner 仍不在 box 里 | 例外允许,见 §2.4 |

### 9.3 长期可优化方向

- BoxLite 支持原生 box-to-box 网络(service-name DNS)→ 取代 host-as-hub
- BoxLite 支持 `compose`-like CLI(`boxlite up`)→ 取代 Python orchestrator
- 长期:把这个 Python orchestrator 升级成 `boxlite-cli` 的子命令,反过来 dogfood CLI

---

## 10. PoC 计划(在投入完整实现前)

### Phase 0 — 最小可行 PoC ✅ **已完成**(2026-05-20)

实现:`apps/infra-local/poc/single_service.py`(291 行)+ `README.md`

**7 个 phase 全过**:

| Phase | 内容 | 结果 |
|---|---|---|
| A | create or reuse box(`postgres:16-alpine`) | ✅ 0.0s(reuse)/ ~1s(create) |
| B | start box | ✅ 17.9s 冷启 / 0.3s 复用 |
| C | pg_isready ≤ 60s | ✅ 2 次重试通过(2.1s)|
| D | host TCP probe `127.0.0.1:5432` | ✅ 0.0s |
| E | 30s 稳定性 + 再次双探测 | ✅ 30.1s |
| F | `box.info()` 元数据 | ✅ state=running, pid=98288, mem=512, image=postgres:16-alpine |
| G | psql in-box CREATE/INSERT/SELECT | ✅ count=1(真 SQL 走通)|

**关键收获**:
1. dogfood 技术可行,无 deal-breaker
2. SDK API 跟想象不一致(见 §1.7,已修 PoC + 记 memory)
3. detach reuse 问题暴露(见 §1.7.D)
4. 冷启 17s,reuse 0.3s,符合 §0 启动延迟预估

### Phase 1 — 两服务 + 互通(目标:1 天)

加 redis,验证 box-to-box 通过 host 互访:

```python
# postgres 在 :5432,redis 在 :6379
# 起第三个 box(api 模拟,用 alpine + curl),验证能从那个 box 调 host:5432 和 host:6379
```

### Phase 2 — 5 服务 + healthcheck + 拓扑序(目标:1-2 天)

写 minimal orchestrator,起 postgres+redis+dex+minio+caddy,验证拓扑序与 healthcheck。

### Phase 3 — 全栈 + Caddy 路由 + Jaeger UI(目标:2-3 天)

完整 10 个 box,Caddy 路由全打通,Jaeger 收到 trace。

### Phase 4 — Lima runner 集成(目标:1-2 天)

Runner box(in Lima)起来,api 看到它,创建一个 sandbox 走通端到端。

**PoC 全部通过后,才把这个方案落到 production-quality 实施。** PoC 失败的话,回退到 docker 方案,把"BoxLite 跑控制面"作为长期目标。

**Phase 0 结论(2026-05-20)**:✅ 通过,**继续 Phase 1**。

### Phase 1 ✅ **已完成**(2026-05-20)

实现:`apps/infra-local/poc/multi_service.py` + `diagnose_network.py`

**核心结论(三条决定性发现)**:

1. ✅ **多 BoxLite box 稳定并存** —— 3 个 box(pg / redis / alpine client)同时运行
2. ✅ **host-as-hub 网络模型经 `host.boxlite.internal` 走通** —— DNS 解析为 `192.168.127.254` 并 NAT 回 host loopback;TCP / psql / redis-cli 全过
3. ✅ **`detach=True` 跨 Python 进程真生效** —— 第一个 Python 退出后,新 Python 仍能看到 3 个 RUNNING box

**测试结果**:

| 测试 | 结果 | 数据 |
|---|---|---|
| Box-to-host-to-box TCP via `host.boxlite.internal` | ✅ | `nc -zv host.boxlite.internal:{25432,26379}` 都通,日志显示 `Connection to host.boxlite.internal (192.168.127.254)` |
| redis-cli PING via host-as-hub | ✅ | 通过(轻量,实测延迟与 Docker compose 同量级或稍高) |
| redis SET/GET via host-as-hub | ✅ | `dogfood:phase1 = ok` round-trip 成功 |
| **psql via host-as-hub** | ✅ | `SELECT 'dogfood works'` + `CREATE TABLE / INSERT / SELECT` 全过(trust auth) |
| `--verify-detach`(fresh Python)| ✅ | 3 box 都 state=running |

**关键设计落点**:host port 卫生原则(非默认 host port + `doctor` 预检)写入 §1.7.F + §3.8,orchestrator 必须在 `up` 前自动跑 `doctor` 并在 port 冲突时拒绝启动。

### Phase 2 待做(下一步)

`apps/infra-local/boxlite_local/` Python orchestrator 骨架:

1. `types.py` — `ServiceSpec` / `HealthCheck` dataclasses
2. `config.py` — `InfraConfig`,字段 `host_hub: str = "host.boxlite.internal"`(**字符串常量,不是 detect 函数**)+ 非默认 host port 表(见 §3.8)
3. `orchestrator.py` — 拓扑排序 + 并行启停 + healthcheck + **doctor 预检**(端口冲突 + Docker Desktop 检测)
4. `services/{postgres,redis,dex,minio,registry}.py` — 前 5 个服务定义
5. `__main__.py` — CLI(up / down / ps / logs / doctor)
6. 跑通 `python -m boxlite_local up`(必须先 `doctor` 通过)

---

## 11. 决策汇总

| 决策 | 选择 | 理由 |
|---|---|---|
| 是否替换 docker 编排 | ✅ 替换 | dogfood 原则 |
| Runner 是否也跑在 BoxLite box | ❌ 例外,留 Lima | nested KVM 不靠谱 |
| Orchestrator 风格 | **声明式 service registry + 单 Python entry**(C 方案) | DRY + 类型友好 |
| 服务间通信 | **host-as-hub** | 简单,不需 BoxLite 扩展 |
| 启动顺序 | 拓扑排序 + 并行层 | 跟 docker-compose depends_on 等价 |
| 配置文件 | 跟原方案一样 mount,只是从 docker volume 换 BoxLite volume | 迁移友好 |
| Admin UI(PgAdmin/RegistryUI)| 上(同 docker 版决定)| Foundation 视角 |
| MailDev | 不上 | 同 docker 版 |
| Jaeger | 上(同 docker 版决定)| 同上 |
| Dex | 上(同 docker 版)| 本地需要 OIDC |
| 何时启动 PoC | 立刻 §10 Phase 0 | 阻塞性问题验证 |

---

## 12. 下一步动作(具体可执行)

### 12.1 立即(2026-05-20)— ✅ 已完成

1. ~~建立 PoC 工作分支~~ —— PoC 直接在当前分支落地(无需 worktree)
2. ✅ **写 §10 Phase 0**:`apps/infra-local/poc/single_service.py`
3. ✅ **跑通 Phase 0**:7 个 phase 全过
4. ✅ **写 §10 Phase 1**:`apps/infra-local/poc/multi_service.py` + `diagnose_network.py`
5. ✅ **跑通 Phase 1**:12 个 phase 全过(经两次 env 冲突回旋后)
6. ✅ **记录 SDK gotcha**:`memory/feedback_boxlite_python_sdk_gotchas.md`
7. ✅ **更新设计文档**(本节)反映实跑发现

### 12.2 PoC Phase 2 → Phase 4(待做)

> **节奏**:每个 Phase 拿到决定性结果才进下一个,**不抢进度**。

**Phase 2**(下一个,~1-2d):写最小 orchestrator:

- `apps/infra-local/boxlite_local/{__main__.py, types.py, config.py, orchestrator.py}` 骨架
- `host_hub` 字段默认 `"host.boxlite.internal"`(字符串常量,见 §3.2)
- **`doctor` 子命令必须先做**(端口冲突预检,见 §3.8)
- 跑 5 服务(postgres/redis/dex/minio/registry),验证拓扑序 + healthcheck
- 详细 spec:`docs/superpowers/specs/2026-05-20-infra-local-phase2-walking-skeleton.md`(walking skeleton 先从 pg 一个服务开始)

**Phase 3**(~2-3d):全栈:

- 加 Caddy + Jaeger + PgAdmin + RegistryUI + OtelCollector
- 全 10 box 在 M5 24GB 上稳定 ≥ 1h
- 验证 Caddy 反向代理打通(开发者只通过 `https://<svc>.boxlite.test` 访问,不直连 25xxx)

**Phase 4**(~1-2d):Lima runner 集成

**Phase 全部通过后**(可能 1-2 周):

- 删除 `apps/local-dev/`(老 docker-compose 目录)
- 更新 `cloud-mvp-plan.md` §5,Phase 3 改成 "BoxLite-based,不是 docker compose"
- 更新 `infra-vs-local-infra.md` 反映 BoxLite-based 实现

### 12.3 长期(MVP+1)

- 把 Python orchestrator 升级为 `boxlite-cli compose` 子命令,反向 dogfood CLI 能力
- BoxLite 加 box-to-box 服务发现(取代 host-as-hub)
- BoxLite 加 image registry 缓存(避免每次重启拉镜像)

---

## 13. 备忘

- 本方案与原 `feat/local-dev-fullstack` 分支的 Phase 0-1 成果**完全兼容**:
  - `dns-shim` / `mkcert` / `launchd` / `Makefile` / `doctor.sh` 全部保留
  - 只是把 "Phase 3 compose stack" 这一步从 docker 改 BoxLite
- 本设计**待 PoC 验证**,verbose to be revised based on PoC findings
- 若 PoC 揭示 BoxLite 缺失关键能力(如稳定长跑 / 资源效率 / image 兼容性),则**回退**到 docker 版作为 MVP Foundation,把 dogfood 留到 MVP+1
