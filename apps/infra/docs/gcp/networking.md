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
| Private VM/GKE → internet | Cloud NAT when internet egress is enabled |
| Backoffice → ClickHouse | Consumer PSC endpoint → service attachment → internal passthrough LB |

Cloud Run API ingress is restricted to internal/load-balancer traffic. The collector is internal-only.
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
GKE proxy→runner access matches the pod range. Runner instances have no external IP.

## DNS and TLS

Cloudflare hosts public records for API, dashboard and wildcard box access. The private Cloud DNS
zone resolves the API hostname to the internal load balancer inside the VPC. Public and private API
paths use HTTPS; the proxy's public TLS terminates at the load balancer before TCP reaches port 4000.
Certificate Manager serves wildcard proxy and regional internal-API certificates.
Public API/dashboard certificates use the Compute managed-certificate resources.

## Diagnose a failed path

Check DNS resolution, destination port, workload readiness, route/egress mode, then the exact firewall
source selector. A healthy runner with no incoming requests can indicate a blocked path rather than
a broken runner. For proxy failures, inspect pod readiness and NEG/backend health separately.
Use an actual box preview or exec request to verify the full path after changing a network rule.


Sources: [network](../../mdeploy/stack/providers/gcp/network.ts), [API](../../mdeploy/stack/providers/gcp/api.ts), [proxy](../../mdeploy/stack/providers/gcp/edge.ts), [cluster](../../mdeploy/stack/providers/gcp/cluster.ts), [ClickStack publication](../../mdeploy/stack/providers/gcp/clickstack.ts).
