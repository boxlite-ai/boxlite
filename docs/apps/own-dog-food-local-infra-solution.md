# Own-Dogfood Local Infra Solution

> **Design goal**: re-implement `apps/infra-local/` on top of the BoxLite Python SDK — **replace docker containers with BoxLite boxes** for the control-plane services, putting the "eat your own dogfood" principle into practice.
> **Related**:
> - Principle on record: memory `feedback_eat_your_own_dogfood.md`
> - Platform target: Mac M5, 24GB (memory `feedback_infra_local_target_mac_m5.md`)
> - **Status**: ✅ fully shipped — see milestone [`milestone/infra-local/v0.1.0`](./milestones/2026-05-25-milestone-infra-local-v0.1.0.md) (2026-05-25). L1 11-box stack + L2 four native processes (NestJS API / Go Runner / Go Proxy / Vite Dashboard) + L3 real sandbox microVM are wired end-to-end; `make stack-nuke && make stack-up` cold-boots to a browser terminal showing `root@boxlite:~#` in ~80s. Runner runs **natively on M5** (arm64) using Hypervisor.framework + libkrun.
> - Day-to-day entrypoint: `cd apps/infra-local && make stack-up` (idempotent). See [`infra-local-usage.md`](./infra-local-usage.md) for the standard workflow; current state inventory in [`infra-local-status.md`](./infra-local-status.md); full endpoint / credential table in [`apps/infra-local/CONNECTIONS.md`](../../apps/infra-local/CONNECTIONS.md).
> - **Test coverage**: 35 unit tests + 1 smoke integration test + **10 comprehensive E2E tests** (real protocols: pg SQL / redis SET-GET-INCR / minio S3 PUT-GET / registry v2 catalog / dex JWKS / jaeger query API / otel OTLP HTTP / caddy all 6 routes + 30s stability + 3.5/8 GiB memory budget). `make itest-all` runs the full suite in 86s.
> - Implementation: `apps/infra-local/boxlite_local/` + `apps/infra-local/scripts/stack-*.sh`
> - SDK gotchas from real usage (11 of them): memory `feedback_boxlite_python_sdk_gotchas.md` + `apps/infra-local/README.md` § Known limitations
> - Work intentionally left to manual + sudo (outside infra-local):
>   - **dns-shim** + **mkcert -install** (needs root) → enables Caddy TLS + the `*.boxlite.test` domain UX
>   - **custom otel-collector binary build** (needs the full boxlite repo's nx/go/node toolchain) → switches to the real collector in `apps/otel-collector/`

---

## 0. Executive summary

**Core change**: every docker compose service from the previous proposal becomes a BoxLite box launched through the BoxLite Python SDK, with each box running the service's official OCI image directly.

```
Previous proposal (docker):           This proposal (BoxLite):
─────────────────                     ──────────────────
docker compose up                     python -m boxlite_local up
  ├─ docker container: postgres         ├─ BoxLite box: postgres (OCI: postgres:16-alpine)
  ├─ docker container: redis            ├─ BoxLite box: redis    (OCI: redis:7-alpine)
  ├─ docker container: dex              ├─ BoxLite box: dex      (OCI: ghcr.io/dexidp/dex:v2.x)
  ├─ docker container: minio            ├─ BoxLite box: minio    (OCI: minio/minio)
  ├─ ...                                ├─ ...
  └─ docker container: jaeger           └─ BoxLite box: jaeger   (OCI: jaegertracing/all-in-one:1.67.0)
```

**Key design choices**:

1. **No docker and no docker-compose** — there are **zero Dockerfiles** under `apps/infra-local/` (other than references to existing BoxLite app images).
2. **Each service = a single BoxLite box** (microVM isolation, same lineage as the production sandbox).
3. **One Python entrypoint for the orchestrator**, with a declarative service registry (a YAML/Python-dataclass hybrid, see §4).
4. **Runner runs natively on M5** as a macOS arm64 Go binary using Hypervisor.framework + libkrun (see §3.3). It does not run inside a BoxLite box (it itself needs hypervisor access).
5. **Network model**: host-as-hub — every box forwards its port to the host, and boxes reach each other through the host loopback (see §3.4).

**Benefits**:

- ✅ Dogfood: any BoxLite weakness gets felt by the team immediately.
- ✅ Boxes are completely co-lineal with the production sandbox (same libkrun + OCI; HVF backend locally vs KVM in prod).
- ✅ No Docker Desktop required for the application boxes.
- ✅ `boxlite-cli` becomes the admin tool for free (`boxlite-cli ps`, `boxlite-cli logs`, `boxlite-cli exec` all work out of the box).

**Costs**:

- ⚠️ Higher per-box memory footprint (~256MB+ vs docker ~50MB) → see §5.6 resource accounting.
- ⚠️ Slow startup (microVM boot ~5-10s vs docker ~1s).
- ⚠️ Some OCI features in BoxLite may not be fully covered (PoC validation required, see §10).

---

## 1. BoxLite Python SDK familiarization

### 1.1 Core classes and APIs

```python
from boxlite import Boxlite, SimpleBox, BoxOptions

# Implicit runtime (global default)
async with SimpleBox(image="postgres:16-alpine") as box:
    result = await box.exec("psql", "-c", "SELECT version()")
    print(result.stdout)
```

| Class / method | Purpose |
|---|---|
| `Boxlite.default()` | Grab the global runtime |
| `Boxlite.rest(BoxliteRestOptions(...))` | Connect to a remote boxlite serve |
| `SimpleBox(image, name, cpus, memory_mib, ports, volumes, env, auto_remove, reuse_existing)` | Create or wrap a box |
| `async with SimpleBox(...) as box:` | Start + auto-cleanup (when `auto_remove=True`) |
| `await box.exec(cmd, *args, env=...)` | Run a command inside the box, returns `ExecResult` |
| `box.id` / `box.info()` | Read metadata |
| `runtime.list_info()` | List every box |
| `runtime.get_or_create(opts, name=...)` | Idempotent creation |

### 1.2 Standard pattern for running a daemon service

For services like postgres / redis that need to "run continuously + expose a port", the key pattern is **`reuse_existing=True` + `auto_remove=False`**:

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
    # Do not __aexit__ — let the box keep running.
```

**Key points**:
- `auto_remove=False` keeps the box **alive after the Python process exits**.
- `reuse_existing=True` (implicit inside `get_or_create`) avoids errors on a second start.
- Do not enter `async with`, because the `async with` exit will stop the box; use an explicit `await box.start()` instead.

### 1.3 Port forwarding

```python
ports=[(5432, 5432)]   # (host_port, guest_port)
```

`gvproxy` forwards `127.0.0.1:5432` on the host to `0.0.0.0:5432` inside the box. **The guest must bind to `0.0.0.0`, not `127.0.0.1`** (see `examples/python/02_features/forward_ports.py`).

### 1.4 Volume mounts

```python
volumes=[
    ("/host/abs/path", "/guest/path"),
    ("~/.boxlite-local/data/pg", "/var/lib/postgresql/data"),
]
```

`~` expansion is supported. The host path can be either a file or a directory.

### 1.5 Networking

Each box lives on the `192.168.127.0/24` subnet (BoxLite's default gvproxy network):

| Address | Role | Use |
|---|---|---|
| `192.168.127.1` | Default gateway (gvproxy) | The next hop for outbound traffic from a box; **do not** treat it as the host address for reaching services. |
| `192.168.127.254` / `host.boxlite.internal` | **Host hub** (the `HOST_IP` / `HOST_HOSTNAME` constants) | The address used from inside a box to reach a port forwarded on the host — BoxLite's counterpart to Docker's `host.docker.internal`. |
| host port forwarding | Reverse direction | `127.0.0.1:<host_port>` on the host → `0.0.0.0:<guest_port>` inside the box. |

**Box → box** communication: there is no built-in service-name DNS. The simplest way for box A to call a service in box B is **via the host hub** — B forwards its port to the host, and A reaches `host.boxlite.internal:<host_port>` (or the literal `192.168.127.254:<host_port>`) from inside its box.

> ⚠️ An earlier version said "reach the host via `192.168.127.1`" — that is **wrong**, that address is the gateway, not the host. The Phase 1 PoC confirmed `host.boxlite.internal` / `192.168.127.254` is what must be used.

(See §3.4 / §3.8 for advanced approaches and pitfalls.)

### 1.6 BoxLite capability validation (2026-05-20 PoC Phase 0 + Phase 1 live results)

| Capability | Result | Measured data |
|---|---|---|
| Direct OCI image pull (Docker Hub `postgres:16-alpine` / `redis:7-alpine` / `alpine:3.20`) | ✅ | Phase 0 + 1 all smooth |
| Stable daemon process inside a box (no exit) | ✅ | postgres + redis ran continuously side by side, every health check passed |
| Box startup latency | ⚠️ ~17s cold start, ~0.3s reuse | An order of magnitude slower than docker's ~1s, but acceptable |
| gvproxy host→guest port forwarding | ✅ instant, no latency | TCP probe 0.0s |
| `box.exec` API works | ✅ | But **the signature is `box.exec(cmd, [args_list])`, not variadic** — see §1.7 |
| Box-side entrypoint / cmd / env / volumes | ✅ | Works with `BoxOptions(env=[(k,v),...], volumes=[(h,g),...])` |
| `detach=True` keeps a box alive across Python processes | ✅ | Phase 1 `--verify-detach` passed: a fresh Python still saw 3 boxes RUNNING |
| **Box-to-box networking (host-as-hub via `host.boxlite.internal`)** | ✅ | Phases H/I/J/K: client-box `nc` / `psql` / `redis-cli` all worked through host.boxlite.internal |
| **`host.boxlite.internal` DNS resolution + NAT** | ✅ | Phase H showed `Connection to host.boxlite.internal (192.168.127.254) <port> succeeded`; the originally reported #01 was an environment conflict, not an SDK bug |
| Many boxes (10+) running concurrently — resource test | 🟡 3 boxes ran concurrently; **the full 10-box case is pending Phase 3** | M5 24GB budget in §5.1 |
| BoxLite OCI image remote pull against a private registry | ❓ | To be verified, irrelevant to production |

**Conclusion**: **the dogfood approach is technically feasible, proceed to PoC Phase 2** (orchestrator skeleton).

### 1.7 SDK usage constraints uncovered during PoC Phase 0 (must read)

A handful of SDK usage rules surfaced during the live runs — see memory `feedback_boxlite_python_sdk_gotchas.md`. The ones that affect orchestrator design are listed here.

#### A. `box.exec` signature

**Native `Box.exec` is `exec(command, args=None, env=None, ...)`. `args` is a list, not variadic `*args`**:

```python
# ❌ throws TypeError("argument 'args': Can't extract `str` to `Vec`")
await box.exec("pg_isready", "-U", "postgres")

# ✅ correct
await box.exec("pg_isready", ["-U", "postgres", "-t", "1"])
```

#### B. `exec` returns a streaming Execution, not a final result

```python
execution = await box.exec("ls", ["-la"])
stdout_chunks = []
async for chunk in execution.stdout():
    stdout_chunks.append(chunk)
result = await execution.wait()       # ← wait for and pick up exit_code
exit_code = result.exit_code
```

The orchestrator wraps this in an `exec_collect(box, cmd, args) → (exit_code, stdout, stderr)` helper that hides the streaming detail.

#### C. `env` type inconsistency

| Interface | `env` type |
|---|---|
| `BoxOptions(env=...)` | `list[tuple[str, str]]` |
| `box.exec(cmd, env=...)` | `list[tuple[str, str]]` |
| `SimpleBox.exec(cmd, env=...)` | `dict[str, str]` |

Internally the orchestrator uses `list[tuple]` consistently and converts at the SDK boundary.

#### D. detach reuse-path issue

When `runtime.get_or_create(opts, name=...)` reuses an existing box, it **ignores the detach / ports / volumes / env in `opts`** and keeps using the existing box's configuration.

Implication: the orchestrator must handle the "existing box's config differs from the requested one" case explicitly. Recommended design:

```python
async def ensure_service(spec: ServiceSpec):
    info = await runtime.list_info()  # find the existing box
    existing = next((i for i in info if i.name == f"boxlite-local-{spec.name}"), None)
    if existing and _config_differs(existing, spec):
        # Config changed — destroy and recreate.
        await runtime.remove(existing.name)
        existing = None
    if existing is None:
        # Fresh create
        box = await runtime.create(spec.to_box_options(), name=...)
        await box.start()
    return box
```

Or, more simply: **always start with `detach=True`**, so that even without an explicit `--recreate` the box at least won't stop when Python exits.

#### E. Import path selection

```python
# Defensive: fall back when the .so and __init__.py are out of sync.
try:
    from boxlite import Boxlite, BoxOptions
except ImportError:
    from boxlite.boxlite import Boxlite, BoxOptions
```

The orchestrator uses this pattern uniformly at the top level.

#### F. Host port hygiene principle

BoxLite's host-side port forward binds on `*:<port>` (wildcard). The macOS kernel routes by "most-specific socket wins": if another process on the dev machine is already bound to `127.0.0.1:<port>` (a more specific address), it wins, traffic destined for the box lands on that process instead, and the symptom is "TCP works but the application errors out" (role missing, wrong password, wrong schema…). Very easy to misdiagnose as an SDK bug.

**Orchestrator design rules**:
- All control-plane services use **non-default host ports** (see §3.8 port allocation), while keeping guest-side ports at the image defaults.
- The `doctor` subcommand performs a **port pre-flight**: `lsof -nP -iTCP:<port> -sTCP:LISTEN`; if a non-boxlite process holds the port, fail immediately instead of letting the user debug for an hour.

---

## 2. Architecture

### 2.1 Overall topology

```
                  macOS host (M5, 24GB)
   ┌────────────────────────────────────────────────────────────────┐
   │                                                                │
   │  Python orchestrator (boxlite_local CLI)                       │
   │  └─ Uses the BoxLite Python SDK to launch / manage / monitor   │
   │                                                                │
   │  BoxLite runtime (Boxlite.default() ── one runtime, many boxes)│
   │  │                                                              │
   │  ├─ Box: postgres        port host:5432 → guest:5432           │
   │  ├─ Box: redis           port host:6379 → guest:6379           │
   │  ├─ Box: dex             port host:5556 → guest:5556           │
   │  ├─ Box: minio           ports 9000+9001                       │
   │  ├─ Box: registry        port host:5050 → guest:5000           │
   │  ├─ Box: caddy           ports host:80,443 → guest:80,443      │
   │  ├─ Box: otel-collector  port host:4318                        │
   │  ├─ Box: jaeger          port host:16686                        │
   │  ├─ Box: pgadmin         port host:5050 (configurable)         │
   │  ├─ Box: registry-ui     port host:5051 (configurable)         │
   │  │                                                              │
   │  └─ Box: dns-shim       │  Only dns-shim and Caddy must stay  │
   │                         │  on the host (launchd / ports 53,    │
   │                         │  443).                                │
   │                                                                │
   │  host processes:                                                │
   │  ├─ yarn nx serve api          (dev-time hot reload)            │
   │  ├─ yarn nx serve dashboard    (dev-time hot reload)            │
   │  ├─ Go proxy                   (sandbox port-preview reverse-  │
   │  │                              proxy target)                   │
   │  └─ boxlite-runner             (M5 arm64 native Go binary;     │
   │      └─ Uses HVF + libkrun to create sandboxes (BoxLite box)   │
   │         (Each sandbox is also a BoxLite box — co-lineal with   │
   │          the local control plane.)                              │
   │                                                                │
   └────────────────────────────────────────────────────────────────┘
```

### 2.2 All three layers are dogfood

| Layer | Form | Dogfood status |
|---|---|---|
| **L1: sandbox** (user workload) | BoxLite box, OCI image | ✅ (already the case) |
| **L2: control-plane services** (postgres / redis / dex / ...) | BoxLite box, OCI image | ✅ (**added by this design**) |
| **L3: Runner** | M5-native macOS arm64 binary (uses HVF + libkrun directly) | ⚠️ exception (it is the hypervisor consumer itself) |

**"Any OCI image execution goes through BoxLite"** — except the runner itself, because it is the implementation layer for the OCI executor.

### 2.3 Service inventory (10 BoxLite boxes)

| Box name | OCI image | Role | Host ports |
|---|---|---|---|
| `boxlite-local-pg` | `postgres:16-alpine` | Relational database | 5432 |
| `boxlite-local-redis` | `redis:7-alpine` | Cache + locks + throttler | 6379 |
| `boxlite-local-dex` | `ghcr.io/dexidp/dex:v2.x` (or one built from `apps/dex/Dockerfile`) | OIDC IdP | 5556 |
| `boxlite-local-minio` | `minio/minio` | S3-compatible storage | 9000, 9001 |
| `boxlite-local-minio-init` | `minio/mc` | One-shot bucket bootstrap | — (short-lived) |
| `boxlite-local-registry` | `registry:2` | OCI image registry | 5050 (→5000) |
| `boxlite-local-caddy` | `caddy:2-alpine` | Edge TLS + routing | 80, 443 |
| `boxlite-local-otel` | `otel/opentelemetry-collector:latest` (or this repo's `apps/otel-collector/Dockerfile`) | OTLP ingest | 4318, 13133 |
| `boxlite-local-jaeger` | `jaegertracing/all-in-one:1.67.0` | Trace UI | 16686 |
| `boxlite-local-pgadmin` | `dpage/pgadmin4:9.2.0` | DB admin UI | 5051 |
| `boxlite-local-registry-ui` | `joxit/docker-registry-ui:main` | Registry admin UI | 5052 |

> MailDev still cut (no email flow scenarios).

### 2.4 Runner path (the exception)

The runner is not inside a BoxLite box because it is itself the
component that drives the hypervisor — putting it inside another
microVM would just push the problem down a layer. On this branch the
runner is built as a **native macOS arm64 binary** and uses
Hypervisor.framework + libkrun directly.

The M5-native runner binary **creates sandboxes that are themselves
BoxLite boxes** — **sharing the same runtime abstraction** as the
control-plane boxes, with only the namespace differing (control-plane
boxes are managed by the local Python orchestrator; sandbox boxes are
managed by the runner).

### 2.5 dns-shim and launchd

`dns-shim` (which answers `*.boxlite.test` → 127.0.0.1) **can only run on the host**, because it has to hijack the macOS system DNS. This part is **unchanged**; it continues to live under `apps/infra-local/dns/dns-shim/`.

---

## 3. Key design topics and decisions

### 3.1 Networking: box-to-box

**Problem**: Box A (api) needs to talk to Box B (postgres). BoxLite has no service-name DNS by default.

**Decision**: **host-as-hub mode** — every box forwards its port to the host, and inter-box traffic uses the BoxLite host hub address `host.boxlite.internal` (resolved by gvproxy DNS + NAT to `127.0.0.1` on the host) which then bounces back to the destination box.

```
   Box: api (in box, needs postgres)
       │
       │ connect → host.boxlite.internal:<PG_HOST_PORT>
       │           (gvproxy DNS resolves it to 192.168.127.254)
       ▼
   Host (127.0.0.1:<PG_HOST_PORT>)   ← BoxLite host-side port forward binds on *:<PG_HOST_PORT>
       │ gvproxy forwards back into the box
       ▼
   Box: postgres (guest 0.0.0.0:5432)
```

**Pros**:
- Simple — every service is already exposing a port on the host (no extra configuration).
- Parity with production: in production each EC2 also reaches peers through its own ALB / private IP, conceptually similar.
- The BoxLite SDK needs no extension (only the existing `host.boxlite.internal` + port forwarding capability).

**Cons**:
- One extra gvproxy hop per call, 10-30× higher latency than a docker bridge (measured redis PING 13-50 ms vs docker's ~0.5 ms); acceptable for the dev loop.
- Ports are global on the host, **so they collide with services already running on the dev machine** (see §1.7.F and §3.8).

**Rules to apply** (folded into the §6 service spec):
- Each service injects `BOXLITE_HOST_HUB` as the string `"host.boxlite.internal"` (default, env-overridable).
- Inter-service calls use `BOXLITE_HOST_HUB:<host_port>` rather than service names or literal IPs.
- **Host ports use non-defaults** (see §3.8); guest ports remain at the image defaults.
- Document the port allocation in a table (§3.8).

### 3.2 Service discovery / config injection

**Problem**: api needs to know that postgres is at `host.boxlite.internal:25432`, redis at `host.boxlite.internal:26379`, the dex issuer at `http://host.boxlite.internal:25556/dex`, and so on.

**Decision**: **centralized env-var configuration** (`.env` + service registry) **+ per-service injection at start**.

```python
# apps/infra-local/boxlite_local/config.py
@dataclass
class InfraConfig:
    # Host hub address — the name box-side code uses to reach back to the host.
    # Default "host.boxlite.internal" (equivalent to 192.168.127.254 / HOST_IP),
    # overridable via env BOXLITE_HOST_HUB when needed (e.g., after the SDK renames it).
    host_hub: str = "host.boxlite.internal"

    # All control-plane host ports use non-5xxx defaults to avoid colliding with
    # dev-machine brew / Docker Desktop / IDE-managed services — see §3.8.
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

Every service spec picks its own env vars from here, all centrally managed.

### 3.3 Startup order and dependencies

**Problem**: postgres / redis / dex must be ready before api starts.

**Decision**: **topological sort + healthcheck gates**.

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

After topo-sorting, the orchestrator starts each layer in parallel and waits for the healthcheck of every service in that layer.

### 3.4 Persistent data volumes

| Data | Path |
|---|---|
| Postgres | `~/.boxlite-local/data/pg/` |
| MinIO | `~/.boxlite-local/data/minio/` |
| Registry | `~/.boxlite-local/data/registry/` |
| Dex SQLite | `~/.boxlite-local/data/dex/` |
| Jaeger | (memory mode, not persisted) |
| PgAdmin | `~/.boxlite-local/data/pgadmin/` |
| **Config files** (host→box mount) | `apps/infra-local/configs/<svc>/` |

`make down -v` / `python -m boxlite_local down --wipe` clears everything in one shot.

### 3.5 mkcert TLS certificate sharing

The wildcard cert produced by `mkcert -install` lives as a file on the host. **The Caddy box needs to read this cert** — through a volume mount:

```python
volumes=[
    ("~/.boxlite-local/tls/wildcard.pem", "/etc/caddy/wildcard.pem"),
    ("~/.boxlite-local/tls/wildcard-key.pem", "/etc/caddy/wildcard-key.pem"),
    ("apps/infra-local/caddy/Caddyfile", "/etc/caddy/Caddyfile"),
]
```

The mkcert install still runs on the host (`apps/infra-local/runner/install.sh` already handles it).

### 3.6 Config-file management

Each service's config file (dex `config.yaml`, caddy `Caddyfile`, otel `config.yaml`) lives under `apps/infra-local/configs/<svc>/` and is **read-only mounted into the box**:

```python
# dex service spec
volumes=[
    ("apps/infra-local/configs/dex/config.yaml", "/etc/dex/config.yaml:ro"),
    ("~/.boxlite-local/data/dex", "/var/dex"),
]
```

The usage mirrors docker-compose, so the migration path is clear.

### 3.7 Box "shell friendliness"

Service boxes run the official image, which typically lacks debugging tools. How does the developer poke at things?

**Approach**: `boxlite-cli exec <box-name> -- sh` (the BoxLite CLI already has an `exec` subcommand), or the Python orchestrator can expose `python -m boxlite_local exec postgres -- psql`.

If extra tooling is needed, swap to the `:debug`-tagged image (many official images publish `*-debian` or `*-busybox` variants).

### 3.8 Host port allocation strategy

**Problem**: dev machines often have brew postgres / redis / assorted dev tooling bound on `127.0.0.1:<default_port>`. BoxLite host-side port forwarding binds on `*:<port>` (wildcard); the macOS kernel routes by "most-specific socket wins" — the local service wins, and traffic for the box side never arrives. Symptom: TCP works but the application errors out, very easy to misdiagnose (see §1.7.F).

**Decision**: **every control-plane service uses a non-default host port**, while the guest-internal port stays at the image default (so the image-internal contract is untouched).

| Service | Default port | This proposal's host port | Guest port |
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
| caddy HTTP | 80 | **80** (the host hub is the only thing holding 80/443 — the TLS endpoint cannot move) | 80 |
| caddy HTTPS | 443 | **443** (same as above) | 443 |

> Caddy is the only service that keeps 80/443 (because the TLS endpoint must be on a well-known port); everything else is exposed externally through Caddy's reverse proxy. Developers only access `https://<svc>.boxlite.test` and **never connect to the 25xxx ports directly** — those exist only for box-to-box calls.

**Pre-flight responsibilities of the `doctor` subcommand** (§4.3 CLI):

```bash
python -m boxlite_local doctor
# Output (example):
#   ✓ BoxLite SDK importable
#   ✓ BoxLite runtime reachable
#   ✗ Port 25432 occupied by non-boxlite process: postgres (PID 723)
#     → adjust InfraConfig.pg_host_port or stop the local postgres
```

`doctor` runs automatically before every `up`; a failure aborts the start.

---

## 4. Implementation style: Python script shape

To answer the user's original question: **"separate Python scripts vs one Python that takes a config"** — neither is best. **Recommended is option C: declarative service registry + single orchestrator**.

### 4.1 Three options compared

| Option | Description | Pros | Cons |
|---|---|---|---|
| **A. One script per service** | `start_postgres.py`, `start_redis.py`, … | Direct, easy to copy | Lots of duplicated code, hard-coded dependencies, painful start/stop ordering |
| **B. One script + config files** | `start.py --config postgres.yaml` | DRY, easy to extend | Config-schema design cost; complex logic cannot live in YAML |
| **C. Single orchestrator + service registry** (recommended) | `python -m boxlite_local up`; internally launches things by the specs registered under `services/*.py` | DRY + complex logic stays readable + typed + dependency graph falls out naturally | Slightly higher initial design cost |

### 4.2 Recommended: Python dataclass service registry

One Python module per service exports a `ServiceSpec`. The orchestrator auto-discovers, topo-sorts, and runs in parallel.

```python
# apps/infra-local/boxlite_local/services/postgres.py
from boxlite_local.types import ServiceSpec, HealthCheck

SPEC = ServiceSpec(
    name="postgres",
    image="postgres:16-alpine",
    cpus=1,
    memory_mib=512,
    ports=[(25432, 5432)],   # non-default host port, see §3.8
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
    await orch.up()  # topo sort + parallel start + wait for health

asyncio.run(main())
```

### 4.3 User interface (docker-compose-style UX)

```bash
# Start every service (like `docker compose up -d`)
python -m boxlite_local up

# Start a single service or a subset
python -m boxlite_local up postgres redis

# Stop everything
python -m boxlite_local down

# Stop and wipe data
python -m boxlite_local down --wipe

# Status
python -m boxlite_local ps

# Tail logs
python -m boxlite_local logs -f postgres

# Enter a box
python -m boxlite_local exec postgres -- sh
python -m boxlite_local exec postgres -- psql -U boxlite

# Health check
python -m boxlite_local doctor

# Help
python -m boxlite_local --help
```

> Command names deliberately mirror `docker compose` / `boxlite-cli` to keep the learning curve low.

---

## 5. Project layout

```
apps/infra-local/
├── Makefile                          # Top-level entry (make up / make down / make doctor)
├── README.md                         # Team onboarding doc
├── pyproject.toml                    # boxlite_local Python package definition
│
├── boxlite_local/                    # ★ The new Python orchestrator
│   ├── __init__.py
│   ├── __main__.py                   # CLI entry (argparse)
│   ├── config.py                     # InfraConfig dataclass + .env loading
│   ├── types.py                      # ServiceSpec / HealthCheck / etc.
│   ├── orchestrator.py               # Topo sort + parallel start/stop + healthcheck
│   ├── runtime.py                    # Wraps boxlite.Boxlite, manages the shared runtime
│   └── services/                     # Service definitions (auto-discovered)
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
├── configs/                          # Service config files (mounted into boxes)
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
├── dns/                              # Kept: dns-shim + launchd
│   ├── dns-shim/
│   ├── boxlite.test
│   └── README.md
│
├── tls/                              # Kept: mkcert wildcard cert
│   └── README.md
│
├── scripts/                          # General-purpose shell helpers
│   ├── lib.sh
│   ├── doctor.sh                     # System / network / tooling health checks
│   └── smoke.sh                      # End-to-end smoke test
│
└── docs/                             # Internal docs (design decisions, etc.)
    └── decisions/

# Removed: docker-compose.local.yml (and the entire apps/local-dev/ directory)
# Kept / evolved: dns-shim / mkcert / Caddy and the rest of the Phase 0+1 deliverables
```

### 5.1 Resource accounting (M5 24GB)

| Unit | Estimated footprint | Count | Subtotal |
|---|---|---|---|
| macOS + IDE | 4-6 GB | 1 | 4-6 GB |
| Postgres box | 512 MB + microVM overhead 200 MB | 1 | 0.7 GB |
| Redis box | 256 MB + 200 MB | 1 | 0.5 GB |
| Dex box | 256 MB + 200 MB | 1 | 0.5 GB |
| MinIO box | 512 MB + 200 MB | 1 | 0.7 GB |
| Registry box | 256 MB + 200 MB | 1 | 0.5 GB |
| Caddy box | 256 MB + 200 MB | 1 | 0.5 GB |
| OTel collector box | 256 MB + 200 MB | 1 | 0.5 GB |
| Jaeger box (memory mode) | 512 MB + 200 MB | 1 | 0.7 GB |
| PgAdmin box | 512 MB + 200 MB | 1 | 0.7 GB |
| Registry UI box | 128 MB + 200 MB | 1 | 0.3 GB |
| host `yarn nx serve` × 2 | 1 GB × 2 | 2 | 2 GB |
| M5 native runner + proxy binaries | ~300 MB total | 1 | 0.3 GB |
| Sandbox (user workload) | 256 MB | 1-3 concurrent | 0.3-0.8 GB |
| **Total** | | | **~12-15 GB** |

Leaves ~9-12 GB of headroom. **A 24 GB M5 is comfortably enough** — the M5-native runner saves the 2-4 GB the original plan budgeted for a Linux VM host.

**Optimization room**: a few boxes run right at the floor with `cpus=1, memory_mib=256`. Lightweight services like Caddy / Registry-UI can start at 128 MB.

---

## 6. Per-service spec (examples + template)

### 6.1 Complete `ServiceSpec` schema (`boxlite_local/types.py`)

```python
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

@dataclass
class HealthCheck:
    """Box readiness check. Same concept as docker-compose."""
    exec: Optional[list[str]] = None         # Command to exec inside the box
    tcp_port: Optional[int] = None           # …or a TCP port probe
    http_url: Optional[str] = None           # …or an HTTP probe
    interval_s: float = 2
    timeout_s: float = 5
    retries: int = 30                        # Total wait = interval × retries
    start_period_s: float = 0                # Delay before the first healthcheck after start

@dataclass
class ServiceSpec:
    """Declarative definition of a single BoxLite box."""
    name: str                                            # box name = "boxlite-local-{name}"
    image: str                                           # OCI image
    cpus: int = 1
    memory_mib: int = 256
    ports: list[tuple[int, int]] = field(default_factory=list)
    env: Callable[["InfraConfig"], dict[str, str]] = lambda cfg: {}
    volumes: Callable[["InfraConfig"], list[tuple[str, str]]] = lambda cfg: []
    cmd: Optional[list[str]] = None                      # Override the image entrypoint
    working_dir: Optional[str] = None
    depends_on: list[str] = field(default_factory=list)
    healthcheck: Optional[HealthCheck] = None
    one_shot: bool = False                               # One-shot task (e.g., minio-init)
    auto_remove: bool = False                            # Persistent by default
```

### 6.2 Example: Postgres (`services/postgres.py`)

```python
from boxlite_local.types import HealthCheck, ServiceSpec

SPEC = ServiceSpec(
    name="postgres",
    image="postgres:16-alpine",
    cpus=1,
    memory_mib=512,
    ports=[(25432, 5432)],   # Non-default host port, dodges brew postgres — see §3.8
    env=lambda cfg: {
        "POSTGRES_USER": cfg.pg_user,
        "POSTGRES_PASSWORD": cfg.pg_password,
        "POSTGRES_DB": cfg.pg_db,
        "POSTGRES_HOST_AUTH_METHOD": "trust",   # Simplified for local dev; production uses real auth
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

### 6.3 Example: Dex (config injection)

```python
from boxlite_local.types import HealthCheck, ServiceSpec

SPEC = ServiceSpec(
    name="dex",
    image="ghcr.io/dexidp/dex:v2.41.1",
    cpus=1,
    memory_mib=256,
    ports=[(25556, 5556)],               # Non-default host port
    depends_on=[],                       # Dex uses sqlite, no pg dependency
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
        http_url="http://127.0.0.1:25556/dex/healthz",   # Probed from the host using the host port
        retries=30,
    ),
)
```

### 6.4 Example: Caddy (mount certs + config)

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

### 6.5 Example: MinIO + one-shot init (`one_shot=True`)

```python
# minio.py
SPEC_MINIO = ServiceSpec(
    name="minio",
    image="minio/minio:latest",
    ports=[(29000, 9000), (29001, 9001)],   # Non-default host ports
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

## 7. Orchestrator core logic

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
        """Order services into layers by dependency; each layer is started in parallel."""
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
            # Wait for the command to finish and clean up
            await self._wait_one_shot(box)

    async def _wait_healthy(self, box, hc):
        # Implements every healthcheck variant (exec/tcp/http)
        ...

    async def down(self, only: list[str] | None = None, wipe: bool = False):
        # Reverse topo: stop dependents first, then the dependencies
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

## 8. Comparison with the original docker proposal

| Dimension | Original `apps/infra-local/` (docker) | This proposal (BoxLite self-hosted) |
|---|---|---|
| Orchestration tool | `docker-compose.local.yml` | `python -m boxlite_local up` (Python orchestrator) |
| Container runtime | Docker Desktop | **BoxLite runtime** (already present, $0 extra dependency) |
| Isolation mechanism | docker container (shared kernel) | **BoxLite microVM** (independent kernel, co-lineal with the production sandbox) |
| Image source | Docker Hub / locally built | Same OCI images, just pulled by BoxLite |
| Service declaration | YAML | Python dataclass (type-friendly) |
| Healthcheck | docker-compose native | Implemented in-house (equivalent capability) |
| Inter-service comms | docker bridge + service DNS | **host-as-hub** (boxes reach each other through the host) |
| Start/stop order | depends_on + healthcheck | Topological sort + parallel layers |
| Persistent data | docker named volume | host filesystem (`~/.boxlite-local/data/*`) |
| Reset | `docker compose down -v` | `python -m boxlite_local down --wipe` |
| Debugging | `docker exec` | `boxlite-cli exec` or `python -m boxlite_local exec` |
| Dogfood | ❌ | ✅ |
| Docker Desktop dependency | Required | **Not needed** (brew dependency can drop) |
| Memory footprint | Control plane ~3 GB | Control plane ~5-6 GB (+200 MB microVM overhead per box) |
| Startup time | ~30s | ~60-90s (microVM boot is slower) |
| Parity with production | Medium | **High** (same BoxLite runtime) |
| Fault injection | docker pause / kill | `box.stop()` / kill -9 PID (equivalent) |
| Impact of a BoxLite bug | Does not affect development | **Directly affects** (the cost of dogfood = feedback) |

---

## 9. Risks and open questions

### 9.1 Validation status (after PoC Phase 0 + Phase 1 live runs on 2026-05-20)

| Risk | Status | Measurements / follow-up |
|---|---|---|
| Whether BoxLite can run daemon processes (postgres / redis concurrently) stably | ✅ short-term pass | All 12 phases of Phase 1 with three boxes passed; **long-term (multi-day) not yet verified** |
| Whether BoxLite can pull public OCI images (`postgres:16-alpine` / `redis:7-alpine` / `alpine:3.20`) | ✅ pass | No errors |
| Whether 10+ boxes run stably on an M5 24GB | 🟡 pending Phase 3 | A single box uses ~512 MiB, within budget; 3 boxes concurrent without pressure |
| Whether box-side entrypoint / cmd overrides work (needed by dex / caddy) | ✅ pass | env / volumes / ports all work |
| Whether volume-mounted config files take effect | ✅ pass (data volumes) | Config-file mounts to be exercised in Phase 2 (dex / caddy) |
| Whether the host-as-hub network model works | ✅ **pass** (via `host.boxlite.internal`) | Phases H/I/J/K box→host→box TCP + psql + redis-cli all worked |
| Box name uniqueness after start | ✅ pass | `get_or_create` is idempotent, `runtime.remove(name)` works |
| Whether `box.exec` matches the expected signature | ❌ **mismatch found** | `exec(cmd, [args])`, not variadic — see §1.7; PoC fixed |
| Whether `detach=True` keeps a box alive across Python processes | ✅ **pass** | Phase L + `--verify-detach`: fresh Python still sees 3 boxes RUNNING |
| Whether host port collisions (local dev services vs BoxLite forwards) impact dogfood | ⚠️ handled at the design layer | See §3.8 non-default port strategy + §1.7.F; the orchestrator must have a `doctor` pre-flight |

### 9.2 Known trade-offs

| Trade-off | Note |
|---|---|
| Box startup is 5-10× slower than docker | A consequence of microVM boot; accepted because it isn't on the high-frequency dev loop |
| Memory footprint is 60-80% higher than docker | Same root cause; an M5 24GB is still enough, but not generous |
| BoxLite's own bugs slow down the dev environment | This is the whole point of dogfood (feedback loop) |
| One extra hop in the host-as-hub model | A few hundred μs, acceptable |
| Runner still not running inside a box | Allowed exception, see §2.4 |

### 9.3 Long-term opportunities for optimization

- BoxLite gains native box-to-box networking (service-name DNS) → replaces host-as-hub.
- BoxLite gains a `compose`-style CLI (`boxlite up`) → replaces the Python orchestrator.
- Long-term: this Python orchestrator grows into a `boxlite-cli` subcommand, dogfooding the CLI in turn.

---

## 10. PoC plan (before committing to the full implementation)

### Phase 0 — minimum viable PoC ✅ **complete** (2026-05-20)

Implementation: the Phase 0 single-service PoC script (cleaned up at the end of the PoC stage; the code now lives under `apps/infra-local/boxlite_local/`).

**All 7 phases passed**:

| Phase | Content | Result |
|---|---|---|
| A | Create or reuse box (`postgres:16-alpine`) | ✅ 0.0s (reuse) / ~1s (create) |
| B | Start box | ✅ 17.9s cold start / 0.3s reuse |
| C | pg_isready ≤ 60s | ✅ passes on the 2nd retry (2.1s) |
| D | Host TCP probe `127.0.0.1:5432` | ✅ 0.0s |
| E | 30s stability + another double probe | ✅ 30.1s |
| F | `box.info()` metadata | ✅ state=running, pid=98288, mem=512, image=postgres:16-alpine |
| G | psql in-box CREATE/INSERT/SELECT | ✅ count=1 (real SQL round-trip) |

**Key takeaways**:
1. Dogfood is technically feasible, no deal-breakers.
2. The SDK API differs from expectations (see §1.7, PoC fixed + memory recorded).
3. The detach reuse issue surfaced (see §1.7.D).
4. Cold start 17s, reuse 0.3s — matches the startup-latency estimate in §0.

### Phase 1 — two services + interop (target: 1 day)

Add redis and verify box-to-box via the host:

```python
# postgres at :5432, redis at :6379
# Bring up a third box (an api simulator, alpine + curl) and verify it can call host:5432 and host:6379 from inside the box.
```

### Phase 2 — 5 services + healthcheck + topo order (target: 1-2 days)

Write the minimal orchestrator and run postgres+redis+dex+minio+caddy to validate the topo order and healthcheck.

### Phase 3 — full stack + Caddy routing + Jaeger UI (target: 2-3 days)

The full 10 boxes, Caddy routes all wired up, Jaeger receiving traces.

### Phase 4 — M5 native runner integration (target: 1-2 days)

The M5-native `boxlite-runner` binary comes up, registers with the api, and a sandbox is created end-to-end.

**Only after every PoC phase passes do we promote the plan to a production-quality implementation.** If the PoC fails, fall back to the docker plan and keep "BoxLite for the control plane" as a long-term goal.

**Phase 0 conclusion (2026-05-20)**: ✅ pass, **proceed to Phase 1**.

### Phase 1 ✅ **complete** (2026-05-20)

Implementation: the Phase 1 multi-service PoC + network diagnostic script (cleaned up at the end of the PoC stage; code now lives under `apps/infra-local/boxlite_local/`).

**Core conclusions (three decisive findings)**:

1. ✅ **Multiple BoxLite boxes coexist stably** — 3 boxes (pg / redis / alpine client) running concurrently.
2. ✅ **The host-as-hub network model works via `host.boxlite.internal`** — DNS resolves to `192.168.127.254` and NATs back to the host loopback; TCP / psql / redis-cli all pass.
3. ✅ **`detach=True` really does keep a box alive across Python processes** — after the first Python exits, a new Python still sees all 3 boxes RUNNING.

**Test results**:

| Test | Result | Data |
|---|---|---|
| Box-to-host-to-box TCP via `host.boxlite.internal` | ✅ | `nc -zv host.boxlite.internal:{25432,26379}` both succeed; the log shows `Connection to host.boxlite.internal (192.168.127.254)` |
| redis-cli PING via host-as-hub | ✅ | Passes (lightweight; measured latency same order of magnitude as docker-compose, slightly higher) |
| redis SET/GET via host-as-hub | ✅ | `dogfood:phase1 = ok` round-trip succeeds |
| **psql via host-as-hub** | ✅ | `SELECT 'dogfood works'` + `CREATE TABLE / INSERT / SELECT` all pass (trust auth) |
| `--verify-detach` (fresh Python) | ✅ | All 3 boxes state=running |

**Key design landing**: the host-port hygiene principle (non-default host ports + `doctor` pre-flight) is now written into §1.7.F + §3.8; the orchestrator must run `doctor` automatically before `up` and refuse to start when a port collision is detected.

### Phase 2 to-do (next)

The `apps/infra-local/boxlite_local/` Python orchestrator skeleton:

1. `types.py` — `ServiceSpec` / `HealthCheck` dataclasses.
2. `config.py` — `InfraConfig`, with field `host_hub: str = "host.boxlite.internal"` (**a string constant, not a detect function**) + the non-default host-port table (see §3.8).
3. `orchestrator.py` — topo sort + parallel start/stop + healthcheck + **doctor pre-flight** (port collision + Docker Desktop detection).
4. `services/{postgres,redis,dex,minio,registry}.py` — the first 5 service definitions.
5. `__main__.py` — CLI (up / down / ps / logs / doctor).
6. Get `python -m boxlite_local up` to pass (must pass `doctor` first).

---

## 11. Decision summary

| Decision | Choice | Rationale |
|---|---|---|
| Replace docker orchestration? | ✅ replace | Dogfood principle |
| Run the runner inside a BoxLite box too? | ❌ exception, runner stays native on M5 | Runner is the hypervisor consumer itself — wrapping it in another microVM just adds a layer |
| Orchestrator style | **Declarative service registry + single Python entry** (option C) | DRY + type-friendly |
| Inter-service communication | **host-as-hub** | Simple, no BoxLite extension needed |
| Startup order | Topological sort + parallel layers | Equivalent to docker-compose `depends_on` |
| Config files | Same as the original proposal — mounted, just swapped from docker volume to BoxLite volume | Migration-friendly |
| Admin UIs (PgAdmin/RegistryUI) | Include (same decision as the docker version) | Foundation perspective |
| MailDev | Exclude | Same as the docker version |
| Jaeger | Include (same decision as the docker version) | Same as above |
| Dex | Include (same as the docker version) | Local OIDC is needed |
| When to start the PoC | Immediately at §10 Phase 0 | Validate blocking questions |

---

## 12. Next actions (concrete and executable)

### 12.1 Immediate (2026-05-20) — ✅ complete

1. ~~Create a PoC working branch~~ — the PoC landed directly on the current branch (no worktree needed).
2. ✅ **Write §10 Phase 0**: the Phase 0 single-service PoC script.
3. ✅ **Run Phase 0 to completion**: all 7 phases pass.
4. ✅ **Write §10 Phase 1**: the Phase 1 multi-service PoC + network diagnostic script.
5. ✅ **Run Phase 1 to completion**: all 12 phases pass (after two environment-collision detours).
6. ✅ **Record the SDK gotchas**: `memory/feedback_boxlite_python_sdk_gotchas.md`.
7. ✅ **Update the design doc** (this section) to reflect live findings.

### 12.2 PoC Phase 2 → Phase 4 (to do)

> **Pace**: only advance to the next phase once the current phase produces a decisive result, **no rush**.

**Phase 2** (next, ~1-2 days): write the minimal orchestrator:

- Skeleton of `apps/infra-local/boxlite_local/{__main__.py, types.py, config.py, orchestrator.py}`.
- The `host_hub` field defaults to `"host.boxlite.internal"` (a string constant, see §3.2).
- **`doctor` subcommand must come first** (port-collision pre-flight, see §3.8).
- Run 5 services (postgres/redis/dex/minio/registry), validate the topo order + healthchecks.
- Implementation strategy: walking skeleton starting from pg as the single service, adding the rest one at a time.

**Phase 3** (~2-3 days): full stack:

- Add Caddy + Jaeger + PgAdmin + RegistryUI + OtelCollector.
- All 10 boxes stable on M5 24GB for ≥ 1h.
- Verify Caddy reverse proxy is wired up (developers only access `https://<svc>.boxlite.test`, never directly to 25xxx).

**Phase 4** (~1-2 days): M5 native runner integration.

**Once every phase passes** (likely 1-2 weeks):

- Delete `apps/local-dev/` (the old docker-compose directory).

### 12.3 Long-term (MVP+1)

- Promote the Python orchestrator to a `boxlite-cli compose` subcommand, dogfooding the CLI capabilities in turn.
- BoxLite gains box-to-box service discovery (replacing host-as-hub).
- BoxLite gains an image registry cache (avoiding image re-pulls on every restart).

---

## 13. Notes

- This plan is **fully compatible** with the Phase 0-1 deliverables from the original `feat/local-dev-fullstack` branch:
  - `dns-shim` / `mkcert` / `launchd` / `Makefile` / `doctor.sh` all kept.
  - Only the "Phase 3 compose stack" step is swapped from docker to BoxLite.
- This design is **pending PoC validation**; verbose to be revised based on PoC findings.
- If the PoC reveals BoxLite missing critical capabilities (stable long-running daemons / resource efficiency / image compatibility), **fall back** to the docker version as the MVP Foundation, and defer dogfood to MVP+1.
