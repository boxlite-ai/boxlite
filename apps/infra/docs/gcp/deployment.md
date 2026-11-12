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

Set all three values in the stage's plain API environment group to enable custom domains;
leave all three unset to disable onboarding.

| Setting | Required value |
| --- | --- |
| `CUSTOM_DOMAIN_GCP_PROJECT` | Project containing the proxy's Certificate Manager resources |
| `CUSTOM_DOMAIN_GCP_CERTIFICATE_MAP` | Existing global map ID attached to the proxy TargetSSLProxy, not a resource URL |
| `CUSTOM_DOMAIN_TRAFFIC_HOST` | Stable public hostname resolving to the proxy entry, e.g. the proxy root |

Customers use a traffic CNAME to this hostname. HTTPS checks resolve the platform hostname's IPv4/IPv6 addresses
and connect with the customer hostname as SNI, requiring certificate validation; no fixed IP list is configured.
The existing edge address, forwarding rule and DNS records retain their resource identities.

Enable Certificate Manager and Resource Manager in the certificate project, attach the map to the proxy,
and deploy the API service account's custom role before enabling onboarding.
The provider grants DNS authorization, certificate and map-entry operations plus `resourcemanager.projects.get`;
it does not grant certificate-map mutation. The API also requires its existing Commerce connection for subscription eligibility.
Customer CNAME records must use DNS-only mode; see the [DNS guide](../../../../docs/concepts/networking.md#bring-your-own-domain).

Custom domains set Cloud Run `cpuIdle: false`, incurring CPU costs while an instance exists, without adding a minimum instance count.
Hosted CI independently sets a service-level minimum of one when enabled.
The API task runs at startup and every minute, advancing at most three due confirmed setups and one maintenance round.
Startup awaits that work; hostname leases coordinate replicas, and shutdown awaits the active round.
Scale-to-zero pauses progress until the API starts again; no independent Cloud Scheduler or expiration alerts are provisioned.

For upgrades from the earlier custom-domain workflow, drain old API revisions and in-flight leases before applying the migration and enabling new writers.
Mixed old/new writers are unsupported; retain resource identities and use a compatible forward fix for rollback.
Unconfirmed legacy setups require explicit verification, and capped legacy deadlines do not establish certificate expiration.

Maintenance expires unconfirmed, unclaimed drafts after thirty idle days, observes ready TLS/certificates hourly,
and revisits cleaned tombstones daily for late cloud creates. Unbind and subscription suspension retain cloud resources.
Admin `POST /admin/custom-domains/maintain` invokes one bounded maintenance round for recovery.

Before production use, verify issuance, customer SNI, public Box access, suspension, recovery and deletion with a controlled hostname.
Monitor due-work age and cleanup backlog, and configure certificate-expiration alerts with a notification channel.
Cleanup and monitoring during API inactivity require an independent trigger.

Sources: [bootstrap](../../bootstrap/gcp.ts), [Pulumi entrypoint](../../mdeploy/pulumi/program.ts).
