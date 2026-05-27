# `apps/infra/` vs `apps/infra-local/` — comparison

> Current status: `apps/infra-local/` shipped — see milestone [`milestone/infra-local/v0.1.0`](./milestones/2026-05-25-milestone-infra-local-v0.1.0.md) (2026-05-25).
> What actually shipped is the **dogfood approach** (BoxLite microVM boxes in place of docker-compose), not the docker-compose route described in this doc — see [`own-dog-food-local-infra-solution.md`](./own-dog-food-local-infra-solution.md). This doc is preserved as the "why we built a BoxLite-based local infra" comparison and rationale.

---

## 1. `apps/infra-local/` — overall plan summary

**One sentence:** use BoxLite microVMs for the control plane plus a
small number of host-native processes to **run the equivalent of the
full `apps/infra/` (AWS SST) stack on a single MacBook**, so the dev
team can build, debug, and exercise the cloud-MVP end-to-end without
depending on AWS staging.

> Historical note: the original design (the rest of this document)
> proposed docker-compose + a separate Linux VM for the runner. What
> actually shipped in `milestone/infra-local/v0.1.0` is the
> **dogfood approach** with the runner running natively on M5 — see
> [`own-dog-food-local-infra-solution.md`](./own-dog-food-local-infra-solution.md)
> for the implemented architecture.

### 1.1 Core topology (as shipped)

```
macOS host (M5, Apple Silicon)
├─ L1 — BoxLite microVMs (orchestrated by `python -m boxlite_local up`)
│   ├─ postgres                       (state)
│   ├─ redis                          (cache + signed-url + lock provider)
│   ├─ dex                            (OIDC)
│   ├─ minio + minio-init             (object storage, S3 protocol)
│   ├─ registry:2                     (image registry)
│   ├─ caddy                          (reverse proxy + sandbox port preview)
│   ├─ jaeger / otel-collector        (observability)
│   ├─ pgadmin                        (admin UI for postgres)
│   └─ registry-ui                    (admin UI for the OCI registry)
│
├─ L2 — host-native processes (orchestrated by `make stack-*`)
│   ├─ NestJS api                     (:3001, hot reload via nx serve)
│   ├─ Vite dashboard                 (:3000, hot reload)
│   ├─ Go proxy                       (:4000, sandbox port-preview reverse-proxy target)
│   └─ Go runner                      (:3003, M5 arm64 native binary; uses HVF + libkrun)
│
└─ L3 — user sandboxes
    └─ N libkrun microVMs spawned by the L2 runner in ~/.boxlite-runner/
```

### 1.2 Key design decisions (as shipped)

- ✅ **M5 native runner** — the Go runner is built as a native macOS
  arm64 binary and spawns sandboxes via Hypervisor.framework + libkrun
  directly (see **§2**).
- ✅ **Full Caddy routing** (api / dashboard / `*.proxy` / ssh / auth / registry / s3 / jaeger / pgadmin / registry-ui).
- ✅ **Full observability stack:** OtelCollector + Jaeger UI
  (`jaegertracing/all-in-one:1.67.0`, same image as production).
- ✅ **Selective admin UIs:** PgAdmin + RegistryUI included (high debug
  value); MailDev not included (no email-flow scenario).
- ✅ **Target platform:** macOS Apple Silicon (M-series) only;
  Intel / Linux / Windows out of scope.

---

## 2. Runner placement on this branch — M5 native (Hypervisor.framework)

The BoxLite runtime supports **both** hypervisor backends:

```
macOS:   Hypervisor.framework + libkrun  →  microVM
Linux:   KVM + libkrun                   →  microVM
```

**On this branch the runner runs as a native macOS arm64 binary on M5,
using Hypervisor.framework via libkrun.** This is the simplest path to
a single-runner dev box: no extra VM layer, instant boot, low memory
footprint, and the runner participates in the same `make stack-*`
lifecycle as the rest of L2. The runner host **is** the MacBook
itself — one Mac, one runner host, one runner process. Multi-host
runner topologies (the kind autoscaler tests would need) are
intentionally out of scope here and tracked separately.

### 2.1 Known tradeoff: production-parity gap

```
Production data plane:
  EC2 c8i.2xlarge  ──►  Linux kernel  ──►  KVM  ──►  libkrun (KVM backend)  ──►  microVM

M5-native local data plane (this branch):
  macOS            ──►  HVF          ──►  libkrun (HVF backend)  ──►  microVM
                       ↑                         ↑
                  different from prod      different libkrun code path
```

Behavior observed locally **may not reproduce on production EC2 and
vice-versa** — the libkrun code path is genuinely two implementations.
For day-to-day cloud-MVP work (sandbox lifecycle, OIDC, dashboard
E2E, snapshot pull, terminal connect) the M5-native path is more
than enough; see [`milestone/infra-local/v0.1.0`](./milestones/2026-05-25-milestone-infra-local-v0.1.0.md).
Closing the parity gap will become important once the autoscaler is
wired up; that work is parked outside this branch.

### 2.2 Resource budget (24 GB M5)

| Unit | Footprint | Count | Subtotal |
|---|---|---|---|
| macOS system + Docker Desktop + IDE | ~6 GB | 1 | 6 GB |
| L1 BoxLite control plane (10 boxes: postgres/redis/dex/minio/registry/caddy/otel/jaeger/pgadmin/registry-ui) | ~5-6 GB | 1 | 5-6 GB |
| L2 native processes (api / runner / proxy / dashboard) | ~1.5-2 GB | 1 | 1.5-2 GB |
| L3 sandbox microVMs | ~256 MB | 1-3 concurrent | 0.5-1 GB |
| **Total** | | | **13-15 GB** |

That leaves ~9-11 GB of headroom for the browser, Slack, VS Code
plugins, etc. **24 GB is enough for a single-runner dev box.**

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
| **`runner`** | **EC2 single instance** `c8i.2xlarge` (nested KVM, user-data pulls the binary) | **M5 native** Go binary (`/tmp/boxlite-runner`, arm64, uses HVF + libkrun). Single runner; multi-host scaling deferred to a separate worktree |
| **`daemon` (inside sandbox)** | Runner bakes it into the sandbox OCI image | Same as prod (the microVM spawned by the M5 runner uses the same image) |
| **`otel-collector`** | ECS Service (in-house distribution + boxlite_exporter) | Same (container, lightweight config) |
| **Jaeger UI** | ECS Service `:16686` | **container `jaegertracing/all-in-one:1.67.0`** (same as prod), exposed by Caddy at `jaeger.boxlite.test` |
| **PgAdmin / RegistryUI / MailDev** | ECS Services (operational UIs inherited from Daytona) | **PgAdmin + RegistryUI included** (high debug frequency); **MailDev excluded** (no email-flow scenario) |
| **CDN** | CloudFront (`ApiCdn` Router) | **Not needed** (direct local connection) |
| **Autoscaler InfraProvider** | `AwsInfraProvider` (`ec2.RunInstances` + Launch Template) | Not implemented on this branch — single M5 runner (multi-host work in a separate worktree) |
| **Sandbox isolation** | KVM (EC2 nested) + libkrun microVM | HVF (M5 native) + libkrun microVM (different hypervisor backend; same libkrun guest) |
| **Sandbox network** | gvproxy + 192.168.127.0/24 (inside VM) | Same |
| **Sandbox URL (port preview)** | `https://<port>-<sandboxId>.proxy.<your-domain>` | `https://<port>-<sandboxId>.proxy.boxlite.test` (Caddy wildcard routing) |
| **Secrets** | SST-generated + Secrets Manager + IAM | **`.env` file** (plaintext, by convention not checked into git; `apps/local-dev/.env` template) |
| **State persistence** | RDS persistent volume + S3 + EC2 EBS | docker named volumes (`pg-data`, `minio-data`, etc.; `docker compose down -v` wipes everything in one shot) |
| **Multi-runner support** | EC2 ASG / manual scale-up (after Phase-2 autoscaler) | Not on this branch (single M5 runner). Multi-host topologies are tracked in a separate worktree |
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
| **`apps/infra-local/boxlite_local/doctor.py`** | Preflight (SDK + runtime + port lsof) before `make up` |

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
| EC2 Launch Template | N/A — single M5 runner; no host provisioning |
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
| `apps/infra-local/Makefile` | Local one-shot command entry (`make up/stack-up/doctor/...`) |
| `apps/infra-local/boxlite_local/orchestrator.py` | Python orchestrator (topo-sorted up/down, healthchecks) for L1 boxes |
| `apps/infra-local/boxlite_local/services.py` | Declarative L1 service registry (`ServiceSpec`) |
| `apps/infra-local/boxlite_local/doctor.py` | Preflight checks (SDK / runtime / port conflicts) |
| `apps/infra-local/scripts/stack-up.sh` | L1+L2 wrapper — brings up boxes + native api/runner/proxy/dashboard |
| `apps/infra-local/scripts/stack-reset.sh` | Tiered cleanup (soft / `--hard` / `--nuke`) |
| `apps/infra-local/CONNECTIONS.md` | Endpoint / credential / env-var reference per L1 service |
| `apps/runner/cmd/runner` | Go runner source — built natively for M5 arm64 |

---

## 7. One-sentence summary

> `apps/infra/` deploys BoxLite to AWS; `apps/infra-local/` produces the **in-place equivalent** of the same services on a MacBook — every cloud resource is swapped for a BoxLite microVM or a host-native process, the EC2-backed runner is swapped for a single M5 native Go binary using Hypervisor.framework + libkrun, Route53 is swapped for a local DNS shim, ACM is swapped for mkcert, and **service names / ports / API shape / sandbox URL pattern stay identical to production**, all at the cost of a few `brew` invocations and `make stack-up`. Multi-host autoscaler testing is parked in a separate worktree.
