## TL;DR

BoxLite separates its control plane, proxy, and VM runners, with managed state and observability services around them.

# Infrastructure architecture

[Infrastructure index](../README.md) · [Deployment](deployment.md) · [Networking](networking.md)

These diagrams describe the checked-in resource declarations, not an inventory of a live project.
`$` marks a GCP billing component before free allowances; conditional resources depend on stage configuration.
BoxLite processes inside a paid host do not create a second GCP compute charge.

## GCP overview

```mermaid
flowchart TB
 browser(["Browser"])
 sdk(["SDK / CLI"])
 idp(["OIDC identity provider"])
 registry(["OCI registries<br/>BoxLite + user images"])
 subgraph gcp["GCP — BoxLite"]
   subgraph edge["Public edge · Cloudflare DNS"]
    apiLB["$ HTTPS Application Load Balancer<br/>Dashboard + API"]
    proxyLB["$ TLS proxy Network Load Balancer<br/>Box previews + tunnels"]
   end
   subgraph control["Control plane"]
    api["$ Cloud Run<br/>BoxLite API + Dashboard"]
    proxy["$ GKE Autopilot<br/>BoxLite Proxy"]
   end
   subgraph execution["$ Compute Engine runner fleet · nested KVM"]
    runner["BoxLite Runner"]
    runtime["Embedded BoxLite runtime"]
    boxes[["Box microVMs<br/>User applications"]]
    runner --> runtime --> boxes
   end
   subgraph state["State and storage"]
    pg[("$ Cloud SQL<br/>PostgreSQL")]
    redis[("$ Memorystore<br/>Redis")]
    storage[("$ Cloud Storage<br/>App objects + persistent volumes")]
   end
   subgraph observability["Observability"]
    otel["$ Cloud Run<br/>BoxLite OTel Collector"]
    clickhouse[("$ Compute Engine + Hyperdisk<br/>ClickHouse · when self-hosted")]
   end
 end
 browser -->|"Dashboard · API · WebSocket"|apiLB
 sdk -->|"API requests"|apiLB
 browser -->|"Box port preview"|proxyLB
 sdk -->|"Box tunnels"|proxyLB
 apiLB -->api
 proxyLB -->proxy
 proxy -->|"Resolve box / authorize<br/>via internal API load balancer"|api
 proxy -->|"Tunnel to guest port"|runner
 api <-->|"Schedule · lifecycle · status"|runner
 api -->pg
 api -->redis
 api -->|"Manage objects / volumes"|storage
 runner <-->|"Mount persistent volumes"|storage
 api -. "Validate identity" .->idp
 runner -->|"Pull images"|registry
 api -. "Telemetry" .->otel
 proxy -. "Telemetry" .->otel
 runner -. "Host + box telemetry" .->otel
 otel -->|"Store logs / metrics / traces"|clickhouse
 api -->|"Query telemetry"|clickhouse
```

Cloudflare provides public DNS outside GCP; it is shown beside the public edge for orientation.
The dashboard SPA is bundled into the API image. A box runs inside a runner's nested-KVM microVM,
not as a Cloud Run instance or Kubernetes pod.

## GCP runtime and data paths

```mermaid
flowchart TB
 users["Browser · SDK · CLI"]
 dns["Cloudflare public DNS"]
 integrations["External integrations<br/>OIDC · Commerce · Analytics<br/>SMTP · Svix · PostHog · Pylon"]
 subgraph gcp["GCP — BoxLite application stack"]
  publicLB["$ External Application Load Balancer<br/>API + dashboard · HTTPS"]
  proxyLB["$ External proxy Network Load Balancer<br/>Wildcard box access · TLS"]
  api["$ Cloud Run<br/>apps/api — control plane<br/>apps/dashboard — bundled SPA"]
  collector["$ Cloud Run<br/>apps/otel-collector<br/>BoxLite + ClickHouse exporters"]
  subgraph vpc["Private VPC — subnets, routes and firewalls"]
   privateDNS["$ Cloud DNS private zone"]
   internalLB["$ Internal Application Load Balancer<br/>Private API access"]
   proxy["$ GKE Autopilot<br/>Cluster + pod resources<br/>apps/proxy — 2 replicas"]
   subgraph host["$ Compute Engine — runner fleet × N"]
    runner["apps/runner<br/>Lifecycle · exec · files · tunnels"]
    runtime["Go SDK / FFI → Rust BoxLite runtime<br/>Images · storage · networking"]
    shim["Jailer + boxlite-shim<br/>VMM / nested KVM"]
    guest["Box microVMs<br/>boxlite-guest → user containers/apps"]
    disk["$ Hyperdisk Balanced<br/>OS · image cache · local box state"]
    runner -->runtime -->shim -->guest
    runtime ---disk
   end
   subgraph telemetry["Conditional — self-hosted ClickHouse"]
    ch["$ Compute Engine<br/>ClickHouse — logs, metrics, traces"]
    chdisk["$ Hyperdisk Balanced<br/>Boot + retained data disks"]
    chLB["$ Internal passthrough Network Load Balancer"]
    psc["Private Service Connect<br/>Service attachment"]
    psc -->chLB -->ch
    ch ---chdisk
   end
  end
  psa["Private Service Access"]
  sql[("$ Cloud SQL PostgreSQL<br/>Control-plane state<br/>Storage · configured HA / backups / PITR")]
  redis[("$ Memorystore Redis<br/>Cache · queues · realtime coordination<br/>Configured Basic / HA tier")]
  storage[("$ Cloud Storage<br/>Application storage bucket<br/>Per-volume buckets")]
 end
 backoffice["Separate BoxLite Backoffice / ClickStack<br/>Consumer VPC + PSC endpoint"]
 otlp["Organization-configured<br/>External OTLP destinations"]
 users -. "Resolve names" .->dns
 dns -.->publicLB
 dns -.->proxyLB
 users -->publicLB -->api
 users -->proxyLB -->proxy
 proxy -->|"Lookup / authorization"|internalLB
 runner -->|"Registration / callbacks"|internalLB
 privateDNS -. "Internal API address" .->internalLB
 internalLB -->api
 api -->|"Direct VPC egress · runner API"|runner
 proxy -->|"CONNECT / preview / terminal"|runner
 api -->|"Direct VPC egress"|psa
 psa -->sql
 psa -->redis
 api -->|"Objects / volume lifecycle"|storage
 runner <-->|"gcsfuse volume mounts"|storage
 api -. "OTLP" .->collector
 proxy -. "OTLP" .->collector
 runner -. "Host + box OTLP" .->collector
 collector -->|"Direct VPC egress · writes"|ch
 api -->|"Direct VPC egress · queries"|ch
 collector -. "Configured export" .->otlp
 backoffice -->psc
 api <-->|"Configured integrations"|integrations
```

The collector's ClickHouse exporter is conditional; organization OTLP export is a separate path.
The Backoffice consumer endpoint belongs to another stack. Private Service Access connects managed
SQL/Redis services; Private Service Connect publishes the self-hosted ClickHouse endpoint.

## GCP deployment and supporting services

```mermaid
flowchart LR
 deploy["BoxLite apps/infra<br/>mbuild · mstage · mdeploy / Pulumi<br/>Developer machine / CI"]
 workloads["BoxLite workloads<br/>API · proxy · collector<br/>runners · ClickHouse"]
 containers["API · proxy · collector"]
 hosts["Runner hosts"]
 privateHosts["Private VMs + GKE workloads"]
 lbs["Internal API + proxy TLS load balancers"]
 internet["Internet / OCI registries<br/>BoxLite box images + user images"]
 subgraph support["GCP — supporting resources"]
  registry[("$ Artifact Registry<br/>Container images")]
  artifacts[("$ Cloud Storage<br/>Runner binary artifacts")]
  state[("$ Cloud Storage<br/>Pulumi state · locks<br/>mstage config · object versions")]
  secrets["$ Secret Manager<br/>Credentials · CA certificates<br/>Stage secrets / state passphrases"]
  vmmanager["$ VM Manager / OS Config<br/>Runner upgrade policies"]
  certs["$ Certificate Manager<br/>Wildcard proxy + internal API TLS"]
  nat["$ Cloud NAT + NAT public IPv4<br/>Gateway hours · processed bytes<br/>Cloud Router configuration"]
  transfer["$ Network data transfer<br/>Internet egress<br/>Applicable cross-zone / region traffic"]
  logs["$ Cloud Logging<br/>Service / GKE / health-check logs<br/>NAT error logs + network telemetry"]
  metrics["$ Cloud Monitoring<br/>Billable log-based metrics<br/>API / proxy / runner alert policies"]
  identity["IAM · service accounts<br/>Workload Identity<br/>VPC / firewall configuration"]
 end
 deploy -->registry -->containers
 deploy -->artifacts -->hosts
 deploy <-->state
 deploy <-->secrets
 secrets -. "Runtime delivery" .->workloads
 deploy -->vmmanager -->hosts
 certs -->lbs
 privateHosts -->nat -->internet
 nat -. "Applicable transfer charges" .->transfer
 workloads -. "Applicable transfer charges" .->transfer
 workloads -. "Platform logs" .->logs
 nat -. "Error logs" .->logs
 logs -->metrics
 identity -. "Access / network boundaries" .->workloads
```

## AWS overview

The AWS provider uses the same BoxLite services with different hosting and network resources.
Sizing comes from the stage configuration; the diagram does not prescribe one instance type.

```mermaid
flowchart TB
 browser(["Browser"])
 sdk(["SDK / CLI"])
 idp(["OIDC identity provider"])
 registry(["OCI registries"])
 subgraph edge["Public edge"]
  cf["CloudFront<br/>Dashboard"]
  alb["Application Load Balancer<br/>API"]
  nlb["Network Load Balancer<br/>Proxy TLS"]
 end
 subgraph vpc["AWS VPC"]
  api["ECS Fargate<br/>API + bundled dashboard"]
  proxy["ECS Fargate<br/>Proxy"]
  runner["EC2 Runner<br/>Nested KVM"]
  box[["Box microVM"]]
  pg[("RDS PostgreSQL")]
  redis[("ElastiCache Redis")]
  s3[("S3 objects + volumes")]
  otel["ECS Fargate<br/>OTel Collector · internal ALB"]
  ch[("Optional ClickHouse<br/>EC2 + EBS or managed")]
 end
 browser -->cf -->alb
 browser -->|"API / WebSocket / SSE"|alb
 sdk -->alb
 browser -->|"Box preview"|nlb -->proxy
 alb -->api
 proxy -->runner -->box
 api -->pg
 api -->redis
 api -->|"Vended STS credentials"|s3
 api -->|"Schedule boxes"|runner
 api -. "JWT / JWKS" .->idp
 api -->otel -->ch
 runner -->|"Pull box images"|registry
```

## Source ownership

| Responsibility | Source |
| --- | --- |
| Stage configuration, identity, encrypted environment and state access | [`mstage/`](../mstage/README.md) |
| Container build, verification and promotion | [`mbuild/`](../mbuild/) |
| Deploy intent and cloud engine selection | [`mdeploy/src/run.ts`](../mdeploy/src/run.ts), [`deploy.ts`](../mdeploy/src/deploy.ts) |
| Resource composition and provider interfaces | [`mdeploy/stack/`](../mdeploy/stack/) |
| GCP resources | [`mdeploy/stack/providers/gcp/`](../mdeploy/stack/providers/gcp/) |
| AWS resources | [`mdeploy/stack/providers/aws/`](../mdeploy/stack/providers/aws/) |
| Runner build, promotion and in-place updates | [`mdeploy/src/`](../mdeploy/src/) |
| Account/project bootstrap and federated CI identity | [`bootstrap/`](../bootstrap/) |
| Retained AWS SST deployment path | [`deployment/`](../deployment/), [`stack/`](../stack/), [`sst.config.ts`](../sst.config.ts) |

`mdeploy` uses Pulumi directly on GCP and SST on AWS. The legacy `npm run deploy` entrypoint
still enters `deployment/sst.ts`; it is not the engine used by every deployment command.
