## TL;DR

Declare the GCP project, bootstrap its prerequisites, load application values, then preview, apply and verify convergence.

# Deploy BoxLite on GCP

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

## Prerequisites

| Provide | Requirement |
| --- | --- |
| Project | A separate project for each stage, with billing enabled and bootstrap permissions |
| Region and zone | GKE, Cloud SQL, Redis and nested-KVM capacity; a supported N4 zone |
| Local tools | Node.js 22+, Git, gh, gcloud and Pulumi CLI |
| Build tools | Docker/buildx when publishing locally |
| DNS and identity | Cloudflare zone/token and an OIDC issuer, SPA client and API audience |

Run `make _ensure-infra-deps` from the repository root, then work from `apps/infra`.
Copy `.mstage.config.example.json` to `.mstage.config.json` and declare `home: "gcp"`,
the exact project, region, zone, protection and resource sizing. See [configuration](../configuration.md).
The manual workflow accepts `dev`, `stage` and `prod`; stage follows dev for commit/PR candidates, while published stable releases run from main.
The example's `dev2` works locally but is not a workflow choice.

## Bootstrap a stage

```bash
npm run mstage login -- --stage dev
npm run mstage aws whoami -- --stage dev
npm run bootstrap -- --stage dev
npm run mstage config put -- --stage dev
```

The historical `mstage aws whoami` command reports the selected cloud's identity, including GCP.
Use `login ... --force` when sign-in is needed; both gcloud CLI and ADC sessions are required.
Bootstrap needs broader privileges than the deployer it creates. A protected stage requires `--confirm`.
Use `--repo owner/name` to select GitHub explicitly; `--reviewers` accepts numeric GitHub user IDs.

| Bootstrap owns | Result |
| --- | --- |
| Cloud prerequisites | Service APIs, state/artifact buckets, Secret Manager bootstrap/key, Artifact Registry and OS Config enablement |
| CI identity | Workload Identity Federation, deployer and image publisher service accounts |
| GitHub Environment | Provider/deployer/publisher variables |

Bootstrap does not import application values or create Auth0 identities. Populate required
[manifest](../../mstage.env.json) keys with mstage, including `OIDC_CLIENT_ID` and the `pulumi` group.
Use [secret stdin or protected JSON input](../configuration.md#set-application-values).
Generate a strong `PULUMI_CONFIG_PASSPHRASE` once and preserve it for existing state.

Then certify the imported configuration:

```bash
npm run mstage env set -- --stage dev --digest
npm run mstage env digest -- --stage dev
npm run mstage env list -- --stage dev --select-group deploy
```

Configure OIDC callbacks for the actual dashboard host. See [identity and mail](identity-and-mail.md)
for Auth0 and optional SMTP; use the [shared branding procedure](../identity-and-mail.md#universal-login-branding).
Recheck live GitHub Environment reviewers after bootstrap.
Bootstrap creates prerequisites; it does not deploy application services or prove they are healthy.

## Preview and apply

Follow the shared [GitHub Actions workflow](../deployment.md#deploy-through-github-actions)
or [local preview/apply commands](../deployment.md#deploy-an-existing-stack).
mdeploy uses Pulumi with GCS state. API/dashboard, collector and registry proxy run on Cloud Run,
the proxy runs on GKE Autopilot, and runners use Compute Engine; see [architecture](architecture.md).
Cloudflare credentials come from the encrypted `deploy` group.

## Verify and recover

Run the shared [service checks](../deployment.md#verify-the-result), then inspect
[OS Config reports and runner health](runners.md#verify-and-recover). Pulumi apply returns before
the fleet necessarily converges. Check gcloud and ADC identity separately for credential failures.
Use [networking](networking.md) for private routes/firewalls and [ClickHouse](clickhouse.md) for ingestion failures.
For locks, refresh or removal, follow [shared recovery](../deployment.md#recovery-and-teardown).

## Customer domain HTTPS

API domain onboarding requires all four settings below. Supply them as
plain values in the stage's API environment group; do not put them only in a local
shell or the secrets-reference channel.
The manifest declares these as optional API values: an unconfigured environment
stays disabled, while an enabled environment must supply all four together.

| Setting | Required value |
| --- | --- |
| `CUSTOM_DOMAIN_GCP_PROJECT` | Project containing the proxy's Certificate Manager resources |
| `CUSTOM_DOMAIN_GCP_CERTIFICATE_MAP` | Existing global map ID attached to the proxy TargetSSLProxy; an ID, not a resource URL |
| `CUSTOM_DOMAIN_TRAFFIC_HOST` | Stable public hostname resolving to the proxy's reserved entry IPs, e.g. the existing proxy root |
| `CUSTOM_DOMAIN_EDGE_IPS` | Comma-separated fixed entry IPs, at most four; used for DNS comparison and TLS probes |
| `CUSTOM_DOMAIN_RESERVED_SUFFIXES` | Optional comma-separated additional platform namespaces, including retired platform suffixes |

Choose the workflow branch containing both the environment declarations and the
custom-domain GCP provider. The workflow's `ref` input chooses application artifacts;
it does not switch the infrastructure checkout. For a stage deployment from a
branch containing both changes, leave `ref` empty to use that dispatch's commit
for the artifacts too. Preview first and inspect the full resource diff:
`components=api` narrows artifact preparation, not the infrastructure update.

The API also needs its existing Commerce connection to determine subscription
eligibility. Missing billing connectivity cannot authorize custom-domain access.
The GCP provider grants the API service account a custom role for DNS authorization,
certificate and map-entry create/get/delete/use plus operation get; it does not
grant map mutation. With the feature enabled, Cloud Run keeps at least one instance
and allocates CPU outside requests so the reconciliation worker continues at idle.
This changes idle cost. Every proxy receives the required `PROXY_DOMAIN` namespace;
other valid customer hosts always use exact domain lookup.
API onboarding still requires all GCP settings above.
IP-host `GET /health` remains available to GKE and load-balancer probes, while
customer-host `/health` resolves to the customer's service.

Before enabling, deploy the migration and compatible API/proxy versions everywhere.
Confirm the Certificate Manager API is enabled, the map is attached, the selected
project has resource and request capacity, and the runtime service account can
perform the required operations. Admin CLI access does not establish runtime IAM.
Customer CNAME records must use DNS-only mode; the platform never receives customer DNS credentials.

Use a controlled hostname to check the Dashboard TXT challenge, certificate CNAME,
real issuance, SNI on each fixed entry IP, public Box access, suspension, recovery
and deletion cleanup. Renewal and production-scale reconciliation latency need
separate observation; local provider mocks do not establish these properties.
No live issuance or deployment was performed as part of the local implementation.

Resource/rate failures persist with backoff; manual retry cannot bypass provider
capacity errors. Unbind and subscription suspension retain certificates and their
cloud allocation; deletion frees it only after asynchronous cleanup. Keep the worker
enabled until pending deletions drain. Roll back only to a version that preserves
exact-host routing, custom-domain eligibility checks and platform-only quota;
do not remove the state tables before cloud cleanup.

Sources: [bootstrap](../../bootstrap/gcp.ts), [Pulumi entrypoint](../../mdeploy/pulumi/program.ts).
