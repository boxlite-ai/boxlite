## TL;DR

GCP separates runtime service accounts from bootstrap and CI identities, but grants the deployer broad project administration.

# GCP security

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

## Identity boundaries

| Identity | Role |
| --- | --- |
| Bootstrap operator | Enables APIs and manages project IAM, federation and prerequisite stores |
| CI deployer | GitHub Workload Identity Federation → deployer service account |
| Image publisher | Separate Artifact Registry publisher service account |
| Runtime | Service accounts per workload; GKE Workload Identity for proxy |

Bootstrap grants broad project administration, including project IAM administration.
It does not establish a permissions boundary that prevents deployer privilege escalation.
Review project isolation and organization policy when deciding what a stage may administer.
Inspect live GitHub Environment reviewers and federation trust separately from workflow declarations.

The encrypted stage map lives in GCS, with its passphrase in Secret Manager; Pulumi has its own state.
Follow the shared [secret-handling and resource-protection rules](../security.md).

## Runtime and network boundaries

- Public traffic enters through the load balancers; GCP runners and GKE nodes have private addresses.
- Direct Cloud Run egress uses CIDR-based VM ingress rules, with the shared-subnet limitation described in [networking](networking.md).
- The collector's internal ingress restriction remains meaningful even where its invoker IAM binding permits `allUsers`.
- Database/cache use private connectivity. API and collector have different ClickHouse reader/writer credentials.
- Volume access uses scoped temporary credentials and bucket-prefix permissions; stage naming alone does not isolate every volume bucket.


Runner updates converge through [OS Config](runners.md); host protection does not establish rollout health.

Sources: [bootstrap roles](../../bootstrap/gcp.ts), [runtime identities and firewall rules](../../mdeploy/stack/providers/gcp/network.ts).
