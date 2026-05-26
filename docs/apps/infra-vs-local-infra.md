# `apps/infra/` vs `apps/infra-local/` — comparison

> Current status: `apps/infra-local/` shipped — see milestone [`milestone/infra-local/v0.1.0`](./milestones/2026-05-25-milestone-infra-local-v0.1.0.md) (2026-05-25).
> What actually shipped is the **dogfood approach** (BoxLite microVM boxes in place of docker-compose), not the docker-compose route described in this doc — see [`own-dog-food-local-infra-solution.md`](./own-dog-food-local-infra-solution.md). This doc is preserved as the "why we built a BoxLite-based local infra" comparison and rationale.

---

## 1. `apps/infra-local/` — overall plan summary

**One sentence:** use docker-compose + a few host-native processes + a Lima Linux VM to **run the equivalent of the full `apps/infra/` (AWS SST) stack on a single MacBook**, so a 6-engineer team can develop, debug, load-test, and run the autoscaler end-to-end without depending on an AWS staging environment.

### 1.1 Core topology

```
macOS host (M5)
├─ docker compose (boxlite-local bridge network)
│   ├─ postgres + redis              (state)
│   ├─ dex                           (OIDC)
│   ├─ minio + minio-init            (object storage, S3 protocol)
│   ├─ registry:2                    (image registry, replaces SnapshotManager)
│   ├─ caddy                         (edge, *.boxlite.test wildcard TLS)
│   ├─ otel-collector                (observability, lightweight)
│   ├─ proxy + ssh-gateway           (edge services, reused from apps/)
│   └─ mock-runner / (no runner)      (provided by the old compose; the new plan moves runner out of this layer)
│
├─ host-native processes (hot reload)
│   ├─ yarn nx serve api             (NestJS @ :3000)
│   ├─ yarn nx serve dashboard       (Vite @ :5173)
│   └─ dns-shim (launchd)            (resolves *.boxlite.test → 127.0.0.1)
│
└─ Lima Linux VM (start/stop on demand)
    ├─ runner-1                     (Go, real microVM via libkrun + KVM)
    ├─ runner-2                     (LimaInfraProvider scales up/down via limactl)
    └─ ...
```

### 1.2 Key design decisions (settled, Foundation-first lens)

- ✅ **Lima Linux VM hosts the real runner** (skip Native HVF — see **§2**)
- ✅ **Full Caddy routing** (api / dashboard / `*.proxy` / ssh / auth / registry / s3 / jaeger / pgadmin / registry-ui)
- ✅ **Full observability stack:** OtelCollector + Jaeger UI (`jaegertracing/all-in-one:1.67.0`, same as production)
- ✅ **Selective admin UIs:** PgAdmin + RegistryUI included (high debug value); MailDev not included (no email-flow scenario)
- ✅ **Target platform:** macOS Apple Silicon (M-series) only; Intel / Linux / Windows out of scope

---

## 2. Why Lima instead of Hypervisor.framework (decision archive)

The BoxLite runtime already supports **both** hypervisor backends:

```
macOS:   Hypervisor.framework + libkrun  →  microVM
Linux:   KVM + libkrun                   →  microVM
```

On the face of it, using HVF directly on macOS looks easier — one fewer Lima VM, instant startup, lower memory. But viewed through the Foundation lens, **the Lima route is the right one**. Reasoning below.

### 2.1 Conceptual distinction: hypervisor ≠ runner host

A point that's easy to conflate:

| Layer | Unit | Order of magnitude |
|---|---|---|
| **microVM (sandbox)** | one libkrun instance | one runner manages tens to hundreds concurrently |
| **runner** | a Go process on the host that manages microVMs | typically one runner per host |
| **runner host** | EC2 instance / Lima VM / physical machine | this is the layer the autoscaler adjusts |
| **hypervisor backend** | HVF / KVM | determines how the microVM runs; orthogonal to runner host |

BoxLite's "HVF support" solves **"how does the microVM run on macOS"**, **not** "can we run multiple runner hosts on macOS". These are two different things.

### 2.2 Fundamental shortcoming of the Native HVF route

If we pick Native HVF, the actual shape is:

```
   MacBook M5 (host)
      │
      ├─ runner process (macOS native binary)
      │   └─ uses HVF to create N microVMs
      │
      └─ ❓ want a second runner?
         ├─ start another runner process on the same Mac
         ├─ manage port conflicts yourself (3003 / 3004 / ...)
         ├─ share the Mac's CPU/RAM with no resource isolation
         ├─ in production "runner 2" is another EC2 — here it's another process on the same Mac
         └─ not the same thing
```

**What the autoscaler really needs to scale is the "runner host" layer.** Under the Native HVF route, one Mac is essentially **a single runner host** (the Mac itself), and **there's no way to simulate "add a new host"** — the core action of the autoscaler.

You could run multiple runner processes on the same Mac as "pseudo-multi-runner", but:

| Problem | Consequence |
|---|---|
| Shared host network namespace | Cannot test network partitions / cross-host routing |
| Shared CPU / RAM / disk | Cannot test resource exhaustion / resource isolation |
| Manual port allocation | Test scripts become complex; collisions easy |
| Kill process ≠ kill host | Cannot simulate "EC2 instance failure", a core failure mode |
| Does not mirror prod architecture | Autoscaler logic written locally may behave differently on AWS |

### 2.3 Shape of the Lima route

```
   MacBook M5 (host)
      │
      ├─ control plane (host process + docker-compose, see §1.1)
      │
      ├─ Lima VM 1 (Ubuntu arm64, vz driver)
      │   └─ /dev/kvm available
      │       └─ runner process (Linux native binary)
      │           └─ uses KVM + libkrun to create N microVMs
      │
      ├─ Lima VM 2 (same, its own IP / port space / resources)
      │   └─ runner process
      │
      └─ Lima VM 3 (same)
          └─ runner process
```

Each Lima VM = a genuine "host" in the real sense:

- Independent IP / port space / hostname
- Independent CPU / RAM / disk quota (configured via `limactl`)
- Independent Linux kernel (can be rebooted / suspended individually)
- `limactl start/stop/delete` maps directly to "EC2 RunInstances / TerminateInstances"

### 2.4 Side-by-side dimension comparison

| Dimension | Native HVF | Lima Linux | Notes |
|---|---|---|---|
| **True multi runner-host** | ❌ | ✅ | Core requirement for autoscaler tests |
| **Production parity** (same data plane) | ❌ HVF backend | ✅ KVM backend — same as EC2 | See §2.5 |
| **Resource isolation** | ❌ shared Mac | ✅ VM has its own quota | For resource-exhaustion tests |
| **Network isolation** | ❌ same host | ✅ different IP / network | For cross-host routing / NAT tests |
| **Fault injection** | Kill process (easy), network partition (impossible) | Kill VM (`limactl stop`), pause (`limactl stop`), netdrop (iptables inside VM) | Required for chaos testing |
| **InfraProvider abstraction fit** | Strained (what does provisionRunner even do?) | Natural (`limactl start` ↔ `RunInstances`) | See §2.6 |
| **InfraProvider implementation cost** | Hard to write a meaningful implementation | 2-3 person-days (write LimaInfraProvider) | Lima adds 2-3 days upfront |
| **microVM startup latency** | Instant | Instant (microVM already inside Lima) | Lima VM itself starts in ~30 s, but a microVM inside Lima starts as fast as on HVF |
| **Mac resource consumption** | Low (one runner process) | High (each Lima VM is 1-2 GB RAM) | 24 GB M5 can run 2-3 Lima VMs simultaneously |
| **Toolchain maturity** | Build multi-runner management yourself | Lima framework is mature, vz driver is default | Lima is maintained by lima-vm/lima |
| **Long-term maintenance burden** | High (write your own multi-runner coordinator) | Low (Lima already does it) | |

### 2.5 The production-parity row is the most important

**Foundation is meant to be the long-term baseline for development and testing**; prod parity matters far more than startup speed.

```
Production data plane:
  EC2 c8i.2xlarge  ──►  Linux kernel  ──►  KVM  ──►  libkrun (KVM backend)  ──►  microVM

Lima local data plane:
  Lima VM (Ubuntu) ──►  Linux kernel  ──►  KVM  ──►  libkrun (KVM backend)  ──►  microVM
                       ↑                         ↑
                  identical                 identical libkrun code path

HVF local data plane:
  macOS            ──►  HVF        ──►        libkrun (HVF backend)  ──►  microVM
                       ↑                         ↑
                  differs from prod         different libkrun code path
```

**Implications:**

- runner / microVM / autoscaler behavior observed in Lima is **almost guaranteed to be the same on production EC2**
- Behavior observed in HVF **may not reproduce in production, and production bugs may not reproduce locally** — the data plane is two separate code paths
- For a "long-term trustworthy Foundation", **parity is non-negotiable**

### 2.6 Natural fit with the InfraProvider abstraction

The autoscaler operates on runner hosts through the `IInfraProvider` interface:

```ts
interface IInfraProvider {
  provisionRunner(spec): Promise<RunnerEndpoint>
  terminateRunner(runnerId): Promise<void>
  describeRunner(runnerId): Promise<RunnerInstanceInfo>
}
```

| Interface method | AwsInfraProvider | LimaInfraProvider | "HvfInfraProvider" (hypothetical) |
|---|---|---|---|
| `provisionRunner` | `RunInstances` + user-data | `limactl start` + systemd unit | **?** — start another process on the Mac? That isn't a "host" |
| `terminateRunner` | `TerminateInstances` | `limactl stop && limactl delete` | `kill <pid>`? Doesn't free resources |
| `describeRunner` | `DescribeInstances` | `limactl list` | `ps`? Doesn't reveal host health |

The Lima interface **maps cleanly onto AWS** — the semantics of `limactl` commands correspond one-to-one to EC2 API calls; the code pattern is identical. The HVF route can't produce a meaningful provider implementation at all, because HVF is not a "host provisioning" tool to begin with.

### 2.7 Resource budget (24 GB M5)

| Unit | Footprint | Count | Subtotal |
|---|---|---|---|
| macOS system + Docker Desktop + IDE | ~6 GB | 1 | 6 GB |
| docker compose control plane (postgres/redis/dex/minio/registry/caddy/otel/jaeger/pgadmin) | ~3 GB | 1 | 3 GB |
| host processes (api + dashboard running Node) | ~2 GB | 1 | 2 GB |
| Lima VM (runner host) | ~2 GB | 2-3 | 4-6 GB |
| Each microVM | ~256 MB | 1-5 concurrent | 1-2 GB |
| **Total** | | | **16-19 GB** |

That leaves 4-7 GB of headroom for Slack / browser / VS Code plugins. **24 GB is enough.**

> If you want to run 5+ Lima runners simultaneously for load testing, memory gets tight — but Phase-2 autoscaler tests only need 2-3 runners to validate up/down logic. Save N-runner load tests for production staging.

### 2.8 Decision matrix

| Decision axis | Importance | Recommendation |
|---|---|---|
| Multi-host autoscaler testing | 🔴 critical | **Lima** |
| Production parity | 🔴 critical | **Lima** |
| Fault injection capability | 🟡 important | **Lima** |
| Startup speed | 🟢 secondary | HVF |
| Mac resource consumption | 🟡 important (but acceptable) | HVF |
| Maintenance toolchain complexity | 🟢 secondary | **Lima** (mature framework) |
| Upfront implementation cost | 🟢 secondary (2-3 days) | HVF |
| Long-term ROI | 🔴 critical | **Lima** |

**6 reds vs 0 reds + some yellow/green** → Lima.

### 2.9 When this decision should be revisited

- If BoxLite decides to **officially support macOS as a production runner host** (e.g. an on-prem Mac mini cluster), HVF's parity story becomes an advantage
- If the Lima vz driver breaks on some macOS version and stays unfixed long-term
- If the team's developer machines become predominantly non-Mac (Linux as primary dev box)

None of these are expected to fire in the short term (within 2026); **the decision is stable**.

---

## 3. Per-axis comparison table

| Dimension | **`apps/infra/` (production)** | **`apps/infra-local/` (local)** |
|---|---|---|
| **Goal** | Run BoxLite cloud control plane + data plane on AWS | Run an equivalent full stack on one MacBook; dev loop < 30 s |
| **IaC tool** | **SST v4 + Pulumi** (`sst.config.ts`) | **Make + docker-compose + shell scripts** (`Makefile` + `scripts/*.sh`) |
| **Deploy command** | `sst deploy` | `make -C apps/infra-local up` |
| **First-deploy duration** | ~20-40 minutes (VPC, RDS, ECS, CloudFront all to create) | ~10-15 minutes (mostly docker pull + yarn install) |
| **Daily startup time** | N/A (always on) | ~30 seconds (`docker compose up -d` + `yarn nx serve`) |
| **Running cost** | Hundreds-to-thousands USD / month (VPC NAT, EC2, RDS, ElastiCache, CloudFront) | **$0** (local machine) |
| **Target platform** | AWS `ap-southeast-1` | macOS Apple Silicon (M1/M2/M3/M4/M5) |
| **Networking** | VPC + ALB (`Api` ALB:443, `Proxy` ALB:443, `SshGateway` NLB:2222) + NAT EC2 | docker bridge `boxlite-local` + Caddy `*.boxlite.test:443` + `dns-shim` resolver |
| **DNS** | Route53 + customer's own domain | **`dns-shim`** (Go, started by launchd, resolves `*.boxlite.test` → `127.0.0.1`) + macOS `/etc/resolver/boxlite.test` |
| **TLS** | ACM-issued + ALB-terminated | **mkcert local CA + wildcard cert** + Caddy-terminated |
| **Database** | RDS `t4g.micro` Postgres 16 | `postgres:16-alpine` container, `pg-data` volume |
| **Cache** | ElastiCache Redis (single-node) | `redis:7-alpine` container |
| **Object storage** | S3 Bucket (`Storage`) + IAM user | **MinIO** (S3-protocol compatible) + `mc` init container |
| **Image registry** | `SnapshotManager` ECS Service (distribution/distribution + S3) | `registry:2` (`:5050`, local filesystem; avoids macOS AirPlay's grab on `:5000`) |
| **OIDC IdP** | **External Auth0/Okta** (`sst.config.ts:181` explicit comment "No in-cluster Dex") | **`apps/dex/` container** (default user `admin@boxlite.dev` / `password`) |
| **`api` service** | ECS Service, container image, ALB :443 | **host-native `yarn nx serve api`** (:3000, hot reload) — not in a container |
| **`dashboard`** | Static assets + CloudFront | **host-native `yarn nx serve dashboard`** (:5173, Vite hot reload) |
| **`proxy`** | ECS Service `:4000` | docker compose service (`profiles: [full]`) |
| **`ssh-gateway`** | ECS Service NLB `:2222` | docker compose service (`profiles: [full]`) |
| **`snapshot-manager`** | ECS Service (in-house Go) | **Not run** (use `registry:2` directly; only with `--profile full` to validate parity via a SnapshotManager container) |
| **`runner`** | **EC2 single instance** `c8i.2xlarge` (nested KVM, user-data pulls the binary) | **mock-runner** (Node stub, default) + **Lima Linux VM** (real microVM via libkrun + KVM, LimaInfraProvider scales up/down) |
| **`daemon` (inside sandbox)** | Runner bakes it into the sandbox OCI image | Same as prod (the microVM inside Lima uses the same image) |
| **`otel-collector`** | ECS Service (in-house distribution + boxlite_exporter) | Same (container, lightweight config) |
| **Jaeger UI** | ECS Service `:16686` | **container `jaegertracing/all-in-one:1.67.0`** (same as prod), exposed by Caddy at `jaeger.boxlite.test` |
| **PgAdmin / RegistryUI / MailDev** | ECS Services (operational UIs inherited from Daytona) | **PgAdmin + RegistryUI included** (high debug frequency); **MailDev excluded** (no email-flow scenario) |
| **CDN** | CloudFront (`ApiCdn` Router) | **Not needed** (direct local connection) |
| **Autoscaler InfraProvider** | `AwsInfraProvider` (`ec2.RunInstances` + Launch Template) | **`LimaInfraProvider`** (`limactl start/stop/delete`) |
| **Sandbox isolation** | KVM (EC2 nested) + libkrun microVM | KVM (Lima Linux VM) + libkrun microVM (identical implementation) |
| **Sandbox network** | gvproxy + 192.168.127.0/24 (inside VM) | Same |
| **Sandbox URL (port preview)** | `https://<port>-<sandboxId>.proxy.<your-domain>` | `https://<port>-<sandboxId>.proxy.boxlite.test` (Caddy wildcard routing) |
| **Secrets** | SST-generated + Secrets Manager + IAM | **`.env` file** (plaintext, by convention not checked into git; `apps/local-dev/.env` template) |
| **State persistence** | RDS persistent volume + S3 + EC2 EBS | docker named volumes (`pg-data`, `minio-data`, etc.; `docker compose down -v` wipes everything in one shot) |
| **Multi-runner support** | EC2 ASG / manual scale-up (after Phase-2 autoscaler) | **Multiple Lima VMs** (one runner per Lima, managed via limactl) |
| **Observability** | OTel → Jaeger / ClickHouse / Prometheus / CloudWatch | OTel collector + Jaeger UI (`:16686`); ClickHouse / CloudWatch excluded — `docker logs` covers it |
| **Health checks** | ALB health check + ECS task health | docker compose `healthcheck` + `make doctor` script (30+ checks across system / network / tooling / services) |
| **Logs** | CloudWatch Logs + OTel | docker logs + plain stdout |
| **Rollback / versioning** | SST + EC2 + ECR | `git checkout` + `docker compose down/up` |
| **New-hire onboarding** | Needs AWS account + IAM + VPC permissions | **3 commands** (`brew install ...` + `make setup` + `make up`) |
| **Who uses it** | Customers, SRE, load tests | **6-engineer dev team's daily driver** (after M0 Foundation) |
| **Change-to-feedback latency** | `sst deploy` ~5-15 minutes | **Code change → hot reload < 5 seconds** (both NestJS and Vite) |
| **Cross-platform** | AWS only | macOS Apple Silicon only (Intel Mac works but native-runner story is weak) |
| **Docker-dependent?** | Build phase only | **Yes — Docker Desktop ≥ 4.30 required** |
| **License / third-party** | Third-party quotas / compliance filings | Fully local — no signup overhead |
| **CI integration** | Ephemeral env via `sst deploy` | Run `make ci` on a GitHub Actions Mac runner (post-Foundation) |

---

## 4. Asymmetries

### 4.1 What local-infra **adds** (production doesn't need)

| Item | Why local needs it |
|---|---|
| **`dns-shim` (Go)** | Production uses Route53; local needs to hijack `*.boxlite.test` |
| **`mkcert`** | Production uses ACM; local needs to self-sign a wildcard cert |
| **`/etc/resolver/boxlite.test`** | macOS scoped resolver to route the chosen TLD to dns-shim |
| **`launchd` plist** | Keep dns-shim running in the background |
| **`doctor.sh`** | Check mkcert / lima / docker / dns / port usage — 30+ items |
| **`apps/infra-local/patches/`** | Temporary patches so the API / dashboard compile in host-mode (becomes unnecessary once M0 fixes the TS errors) |
| **mock-runner** | Stub for when you don't want to start Lima |
| **`LimaInfraProvider`** | Local InfraProvider implementation for the autoscaler |

### 4.2 What local-infra **drops** (only production needs it)

| Item | Why local doesn't need it |
|---|---|
| VPC / NAT / Subnets | docker bridge replaces it |
| ACM / Route53 | mkcert + dns-shim replaces it |
| ALB / NLB / TargetGroups | docker port publish + Caddy |
| ECS Cluster + TaskDefinition | docker compose |
| CloudFront | Direct local connection |
| RDS / ElastiCache / S3 | Containerized equivalents |
| IAM Roles + Policies | No permission boundary locally (developer trust model) |
| EC2 Launch Template | Lima starts the VM |
| SST Secrets Manager | `.env` file |
| MailDev | No email-flow scenario, dropped; ClickHouse / CloudWatch replaced by `docker logs` + Jaeger |

---

## 5. Service name / port / URL consistency (key)

**Both environments preserve the same "service name / port / API URL pattern"**, so code is unaware of which environment it runs in:

| Concept | Production | Local |
|---|---|---|
| api domain | `api.<your-domain>` | `api.boxlite.test` (Caddy) / `localhost:3000` (direct) |
| api port | 3000 (inside container) | 3000 |
| dashboard domain | `<your-domain>` | `dashboard.boxlite.test` / `localhost:5173` |
| proxy port | 4000 (ALB :443 forwards here) | 4000 (Caddy :443 forwards here) |
| ssh-gateway port | 2222 | 2222 |
| port preview URL | `<port>-<id>.proxy.<your-domain>` | `<port>-<id>.proxy.boxlite.test` |
| OIDC issuer | `<auth0>.com/...` | `localhost:5556` (Dex) |
| OTLP HTTP | 4318 (in-cluster collector) | 4318 (local collector) |
| Image registry | `<sst-out>.elb...:80` | `localhost:5050` |
| Object storage | S3 | MinIO `localhost:9000` (API) + `localhost:9001` (console) |

---

## 6. Key file pointers

| Path | Contents |
|---|---|
| `apps/infra/sst.config.ts` | Production IaC, SST + Pulumi |
| `apps/infra-local/Makefile` | Local one-shot command entry (`make up/down/doctor/...`) |
| `apps/infra-local/scripts/doctor.sh` | 30+ environment health checks |
| `apps/infra-local/scripts/lib.sh` | Shared shell helpers (platform guard / colours / env loading) |
| `apps/infra-local/dns/dns-shim/main.go` | DNS interceptor (Go, responds for `*.boxlite.test`) |
| `apps/infra-local/runner/launchd/ai.boxlite.dns.plist` | launchd integration |
| `apps/infra-local/runner/install.sh` / `uninstall.sh` | LaunchAgent install / uninstall |
| `apps/infra-local/caddy/Caddyfile` | wildcard-domain TLS + routing |
| `apps/infra-local/tls/README.md` | mkcert flow documentation |
| `apps/local-dev/docker-compose.local.yml` (old version, partially to be merged) | 6 base services |
| `apps/local-dev/mock-runner/server.mjs` | mock runner |
| `apps/local-dev/smoke.sh` | smoke test |

---

## 7. One-sentence summary

> `apps/infra/` deploys BoxLite to AWS; `apps/infra-local/` produces the **in-place equivalent** of the same services on a MacBook — every cloud resource is swapped for a container or host process, the Auto Scaling Group is swapped for a pool of Lima VMs, Route53 is swapped for a local DNS shim, ACM is swapped for mkcert, and **service names / ports / API shape / sandbox URL pattern stay identical to production**, all at the cost of a few `brew` invocations and `make up`.
