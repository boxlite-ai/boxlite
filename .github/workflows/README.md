# BoxLite CI/CD Workflows

This directory contains GitHub Actions workflows for building and publishing BoxLite SDKs.

## Workflow Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         config.yml                                   │
│                    (shared configuration)                            │
└─────────────────────────────────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ↓                       ↓                       ↓
┌───────────────┐     ┌─────────────────┐     ┌─────────────────┐
│warm-caches    │     │build-wheels     │     │build-node       │
│               │     │                 │     │                 │
│ Triggers:     │     │ Triggers:       │     │ Triggers:       │
│ - push main   │     │ - release       │     │ - release       │
│ - weekly      │     │ - manual        │     │ - manual        │
│               │     │                 │     │                 │
│ Warms sccache │     │ Uses sccache    │     │ Uses sccache    │
└───────┬───────┘     └─────────────────┘     └─────────────────┘
        │ [completed]
        ↓
┌───────────────┐
│build-runtime  │
│               │
│ Triggers:     │
│ - warm-caches │
│ - release     │
│ - manual      │
│               │
│ Uses sccache  │
└───────────────┘
```

## Key Design: sccache Compilation Caching

All Rust compilation is cached via **sccache** using the GHA cache API:

- Caches individual compilation units (object files) by content hash
- Works on host runners and inside Docker/manylinux containers
- Pre-warmed by `warm-caches.yml` on push to main
- `build-runtime.yml` chains after warm-caches via `workflow_run` for cache hits
- Requires `CARGO_INCREMENTAL=0` (sccache and incremental compilation are incompatible)
- Graceful fallback: if sccache fails to set up, builds proceed without caching

## Workflows

### `config.yml`

Shared configuration loaded by all workflows.

**Outputs:**
- `platforms` - Platform configurations with os and target (`[{"os":"macos-15","target":"darwin-arm64"},{"os":"ubuntu-latest","target":"linux-x64-gnu"}]`)
- `python-versions` - Python versions (`["3.10", "3.11", "3.12", "3.13"]`)
- `node-versions` - Node.js versions (`["18", "20", "22"]`)
- `node-build-version` - Node.js version for building (`"20"`)
- `rust-toolchain` - Rust toolchain version (`"stable"`)
- `artifact-retention-days` - Days to keep artifacts (`7`)

### `build-runtime.yml`

Builds BoxLite runtime, uploads to GitHub Release, and publishes Rust crates to crates.io.

**Triggers:**
- After `Warm Caches` workflow completes on `main` (via `workflow_run`)
- Release published
- Manual dispatch

**What it builds:**
- `boxlite-guest` - VM guest agent
- `boxlite-shim` - Process isolation shim
- `libkrun`, `libkrunfw`, `libgvproxy` - Hypervisor libraries
- `debugfs`, `mke2fs` - Filesystem tools

**Jobs:**
1. `config` - Load shared configuration
2. `build` - Build runtime for each platform (matrix: macOS ARM64, Linux x64)
3. `upload_to_release` - Upload runtime tarballs to GitHub Release (release only)
4. `publish_crates` - Publish Rust crates to crates.io (release only, after upload)

### `build-wheels.yml`

Builds, tests, and publishes Python SDK.

**Triggers:**
- Releases
- Manual dispatch

**Jobs:**
1. `build_wheels` - Builds Python wheels using cibuildwheel
2. `test_wheels` - Tests import on Python 3.10-3.13
3. `publish` - Publishes to PyPI (on release)
4. `upload_to_release` - Uploads wheels to GitHub Release

### `build-node.yml`

Builds, tests, and publishes Node.js SDK.

**Triggers:**
- Releases
- Manual dispatch

**Package structure:**
- `@boxlite-ai/boxlite` - Main package with TypeScript wrappers
- `@boxlite-ai/boxlite-darwin-arm64` - macOS ARM64 native binary
- `@boxlite-ai/boxlite-linux-x64-gnu` - Linux x64 glibc native binary

**Jobs:**
1. `build` - Builds Node.js addon with napi-rs, outputs tarballs
2. `test` - Tests import on Node 18, 20, 22
3. `publish` - Publishes to npm (on release)
4. `upload-to-release` - Uploads tarballs to GitHub Release

### `lint.yml`

Runs code quality checks.

**Triggers:**
- Push to `main`
- Pull requests

**Jobs:**
1. `rustfmt` - Check Rust formatting via `make fmt:check:rust`
2. `clippy` - Run Clippy linter via `make clippy` on all platforms
3. `python` - Run Python lint and format checks via `make lint:python` and `make fmt:check:python`
4. `node` - Run Node lint and format checks via `make lint:node` and `make fmt:check:node`
5. `c` - Run C SDK lint and format checks via `make lint:c` and `make fmt:check:c`

### `codeql.yml`

Runs CodeQL code scanning (advanced setup) across all analyzed languages.

**Why advanced setup:** CodeQL *default setup* does not analyze pull requests
from forks, so the `code_scanning` ruleset rule ("Require code scanning
results") permanently blocks fork PRs. Advanced setup runs on `pull_request`,
so fork PRs in this public repo are scanned and the gate is satisfiable without
an admin bypass.

**Bootstrap guard:** GitHub rejects advanced CodeQL uploads while default setup
is enabled. The workflow is dormant until repository variable
`CODEQL_ADVANCED_SETUP_ENABLED` is set to `true`.

**Triggers:**
- Push to `main`
- Pull requests against `main` (including fork PRs)
- Manual dispatch
- Weekly schedule (Mondays 03:31 UTC)

**Jobs:**
1. `analyze` - Matrix over `actions`, `c-cpp`, `go`, `javascript-typescript`, `python`, `rust`. All use `build-mode: none` (source-only, no compile) except `go`, which requires `autobuild` (Go's extractor must observe a build). Uses `github/codeql-action@v4`.

**Activation sequence:**
1. Merge this workflow while `CODEQL_ADVANCED_SETUP_ENABLED` is unset or `false`, so default setup remains the active scanner.
2. Disable CodeQL default setup.
3. Set repository variable `CODEQL_ADVANCED_SETUP_ENABLED=true`.
4. Trigger a new push, pull request update, or manual dispatch and verify CodeQL analysis uploads successfully.
5. Roll back by setting `CODEQL_ADVANCED_SETUP_ENABLED=false` and re-enabling default setup.

### `e2e-local.yml`

Runs VM-based E2E integration tests on an ephemeral AWS EC2 self-hosted runner.

**Why:** GitHub-hosted runners (including larger paid runners) do not support `/dev/kvm`. BoxLite integration tests need real VMs via libkrun.

**Architecture:** Three-job ephemeral pattern:
1. `start-runner` (ubuntu-latest) — launches an AWS EC2 c8i.2xlarge instance, registers an ephemeral GitHub Actions runner
2. `e2e-tests` (self-hosted) — builds runtime, runs all integration test suites
3. `stop-runner` (ubuntu-latest, `if: always()`) — terminates instance, deregisters runner

**Triggers:**
- Push to `main` (path-filtered to `src/`, `sdks/`, `Cargo.*`)
- Pull request with `e2e-local` label (cost-gated)
- Manual dispatch (`workflow_dispatch`)

**Cost:** ~$0.34/hr (c8i.2xlarge). Typical run: 15-25 min → ~$0.09-0.14 per run.

**Safety mechanisms:**
- `--ephemeral` runner auto-deregisters after one job
- `if: always()` ensures cleanup on failure/cancellation
- 45-minute self-destruct timer on the instance (EC2 self-termination)
- Runner deregistration API call (belt-and-suspenders)
- 35-minute job timeout prevents runaway tests
- `instance-initiated-shutdown-behavior: terminate` auto-cleans on shutdown

**Authentication:** GitHub OIDC → AWS STS (no stored AWS credentials).

**Required secret:**
- `GH_PAT` - GitHub PAT with `repo` scope (for runner registration API)

**Required variables** (Settings → Variables → Actions):
- `AWS_ACCOUNT_ID` - AWS account ID
- `AWS_SUBNET_ID` - Subnet with auto-assign public IP
- `AWS_SECURITY_GROUP_ID` - Security group allowing outbound HTTPS

**Required AWS resources** (provisioned by `scripts/ci/setup-ci-runner.sh`):
- OIDC identity provider (`token.actions.githubusercontent.com`)
- IAM role `boxlite-e2e-github-actions` with trust policy for this repo
- IAM instance profile `boxlite-e2e-runner` with `ec2:TerminateInstances` on self
- Subnet with internet access + security group (outbound 443)

**Jobs:**
1. `should-run` - Gate check (label present on PR?)
2. `start-runner` - Launch EC2 c8i.2xlarge, register runner, wait for online
3. `e2e-tests` - Build runtime, run Rust/CLI/Python/Node/C integration tests
4. `stop-runner` - Terminate instance, deregister runner

### `e2e-cloud.yml`

Runs the SDK → API → Runner → libkrun VM regression suite against the
**always-on Tokyo stack** (`boxlite-e2e-ci-*`) instead of a per-run KVM
runner. Built for fast iteration on REST-path bugs (`e2e-test.yml` is
slower because it spins up a fresh EC2 every run).

**Why:** The same regression goal as `e2e-test.yml`, but the cost
profile is different — `e2e-cloud.yml` deploys-and-tests against an
already-deployed cloud stack, so a typical run is 8-15 min and adds
no per-run EC2 cost. `e2e-test.yml` and this workflow are
complementary, not redundant — they exercise the same test code but
the deployed-stack path also catches infra-only regressions (LB
config, RDS schema, ECS task def drift) that the self-bootstrap
path doesn't.

**Architecture:** Three-job required-gate pattern:
1. `changes` (ubuntu-latest) — paths-filter cheap detector
2. `e2e` (ubuntu-latest, only if `changes` says relevant or `workflow_dispatch`) —
   builds Api image + runner binary from this checkout, deploys to Tokyo,
   builds the Python SDK from source, runs `pytest scripts/test/e2e/cases/`
3. `e2e-gate` (always runs) — collapses outcome into one required check

**Triggers:**
- Push to `main`
- Pull request to `main`
- Manual dispatch (`workflow_dispatch`)

  Path matching happens inside the `changes` job (so branch
  protection can require the gate's status check on every PR).

**Cost:** Build + deploy + test on GitHub-hosted ubuntu-latest (free for
public repos / billable minutes for private). The Tokyo stack itself
runs 24×7 — its baseline is the cost driver, not this workflow.

**Authentication:** GitHub OIDC → AWS STS (no stored AWS credentials),
**separate** IAM role from `e2e-test.yml`:

| Workflow | Role | Region | Scope |
|----------|------|--------|-------|
| `e2e-test.yml` | `boxlite-e2e-github-actions` | us-east-1 | self-hosted runner provisioning (ec2:RunInstances, terminate, register/deregister GH runner) |
| `e2e-cloud.yml` | `boxlite-e2e-cloud-github-actions` | ap-northeast-1 | Tokyo stack deploy + exec (ecr push, ecs update-service / execute-command, ssm send-command to runner, s3 builds/, ssm parameter read) |

**Required variables** (Settings → Variables → Actions):
- `AWS_ACCOUNT_ID` (shared)
- `AWS_E2E_CLOUD_REGION` = `ap-northeast-1`
- `AWS_E2E_CLOUD_ROLE_ARN` = `arn:aws:iam::<acct>:role/boxlite-e2e-cloud-github-actions`

**Required AWS resources** (provisioned by `scripts/ci/setup-e2e-cloud-oidc.sh`):
- OIDC identity provider (`token.actions.githubusercontent.com`) — shared
  with `e2e-test.yml`
- IAM role `boxlite-e2e-cloud-github-actions` with trust policy limited
  to `repo:boxlite-ai/boxlite:{ref:refs/heads/main, pull_request, environment:e2e-cloud}`
- SSM SecureString parameter `/boxlite/e2e-ci/admin-api-key` (sourced
  by the workflow at runtime; never committed)
- Tokyo `boxlite-e2e-ci-*` stack already deployed (SST `e2e-ci` stage)

**Concurrency:** `e2e-cloud-shared` — singleton lock across every PR
and every push. The Tokyo stack is a shared singleton, so per-ref
grouping would let PRs race each other's ECS rolling updates.

**Stack state after a run:** The Tokyo stack is left running THIS
workflow run's Api image + runner binary. There's no auto-restore to
`main` HEAD between runs (cost trade-off). Console / direct stack
inspection therefore reflects "whatever the last e2e-cloud run
deployed" — a `git log --grep e2e-cloud` on `main` and the ECS task
definition's image tag (`api-<sha>`) together identify the running
revision.

## Trigger Behavior

| Change | warm-caches | build-runtime | build-wheels | build-node |
|--------|-------------|---------------|--------------|------------|
| `src/boxlite/**` | ✅ Runs | ✅ Chains after warm-caches | ❌ Skips | ❌ Skips |
| `sdks/python/**` | ❌ Skips | ❌ Skips | ❌ Skips | ❌ Skips |
| `sdks/node/**` | ❌ Skips | ❌ Skips | ❌ Skips | ❌ Skips |
| Release published | ❌ Skips | ✅ Runs directly | ✅ Runs | ✅ Runs |

## Cache Strategy

### Compilation Cache (sccache)

All Rust compilation is cached via sccache using the GHA cache API:

- Caches individual compilation units (object files)
- Works on host runners and inside Docker containers
- Pre-warmed by the `warm-caches.yml` workflow on push to main
- Requires `CARGO_INCREMENTAL=0` (sccache and incremental compilation are incompatible)
- Graceful fallback: if sccache fails to set up, builds proceed without caching

## Platform Matrix

Currently supporting 2 platforms:

| Platform | OS Runner | Target |
|----------|-----------|--------|
| macOS ARM64 | `macos-15` | `darwin-arm64` |
| Linux x64 | `ubuntu-latest` | `linux-x64-gnu` |

Additional platforms (darwin-x64, linux-arm64-gnu) can be added to `config.yml` when needed.

## Time Savings

**Scenario: Only Python SDK changed**

| Without separation | With separation |
|-------------------|-----------------|
| Build runtime: 8 min | ❌ Skipped |
| Build Python: 2 min | ✅ 2 min (cache hit) |
| Build Node: 2 min | ❌ Skipped |
| **Total: 12 min** | **Total: 2 min** |

**Savings: 83% faster**

## Secrets Required

- `CARGO_REGISTRY_TOKEN` - crates.io API token for publishing Rust crates
- `PYPI_API_TOKEN` - PyPI API token for publishing Python wheels
- `NPM_TOKEN` - npm access token for publishing Node.js packages
- `GH_PAT` - GitHub PAT with `repo` scope (for self-hosted runner registration)

Set these in repository Settings → Secrets and variables → Actions.

## Local Development

```bash
# Build runtime once
make runtime

# Build Python SDK (reuses runtime)
make dev:python

# Build Node.js SDK (reuses runtime)
make dev:node
```

## Troubleshooting

**Cache miss when expected hit:**
- sccache caches expire after 7 days of non-use (weekly warm-caches schedule prevents this)
- Branch-based cache isolation may apply
- Check sccache stats in build logs for hit/miss rates

**Build taking too long:**
- Check sccache stats — low hit rate means cache is cold
- Verify warm-caches workflow completed successfully before build-runtime
- Check GHA cache usage (Settings > Actions > Caches) for eviction

**Node.js package install fails:**
- Platform package must be installed before main package
- Check that tarballs were uploaded correctly

## References

- [mozilla-actions/sccache-action](https://github.com/mozilla-actions/sccache-action)
- [cibuildwheel](https://cibuildwheel.readthedocs.io/)
- [napi-rs](https://napi.rs/)
