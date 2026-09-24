## TL;DR

Declare and bootstrap a stage, prepare its artifacts, review a preview, then apply and verify the running services.

# Deploy BoxLite on GCP or AWS

[Infrastructure index](../README.md) · [Configuration](configuration.md) · [mdeploy reference](mdeploy.md)

## Architecture

Start with the [high-level overview and detailed graphs](architecture.md).
GCP hosts API/collector on Cloud Run, the proxy on GKE Autopilot, and runners on Compute Engine.
AWS uses ECS Fargate and EC2 for the corresponding services.

## Prerequisites

| Provide | GCP | AWS |
| --- | --- | --- |
| Cloud account | Billing-enabled project and bootstrap permissions | Account and IAM/SSM/bootstrap permissions |
| Region and capacity | GKE, Cloud SQL, Redis and nested-KVM runner capacity; a supported N4 zone | Corresponding ECS/RDS/Redis services and nested-KVM EC2 capacity |
| Local tools | Node.js 22+, Git, gh, gcloud, Pulumi CLI | Node.js 22+, Git, gh, AWS CLI |
| Build tools | Docker/buildx when publishing locally | Docker/buildx when publishing locally |
| DNS | Cloudflare zone and scoped token | Cloudflare zone and scoped token |
| Identity | An OIDC issuer, SPA client and API audience | Same |

Install repository dependencies with the Make target, then work from the infra directory:

```bash
make _ensure-infra-deps
cd apps/infra
cp .mstage.config.example.json .mstage.config.json
```

Edit the intended stage using [configuration ownership](configuration.md#declare-a-stage).
For GCP, give `dev` a GCP declaration if using the manual workflow; the example's `dev2` name is
usable locally but is not one of that workflow's choices. Set the exact cloud, project/account,
region and protection before any cloud-writing command.

## Deploy an existing stack

For the legacy AWS path, `npm run bootstrap` stores `OIDC_CLIENT_ID` in the SST secret store.
Prepare current mdeploy values and their digest through [configuration](configuration.md) before previewing.

## Bootstrap a stage

```bash
npm run mstage login -- --stage dev
npm run mstage aws whoami -- --stage dev
npm run bootstrap -- --stage dev
npm run mstage config put -- --stage dev
```

Use `login ... --force` when sign-in is needed. GCP needs both gcloud and ADC sessions.
Bootstrap needs broader privileges than the deployer it creates. `--repo owner/name` selects the
GitHub repository explicitly; `--reviewers` accepts numeric GitHub user IDs.
A protected GCP stage requires `--confirm`.

| Bootstrap result | GCP | AWS |
| --- | --- | --- |
| Cloud prerequisites | Service APIs, state/artifact buckets, Secret Manager bootstrap/key, Artifact Registry, OS Config enablement | IAM boundaries, GitHub OIDC role, ECR and runner artifact bucket |
| CI identity | Workload Identity Federation, deployer and image publisher service accounts | GitHub OIDC deploy role |
| GitHub Environment | GCP provider/deployer/publisher variables | AWS account/region and Cloudflare credentials |
| Application values | Seed separately with mstage | Bootstrap imports reviewed `.env` stage settings; set application secrets separately |

For AWS bootstrap, prepare `cp .env.example .env` and fill its reviewed non-secret settings first.
See [AWS bootstrap policy ownership](../bootstrap/aws/README.md).
On GCP, bootstrap does not import the application's values or provision Auth0/SES.

Before the first deploy, populate every required key in the [environment manifest](../mstage.env.json),
including the GCP `pulumi` group. Use secret stdin or a protected JSON file as described in
[configuration](configuration.md#set-application-values). Generate a strong initial
`PULUMI_CONFIG_PASSPHRASE` once; preserve it for existing state rather than replacing it on reruns.
Then certify the imported configuration:

```bash
npm run mstage env set -- --stage dev --digest
npm run mstage env digest -- --stage dev
npm run mstage env list -- --stage dev --select-group deploy
```

Configure OIDC callbacks for the actual dashboard host. See [identity and mail](identity-and-mail.md)
for Auth0, optional SMTP/SES and branding. Recheck live GitHub Environment reviewers after bootstrap.
Bootstrap creates prerequisites; it does not deploy application services or prove they are healthy.

## Deploy through GitHub Actions

The current entrypoint is [mdeploy-all.yml](../../../.github/workflows/mdeploy-all.yml).
It defaults to a preview. Example: preview an open PR's merge result in `dev`:

```bash
gh workflow run mdeploy-all.yml --ref main   -f stage=dev -f ref='#123' -f components=api+runner -f apply=false
```

Replace `#123` with the intended PR, or use a full commit SHA. Review the resolved SHA, stage identity,
artifact identities and complete resource diff. Then dispatch that reviewed SHA with `apply=true`.
A fresh PR ref can resolve to a different merge commit; pin the reviewed SHA when applying.

| Ref | Allowed stages | Artifact path |
| --- | --- | --- |
| Full SHA or open PR `#number` | `dev` | Ensure commit images and runner build exist |
| Published `vX.Y.Z` release | `dev`, `prod` | Version-qualified images and published runner release |

Release dispatches run from `main`. Production accepts releases only. For a protected production apply:

```bash
gh workflow run mdeploy-all.yml --ref main   -f stage=prod -f ref=vX.Y.Z -f components=api+runner -f apply=true -f confirm=true
```

Run a preview of that release first. `components=api` or `runner` narrows artifact preparation,
not the entire infrastructure graph. Runs queue per stage; do not cancel a healthy apply to start another.
Image releases are published/promoted through [mbuild-release](../../../.github/workflows/mbuild-release.yml).

## Retained legacy AWS deployment

`deploy-infra.yml`, `deploy-release.yml`, `build-apps-api-image.yml`, and `npm run deploy`
remain in the repository. They use the legacy SST tree and its own artifact selectors.
Use them only when intentionally operating that path; do not mix their selectors with mdeploy's.

| Legacy operation | Behavior |
| --- | --- |
| `deploy-infra.yml` | Build deployment from a main commit or allowed same-repository PR head |
| `deploy-release.yml` | Deploy existing release artifacts |
| `build-apps-api-image.yml` | Build/promote the legacy API image |
| `npm run deploy -- --stage dev` | Legacy guarded full-stack deploy |
| `--exclude Runner` / `--exclude Api` | Legacy component scopes; excluded leg keeps its prior revision |

The legacy wrapper refuses targeted applies, checks its
[capability manifest](../deployment/capabilities.json), enforces the
[runner policy pack](../policies/runner/), and runs its own post-deploy checks.
Its API fallback can build locally when no published ref is selected; mdeploy expects published images.
See [artifact selection](../artifacts/source.ts), [scope rules](../deployment/scope.ts),
[wrapper](../deployment/sst.ts), and the [workflow reference](../../../.github/workflows/README.md).
Preview before switching entrypoints; shared logical names are not proof of a no-op transition.

## Deploy locally

Local deployment uses the same stage configuration and artifact identities. Publish or promote
images first with [mbuild](../mbuild/README.md), and prepare the selected [runner artifact](runners.md).
The following example assumes release images `vX.Y.Z-<sha>` and runner release `X.Y.Z` already exist:

```bash
export BOXLITE_IMAGE_TAG='vX.Y.Z-<full-commit-sha>'
export VERSION='X.Y.Z'
npm run mstage login -- --stage dev
npm run mstage env digest -- --stage dev
npm run mbuild verify -- --tag <full-commit-sha> --version vX.Y.Z --stage dev
npm run mdeploy -- --stage dev --diff
npm run mdeploy -- --stage dev
```

Substitute real values and inspect the preview before the last command. Add `--confirm` for a
protected stage. For a commit runner build, use the selectors in the [runner runbook](runners.md).
`mdeploy --local-env` bypasses store loading and is an explicit diagnostic option, not the default.

## Secrets & credentials

[Configuration](configuration.md) owns the file/store/CI boundaries, and
[security](security.md) explains runtime identity and protection. Inspect names with
`npm run mstage env list -- --stage dev`; value exports belong in a secure destination.

### Cloudflare API token

Provide an account-owned token with **Zone:Read** and **DNS:Edit**, restricted to the zone used by
`STACK_DOMAIN` and `PROXY_DOMAIN`. Set `CLOUDFLARE_DEFAULT_ACCOUNT_ID` and `CLOUDFLARE_ZONE_ID`
to the intended account/zone. Both are required by the current deployment group, alongside the token.
The token is created in Cloudflare's dashboard; a provider login does not generate it.

GCP mdeploy reads the credentials through the encrypted `deploy` group. AWS bootstrap also maintains
the SSM/GitHub credential copies needed by the retained legacy SST path. Verify the path you use
rather than assuming that updating one destination rotates all copies.

## Verify the result

| Check | Evidence to inspect |
| --- | --- |
| Intended deployment | Resolved stage, cloud/project/account, commit and artifact identities |
| Infrastructure | Successful apply with no unexpected replacement or deletion |
| API and dashboard | Public HTTPS, `/api/health`, dashboard load and OIDC login |
| Proxy | Healthy load-balancer backends and an actual box preview/tunnel |
| Runners | Fleet registration, target health identity, box create/exec/stop |
| Persistent volumes | Create/mount/write/read using a test volume if enabled |
| Telemetry | A new test event reaches the configured destination and is queryable |

On GCP, also inspect OS Config reports: an applied policy is not a converged fleet.
Use the [runner](runners.md#verify-and-recover), [network](networking.md), and
[ClickHouse](clickhouse.md) guides to locate the failing boundary.
The legacy wrapper's automatic checks do not imply that mdeploy performs the same checks.

## Operating rules

**The Runner holds state.** `/var/lib/boxlite` and the live microVMs are on its
root disk, so `stack/runners.ts` marks it `protect: true` with
`ignoreChanges: ['ami', 'userDataBase64']`. Routine deploys never replace it.
The CI gate rejects any Runner delete, replace, or protected-property change — so
scaling down remains a separate operation this repository does not implement,
while scaling out is an ordinary deploy.

### Scaling Runners out

`RUNNERS` in the stage's secret store says how many Runners the stack declares.
Raising it is the whole decision; the next deploy creates the host:

```bash
cd apps/infra
npm run sst -- secret set RUNNERS 2 --stage dev     # declare it

gh workflow run deploy-infra.yml --ref main \
  -f stage=dev -f components=api+runner -f apply=false   # preview the create
gh workflow run deploy-infra.yml --ref main \
  -f stage=dev -f components=api+runner -f apply=true    # create it
```

The policy pack guards the hosts that already exist, not the count. A Runner the
inventory declares and the state does not hold yet is a create, and a create has
no state to be compared against — so the two fingerprint checks are skipped for
it. Nothing else is: the new host still has to be `protect: true`, ignore exactly
`ami` and `userDataBase64`, and carry the identity tags its inventory entry
specifies. A Runner the state holds but the inventory has stopped declaring is
still refused, because Pulumi reads an undeclared protected resource as a delete.

Keep the Runner in `components`. `--exclude Runner` leaves the new instance out of
the plan, so the run reports success having created nothing and the host appears
on whichever later deploy does include it.

The API seeds only the default Runner. Extra ones are registered with the control
plane after the deploy by `RegisterExtraRunners`, each with its own token.

**Version bumps reach the fleet by rolling upgrade, not replacement.** A deploy
runs `scripts/runner-update-binary.mjs` per host over SSM, chained so hosts
upgrade one at a time. Each host verifies the selected artifact's checksum before
stopping its service, and restores its backup if the new binary fails to report
healthy.

**Runners cache image refs exactly.** `BOXLITE_SYSTEM_IMAGES` (comma-separated
`name=ref`) adds box images without a code deploy, but publish updated bytes
under a new tag or digest — repushing a mutable tag leaves already-cached
Runners serving the old image.

**A Runner's version is its artifact's identity.** On the release path it is
`Cargo.toml`'s `version` at the repo root; on the build path it is that version
plus the deployed commit, so two commits sharing a Cargo version stay distinct
upgrade targets. The accidental-downgrade guard applies only to the release
path — commit builds have no meaningful older/newer ordering.

**Proxy topology is protected.** The NLB, TLS listener, and target group refuse
replacement. A deliberate migration is two deploys: first set the three Proxy
`opts.protect` values to `false` and ship that metadata-only change, then do the
reviewed migration. Never combine them.

**Deploys self-verify.** After a successful deploy the wrapper checks that the
NLB listener forwards to the Proxy service's target group with healthy targets,
probes `/health` over both the base and a wildcard hostname, and confirms
`/api/config` reports the expected issuer, version, and Proxy host. The check is
read-only and exits nonzero on failure — it does **not** roll back. By the time
it runs the deploy has already applied its changes, so a failure means the stack
is live in the state that failed the check; recover by fixing forward or
redeploying a known-good revision.

**`/api/*` bypasses CloudFront on purpose.** CloudFront caps WebSockets at 10
minutes, which would kill `exec`/`attach` sessions. Use
`https://api.<STACK_DOMAIN>/api` for SDK and CLI profiles; the CloudFront path
is only for short request/response calls.

## Troubleshooting

**"concurrent update detected"** — `npm run sst -- unlock --stage dev`, then retry.

**Service stuck at `rolloutState: FAILED` with 1 running task** — stale event
from an earlier failed deploy. If `runningCount == desiredCount`, ignore it.

**`Failed to fetch OpenID configuration`** — the API cannot reach
`<OIDC_ISSUER_BASE_URL>/.well-known/openid-configuration`. Check egress from the
API container and that the issuer host works.

**`unexpected issuer URI`** — `OIDC_ISSUER_BASE_URL` does not byte-match what
the IdP's discovery doc reports as `issuer`. Auth0 includes a trailing slash.

**`Callback URL mismatch`** — add `http://127.0.0.1:5555/callback` to the Auth0
SPA app's Allowed Callback URLs. The CLI's loopback URL is a separate entry from
the dashboard's.

**`No end session endpoint` on logout** — the API's IdP discovery probe failed
at startup. Fix connectivity; the next `/api/config` self-heals.

**`Email verification required`** — an Auth0 database token lacks a strict
`email_verified: true` claim. The API answers `403` with
`code: email_verification_required`; the token itself is valid, so signing in
again cannot clear it and the dashboard shows a "Verify your email address"
screen rather than bouncing through login. For dashboard/desktop use browser
login to finish the hosted verification Form. On SSH, finish verification
through the dashboard in another browser, then retry device login. Verify the
`boxlite-login-policy` Action is deployed and bound using the login-policy
preview command above — without it an existing unverified account has no way to
reach the Form, and the 403 never clears.

**Runner never reaches `READY`** — its `BOXLITE_RUNNER_TOKEN` must equal the DB
row's `apiKey`. Check `journalctl -u boxlite-runner` via `aws ssm start-session`.

**Box preview cannot connect** — check that the NLB listener's target group
matches the Proxy service attachment and has a healthy registered target.

**Dashboard terminal cannot connect** — it uses the direct API host, not the
Proxy. Verify `https://api.<STACK_DOMAIN>/api/config`.

**Docker build "broken pipe"** — transient ECR push failure. Retry.

## Cost

ap-southeast-1 on-demand, approximate:

| Resource | Monthly |
| --- | --- |
| EC2 c8i.2xlarge (Runner) | ~$325 |
| Load balancers (2 ALB + 1 NLB) | ~$51 |
| 3x Fargate 0.25 vCPU / 0.5 GB | ~$28 |
| CloudFront + S3 + CloudWatch Logs | ~$20 |
| 2x NAT EC2 (`t4g.nano`) + public IPv4 | ~$16 |
| RDS `t4g.micro` Postgres | ~$15 |
| ElastiCache Redis | ~$15 |
| **Total** | **~$470** |

Only the `prod` stage retains S3 buckets and RDS snapshots on removal
(`removal: 'retain'`); every other stage is disposable. Whole-stack teardown
needs a separate reviewed Proxy and Runner decommission runbook, which is not
implemented here.

## Reference

- `.env.example` — every configuration variable, with required/optional tiers
- `stack/*.ts` — the resource graph, one file per domain; comments carry the design rationale
- `deployment/*.ts` — the guarded wrapper, scope, stage config, and post-deploy verification
- `scripts/*.mjs` — launchers whose paths are pinned in Pulumi state; see `scripts/README.md`
- `.github/workflows/deploy-infra.yml` — the guarded CI deployment
