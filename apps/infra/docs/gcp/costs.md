## TL;DR

Budget for GCP compute, managed state, storage, networking and operations, including conditional resources and free allowances.

# GCP cost catalog

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

This is the billing surface declared by the GCP application stack and bootstrap, not a live bill.
Quantities depend on the stage, and usage/free allowances determine whether a line has a nonzero charge.
Pricing references were checked on 2026-09-24; use current regional SKUs when estimating.

## GCP billing components

| Component | What BoxLite uses | Cost drivers / condition |
| --- | --- | --- |
| [Cloud Run](https://cloud.google.com/run/pricing) | API/dashboard and OTel collector | CPU, memory, requests, configured minimum instances and transfer |
| [GKE Autopilot](https://cloud.google.com/kubernetes-engine/pricing) | Proxy cluster and two replicas | Cluster management, workload resources and applicable storage/transfer |
| [Compute Engine](https://cloud.google.com/compute/vm-instance-pricing) | Runner fleet; optional ClickHouse VM | VM family, size, count and running hours |
| [Hyperdisk Balanced](https://cloud.google.com/compute/disks-image-pricing) | Runner boot/local state; ClickHouse boot and retained data | Provisioned capacity and performance beyond included baseline |
| [Cloud SQL](https://cloud.google.com/sql/pricing) | PostgreSQL control-plane state | Tier, availability, storage, configured backups/PITR and transfer |
| [Memorystore](https://cloud.google.com/memorystore/docs/redis/pricing) | Redis | Capacity and configured Basic/HA service tier |
| [Cloud Storage](https://cloud.google.com/storage/pricing) | App bucket, dynamic volume buckets, runner artifacts, state/config versions | Stored bytes, operations, retrieval where applicable and transfer |
| [Artifact Registry](https://cloud.google.com/artifact-registry/pricing) | API, proxy and collector images | Retained image bytes and transfer |
| [Secret Manager](https://cloud.google.com/secret-manager/pricing) | Bootstrap/state keys, passwords and CA material | Active versions, access operations and replication |
| [Cloud Load Balancing](https://cloud.google.com/load-balancing/pricing) | Public API HTTPS, private API HTTPS, proxy TLS | Forwarding/proxy resources and processed traffic according to LB type |
| Cloud Load Balancing — ClickHouse | Internal passthrough LB for PSC publication | Additional LB when ClickHouse is self-hosted |
| [Cloud DNS](https://cloud.google.com/dns/pricing) | Private API zone | Managed zone and queries |
| [Cloud NAT and IPv4](https://cloud.google.com/nat/pricing) | Private host/GKE outbound access | Gateway usage, processed bytes and NAT public addresses |
| [Network data transfer](https://cloud.google.com/vpc/pricing) | User responses, image pulls and service traffic | Applicable internet, inter-zone and inter-region transfer; avoid double counting product-included traffic |
| [Cloud Logging](https://cloud.google.com/products/observability/pricing) | Cloud Run/GKE logs, LB health logs, NAT error logs | Ingestion/storage beyond allowances; network-vended logs if enabled |
| [Cloud Monitoring](https://cloud.google.com/products/observability/pricing) | Log-based metrics and API/proxy/runner alert policies | Billable metric ingestion; apply current alerting terms separately |
| [VM Manager / OS Config](https://cloud.google.com/compute/vm-manager/pricing) | Runner policy convergence | Active-agent usage beyond billing-account allowance |
| [Certificate Manager](https://cloud.google.com/certificate-manager/pricing) | Wildcard proxy and regional internal API certificates | Certificate usage beyond applicable free allowance |

Do not count BoxLite Runner, embedded runtime, shim, guest and each box as separate GCE VMs:
they share the paid runner host. Likewise, the dashboard shares the API Cloud Run service.
Autopilot's billing model accounts for its managed capacity; do not add an invented fixed node fleet.

## Conditional and separately owned charges

- [Artifact Analysis scanning](https://cloud.google.com/artifact-analysis/pricing) is billable when enabled.
  Bootstrap enables Container Analysis access; this alone is not evidence that paid automatic scanning
  is enabled. Check the project/repository scanning configuration and the stage's scan gate.
- The ClickHouse producer service attachment has no separate PSC endpoint fee; its load balancer
  remains billable. The consumer endpoint and applicable processing/transfer are owned by the Backoffice
  stack (currently in the producer's project). See [PSC pricing](https://cloud.google.com/vpc/pricing#private-service-connect).
- Cloud Router, VPC/subnet/firewall declarations, IAM identities and private service peering are not
  separate fixed compute instances. Their associated NAT, logging, transfer and managed services can bill.
- Attached load-balancer forwarding-rule addresses follow their specific IP pricing treatment;
  NAT addresses and unused reserved public addresses must be considered separately.
- Public API/dashboard Compute-managed certificates differ from Certificate Manager certificates.
  See [certificate pricing](https://cloud.google.com/certificate-manager/pricing) before assigning a certificate charge.
- Cloudflare, Auth0/OIDC, external SMTP, managed ClickHouse, incident.io, GitHub Actions and optional
  product integrations have their own bills. They are not GCP resources in this stack.

The checked-in GCP stack does not declare Cloud CDN, a Serverless VPC Access connector, or Cloud Build.
Adding them later changes this catalog. Enabling an API is not itself evidence of billable usage.

## Estimate a stage

Read the stage declaration, fleet count, ClickHouse mode, instance scaling and retention first.
Then enter regional resources and expected traffic into the [Google Cloud calculator](https://cloud.google.com/products/calculator).
Compare the estimate with billing export/SKUs after deployment; include retained disks, old object
versions and unused artifacts. An idle application can still have database, Redis, runner, GKE and LB costs.


Source inventory: [GCP providers](../../mdeploy/stack/providers/gcp/) and [bootstrap](../../bootstrap/gcp.ts).
