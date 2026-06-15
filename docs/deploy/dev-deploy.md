# Dev Deploy Workflow

`Deploy Dev` is the operator entrypoint for deploying the SST dev stage and,
optionally, rolling out a runner binary to the dev runner EC2 instances.

## User Flow

Open GitHub Actions, select `Deploy Dev`, then click `Run workflow`.

The branch selector is the source checkout. Use `main` for normal dev deploys
or a PR branch for dev validation.

Inputs:

| Input         | Values                                                            | Meaning                                     |
| ------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| `deploy_mode` | `diff-only`, `deploy`                                             | Preview SST changes or actually deploy dev. |
| `runner_mode` | `auto`, `skip`, `existing-release`, `temporary-build`, `rollback` | Runner rollout strategy.                    |
| `runner_ref`  | `0.9.5`, empty                                                    | Required only for `existing-release`.       |
| `confirm`     | `dev`                                                             | Required safety confirmation.               |

Common runs:

| Goal                                                   | Inputs                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Preview dev infra/service changes                      | `deploy_mode=diff-only`, `runner_mode=auto`                                  |
| Deploy SST dev, auto-blocking accidental runner drift  | `deploy_mode=deploy`, `runner_mode=auto`                                     |
| Deploy SST dev only, explicitly ignoring runner checks | `deploy_mode=deploy`, `runner_mode=skip`                                     |
| Deploy dev and install a released runner               | `deploy_mode=deploy`, `runner_mode=existing-release`, `runner_ref=<version>` |
| Deploy dev and test the selected branch's runner       | `deploy_mode=deploy`, `runner_mode=temporary-build`                          |
| Roll back dev runner to the previous recorded artifact | `deploy_mode=deploy`, `runner_mode=rollback`                                 |

`diff-only` never rolls out a runner.

`auto` is the normal mode. It compares the selected commit with the last
recorded dev app deployment manifest. If runner build inputs did not change, it
skips runner rollout. If runner build inputs changed, it stops before `sst
deploy` and asks the operator to choose `temporary-build` or `existing-release`
explicitly. It never builds or restarts runners implicitly.

## Runner Artifact Model

There are three artifact classes:

| Class               | Storage                        | Lifetime                               | Intended use                                             |
| ------------------- | ------------------------------ | -------------------------------------- | -------------------------------------------------------- |
| Official release    | GitHub Release asset           | Long-lived                             | Stage/prod and durable rollbacks.                        |
| Temporary dev build | Dev deploy-artifacts S3 bucket | Short-lived, default lifecycle 30 days | Dev-only branch validation without publishing a release. |
| Rollout manifest    | Dev deploy-artifacts S3 bucket | Long-lived                             | Current/previous runner deployment record.               |
| App deploy manifest | Dev deploy-artifacts S3 bucket | Long-lived                             | Last deployed dev commit used by `runner_mode=auto`.     |

Temporary builds are versioned as:

```text
<Cargo.toml version>-dev.<commit-sha>
```

Dirty local worktree builds get a `-dirty` suffix. The GitHub Action normally
checks out a clean commit, so dev deploys from Actions should not be dirty.

## What The Workflow Does

1. Checks out the selected branch.
2. Confirms `confirm=dev`.
3. Assumes the dev AWS deploy role.
4. Runs `npx sst diff --stage dev`.
5. In `runner_mode=auto`, checks whether runner build inputs changed since the
   last recorded dev app deployment.
6. Runs `npx sst deploy --stage dev` when `deploy_mode=deploy`.
7. Applies the selected runner mode:
   - `auto`: skips runner if inputs are unchanged; blocks before deploy if
     runner inputs changed.
   - `skip`: no runner changes and no runner drift check.
   - `existing-release`: checks the GitHub Release asset and installs it.
   - `temporary-build`: builds C SDK + daemon + computer-use + runner from the
     selected commit, uploads the tarball to S3, presigns it, and installs it.
   - `rollback`: reads the previous runner manifest and reinstalls that source.
8. Verifies public API health.
9. If `DEV_ADMIN_API_KEY` is configured, verifies the Admin runner overview.
10. Writes the dev app deployment manifest used by the next `auto` run.

Runner rollout uses AWS SSM Run Command. It does not SSH into instances and does
not replace EC2 instances. The runner service is stopped, the binary is replaced,
and the service is started again. `/var/lib/boxlite` is untouched.

## Required GitHub Configuration

Create a GitHub Environment named `dev`.

Required variables:

| Name                            | Purpose                                   |
| ------------------------------- | ----------------------------------------- |
| `BOXLITE_DEV_DEPLOY_ROLE_ARN`   | AWS IAM role assumed by the workflow.     |
| `DEV_STACK_DOMAIN`              | Dev domain, for example `dev.boxlite.ai`. |
| `CLOUDFLARE_DEFAULT_ACCOUNT_ID` | Cloudflare account for SST DNS.           |
| `DEV_OIDC_ISSUER_BASE_URL`      | OIDC issuer URL required by the API.      |

Required secrets:

| Name                   | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | Lets SST manage Cloudflare DNS records. |

Optional variables/secrets:

| Name                                | Purpose                                              |
| ----------------------------------- | ---------------------------------------------------- |
| `DEV_RUNNER_ARTIFACT_BUCKET`        | Override the default deploy-artifacts bucket name.   |
| `DEV_RUNNER_MANIFEST_PREFIX`        | Override the manifest prefix, default `deployments`. |
| `DEV_ADMIN_API_KEY`                 | Enables Admin runner overview verification.          |
| `GHCR_USERNAME`, `GHCR_TOKEN`       | Runner image pull credentials when needed.           |
| `DEV_POSTHOG_*`, `DEV_CLICKHOUSE_*` | Optional runtime integrations.                       |

The default artifact bucket name is:

```text
boxlite-dev-deploy-artifacts-<aws-account-id>-ap-southeast-1
```

SST creates this bucket as part of the dev stack. Temporary runner artifacts are
stored under `runner-temp/`; rollout manifests are stored under
`deployments/dev/runner/`; app deploy manifests are stored under
`deployments/dev/app/`.

## Local Fallback

The same flow can run from a Linux deploy host:

```bash
scripts/deploy/dev-full.sh \
  --deploy-mode deploy \
  --runner-mode skip \
  --stage dev \
  --confirm dev
```

Use GitHub Actions for `temporary-build`. Local temporary builds require Linux
amd64 because the runner uses CGO.

## Safety Boundaries

- This workflow only supports `stage=dev`.
- Runner rollout requires `deploy_mode=deploy`.
- Runner EC2 discovery requires SST-managed tags:
  `App=boxlite`, `Stage=dev`, `Role=runner`.
- Production deploys need a separate workflow with approval and canary rules.
