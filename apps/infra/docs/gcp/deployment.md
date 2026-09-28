## TL;DR

Declare the GCP project, bootstrap its prerequisites, load application values, then preview, apply and verify convergence.

# Deploy BoxLite on GCP

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

## Prerequisites

| Provide | Requirement |
| --- | --- |
| Project | Billing enabled and bootstrap permissions |
| Region and zone | GKE, Cloud SQL, Redis and nested-KVM capacity; a supported N4 zone |
| Local tools | Node.js 22+, Git, gh, gcloud and Pulumi CLI |
| Build tools | Docker/buildx when publishing locally |
| DNS and identity | Cloudflare zone/token and an OIDC issuer, SPA client and API audience |

Run `make _ensure-infra-deps` from the repository root, then work from `apps/infra`.
Copy `.mstage.config.example.json` to `.mstage.config.json` and declare `home: "gcp"`,
the exact project, region, zone, protection and resource sizing. See [configuration](../configuration.md).
The manual workflow accepts `dev` and `prod`; the example's `dev2` works locally but is not a workflow choice.

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
mdeploy uses Pulumi with GCS state. API/dashboard and collector run on Cloud Run,
the proxy runs on GKE Autopilot, and runners use Compute Engine; see [architecture](architecture.md).
Cloudflare credentials come from the encrypted `deploy` group.

## Verify and recover

Run the shared [service checks](../deployment.md#verify-the-result), then inspect
[OS Config reports and runner health](runners.md#verify-and-recover). Pulumi apply returns before
the fleet necessarily converges. Check gcloud and ADC identity separately for credential failures.
Use [networking](networking.md) for private routes/firewalls and [ClickHouse](clickhouse.md) for ingestion failures.
For locks, refresh or removal, follow [shared recovery](../deployment.md#recovery-and-teardown).

Sources: [bootstrap](../../bootstrap/gcp.ts), [Pulumi entrypoint](../../mdeploy/pulumi/program.ts).
