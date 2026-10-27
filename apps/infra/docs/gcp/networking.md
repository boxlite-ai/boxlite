## TL;DR

GCP uses private runner hosts, direct Cloud Run VPC egress, and separate public and internal load balancers.

# GCP networking

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

## Traffic paths

| Traffic | Path |
| --- | --- |
| Browser/SDK → API | Public HTTPS Application Load Balancer → serverless NEG → Cloud Run API |
| Browser → dashboard | Same public load balancer → API image's bundled SPA |
| Box preview/tunnel | Public TLS proxy Network Load Balancer → zonal NEGs → GKE proxy → runner |
| Proxy → lookup/authorization | Private API name → internal HTTPS load balancer → Cloud Run API |
| Runner → registration/callback | Same private API path |
| API → runner | Direct VPC egress → runner TCP 3003 |
| API → SQL/Redis | Direct VPC egress → Private Service Access → managed service |
| API/collector → ClickHouse | Direct VPC egress → private VM TCP 8123 |
| Runner → registry proxy | Private Google Access → internal-ingress Cloud Run `run.app` address over HTTP/2 (not yet configured on hosts) |
| Registry proxy → runner key check | Workload-subnet direct egress → private API path; upstream registries via Cloud Run's own egress |
| API/proxy/runner → collector (OTLP) | Private `run.app.` zone → `private.googleapis.com` → Private Google Access → Cloud Run collector |
| Private VM/GKE → internet | Cloud NAT when internet egress is enabled |
| Backoffice → ClickHouse | Consumer PSC endpoint → service attachment → internal passthrough LB |

Cloud Run API ingress is restricted to internal/load-balancer traffic. The collector and registry proxy are internal-only.
Their VPC egress mode is `PRIVATE_RANGES_ONLY`: public internet traffic does not automatically take
Cloud NAT. There is no Serverless VPC Access connector in this resource graph.
The API's built-in Cloud SQL connection uses its mounted Unix socket; Redis uses TLS and a mounted CA.

## Address spaces

| Range | Purpose |
| --- | --- |
| `10.20.0.0/20` | Primary workload subnet |
| `10.20.16.0/24` | Regional managed proxy subnet for the internal API load balancer |
| `10.20.17.0/24` | PSC producer NAT subnet for ClickHouse publication |
| `10.20.20.0/22` | Dedicated Cloud Run direct-egress subnet |
| `10.20.32.0/19` | GKE proxy pod secondary range |
| `10.20.64.0/22` | GKE service secondary range |
| Allocated `/16` | Private Service Access range, selected by the provider |

Cloud Run→VM ingress rules match the dedicated subnet CIDR. Do not substitute source service
accounts or network tags: [Direct VPC egress limitations](https://cloud.google.com/run/docs/configuring/vpc-direct-vpc)
do not support those selectors for ingress firewall rules. The shared egress subnet admits both API
and collector traffic where that range is allowed; it does not distinguish the two services.
The registry proxy egresses from the primary workload subnet instead, so no range-keyed rule admits it to a VM.
GKE proxy→runner access matches the pod range. Runner instances have no external IP.

## DNS and TLS

Cloudflare hosts public records for API, dashboard and wildcard box access. The private Cloud DNS
zone resolves the API hostname to the internal load balancer inside the VPC. A second private zone
answers for `run.app`; see [Telemetry to the collector](#telemetry-to-the-collector). Public and private API
paths use HTTPS; the proxy's public TLS terminates at the load balancer before TCP reaches port 4000.
Certificate Manager serves wildcard proxy and regional internal-API certificates.
Public API/dashboard certificates use the Compute managed-certificate resources.

## Telemetry to the collector

Every sender is handed the collector's `run.app` URL, which resolves to a **public** Google front
end; `ingress: internal` is an ACL at that door, not a private endpoint. With `PRIVATE_RANGES_ONLY`
egress, the API would send a public answer out Cloud Run's own path, and the collector would see a
request from nowhere and answer **404**. Sharing a subnet does not help: a Cloud Run service's subnet
address carries its egress only, so the API cannot reach the collector there either.

So the VPC gives `run.app` a private answer: a private zone, bound to this VPC alone, with an apex
`A` onto `private.googleapis.com` (`199.36.153.8/30`) and a `*.run.app` `CNAME` onto the apex. Both
subnets have Private Google Access and the VPC keeps its default route, which is all those addresses
need. No workload is configured differently.

- **The zone covers every `run.app` name** resolved in the VPC, another project's included. Today the
  collector is the only one anything here calls.
- **Rolling back means deleting the zone**, records first. An empty zone still answers for `run.app`
  — with NXDOMAIN — which silences the proxy and the runner too.

Verbatim sources:

- A Cloud Run caller "must use the VPC network to be considered internal"; one listed way is to
  "Enable Private Google Access on the subnet associated with the *source* resource and configure
  DNS to resolve `run.app` URLs to the `private.googleapis.com` or `restricted.googleapis.com`
  ranges" — [Private networking and Cloud Run](https://docs.cloud.google.com/run/docs/securing/private-networking),
  *Receive requests from other Cloud Run resources or App Engine*.
- `--vpc-egress=private-ranges-only` "Sends outbound traffic to private IP addresses (RFC 1918 and
  Private Google Access IPs) through Direct VPC egress" — [`gcloud run deploy`](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy).
- "When Private Google Access is enabled, resources on the subnets can access your Cloud Run
  resources at the default `run.app` URL" — same page, *Receive requests from VPC networks*.
- "Traffic sent to Google APIs and services are routed through Private Google Access even if the VM
  instance initiating the connections uses Public NAT" — [Cloud NAT overview](https://docs.cloud.google.com/nat/docs/overview).
- "Cloud Run services and jobs don't support Direct VPC *ingress*" — [Direct VPC egress](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc).
- The `private.googleapis.com` row lists `*.run.app` by name, and the guide gives this zone shape —
  [Configure Private Google Access](https://docs.cloud.google.com/vpc/docs/configure-private-google-access).
- "Remove all records in the zone except for the `SOA` and `NS` records" before deleting it —
  [Managed zones](https://docs.cloud.google.com/dns/docs/zones).

## Diagnose a failed path

Check DNS resolution, destination port, workload readiness, route/egress mode, then the exact firewall
source selector. A healthy runner with no incoming requests can indicate a blocked path rather than
a broken runner. For proxy failures, inspect pod readiness and NEG/backend health separately.
Use an actual box preview or exec request to verify the full path after changing a network rule.


Sources: [network](../../mdeploy/stack/providers/gcp/network.ts), [API](../../mdeploy/stack/providers/gcp/api.ts), [proxy](../../mdeploy/stack/providers/gcp/edge.ts), [cluster](../../mdeploy/stack/providers/gcp/cluster.ts), [registry proxy](../../mdeploy/stack/providers/gcp/registry-proxy.ts), [ClickStack publication](../../mdeploy/stack/providers/gcp/clickstack.ts).
