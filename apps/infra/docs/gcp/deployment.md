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

API domain onboarding requires the first three settings below. Supply them as
plain values in the stage's API environment group; do not put them only in a local
shell or the secrets-reference channel.
The manifest declares these as optional API values: an unconfigured environment
stays disabled, while an enabled environment must supply all three together.

| Setting | Required value |
| --- | --- |
| `CUSTOM_DOMAIN_GCP_PROJECT` | Project containing the proxy's Certificate Manager resources |
| `CUSTOM_DOMAIN_GCP_CERTIFICATE_MAP` | Existing global map ID attached to the proxy TargetSSLProxy; an ID, not a resource URL |
| `CUSTOM_DOMAIN_TRAFFIC_HOST` | Stable public hostname resolving to the proxy's reserved entry IPs, e.g. the existing proxy root |
| `CUSTOM_DOMAIN_EDGE_IPS` | Automatically supplied from the stack's reserved proxy address; any stored value is overridden on GCP |
| `CUSTOM_DOMAIN_RESERVED_SUFFIXES` | Optional comma-separated additional platform namespaces, including retired platform suffixes |

The GCP bundle shares the existing `ProxyAddress` resource between the API,
proxy forwarding rule and DNS records. For example, when that resource resolves
to `192.0.2.10`, the API receives `CUSTOM_DOMAIN_EDGE_IPS=192.0.2.10` without a
stored IP setting or a DNS lookup. Pulumi tracks the resource dependency during
both first deployment and updates; the resource's logical and physical names stay
unchanged. The API still validates this runtime setting and uses it for DNS
comparison and TLS probes. Deploy this infrastructure change before removing an
existing stored value; older deployment code still needs it.

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
grant map mutation. The role also includes `resourcemanager.projects.get` on the
configured certificate project. Certificate Manager can return project IDs in resource
names and project numbers in references; the API resolves their exact mapping through
Resource Manager and validates full paths, ownership labels and generation before use
or deletion. Deploy the role update before the API, and enable the Resource Manager
API in that project; the GCP bootstrap already enables it. Failed lookups are retried,
including during IAM propagation, rather than cached as a permanent failure.

With the feature enabled, Cloud Run allocates CPU outside requests without imposing
a minimum instance count for custom domains. Hosted CI independently requires a
service-level minimum of one when configured. Background domain checks run while
an instance exists and resume at startup after scale-to-zero; continuous CPU does
not keep an instance alive. Other API periodic work, including Box autostop and
usage handling, is unchanged; this does not establish that every API task can safely pause.
Every proxy receives the required `PROXY_DOMAIN` namespace;
other valid customer hosts always use exact domain lookup.
API onboarding still requires all three operator-supplied GCP settings above.
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

The provider reads the current DNS authorization before checking its CNAME. Changed
records are published to the Dashboard before issuance continues. Only terminal
`FAILED` certificates without a valid remaining lifetime are replaced, after at least
one hour from creation; the owned map entry is removed first, and the authorization
record is retained. `PROVISIONING` certificates remain in place even when an individual
authorization attempt failed. See the [customer waiting and retry guide](../../../../docs/concepts/networking.md#bring-your-own-domain).

Resource/rate failures persist with backoff; manual retry cannot bypass provider
capacity errors. Unbind and subscription suspension retain certificates and their
cloud allocation; deletion frees it only after recoverable cleanup completes.

Request-driven cutover requires draining every old API revision and its in-flight domain leases before applying the new migration and enabling new writers.
The migration disables old due scanning, but an old verify request can reschedule it; mixed old/new writers are unsupported.
Retain the data tables and resource identities; rollback must use a compatible forward fix, not the legacy worker.
Legacy unconfirmed setups preserve their records and resources but require confirmation; old capped certificate deadlines are not actual expiration dates.

The API task starts once during application bootstrap, then checks every 60 seconds while the process receives CPU.
Each round advances at most three due confirmed setups and performs one maintenance round; existing leases prevent conflicting hostname work.
Startup awaits that round, and shutdown stops new rounds and awaits active work; cold starts can therefore include setup-check latency.
No Cloud Scheduler is added; custom domains retain continuous CPU but do not require a minimum instance count.
A stopped or CPU-throttled API cannot guarantee minute-by-minute execution; restart or resumed execution continues from saved progress.

Maintenance observes ready certificate/TLS state without revoking setup on a single timeout, expires unconfirmed/unclaimed drafts after thirty days,
and revisits cleaned tombstones daily to catch late cloud creates. It does not poll drafts for DNS readiness.
Authenticated admin `POST /admin/custom-domains/maintain` remains available for manual recovery, processing at most one due resource round.

Operational acceptance still requires:

- Verify deployed startup recovery, shared leases and minute checks under the actual Cloud Run CPU allocation.
- Monitor due-work age and cleanup backlog; the fixed per-instance batch is not a completion-time guarantee.
- Configure Certificate Manager expiration log alerts and an actual notification channel, independently of API/UI activity.

No cloud task execution, log alert or notification channel is deployed or validated here.
Guaranteed cleanup and monitoring during API inactivity require an independent trigger; that infrastructure remains outside this change.

Sources: [bootstrap](../../bootstrap/gcp.ts), [Pulumi entrypoint](../../mdeploy/pulumi/program.ts).
