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

### `deploy-infra.yml`

Previews or deploys the full stack from one commit, on a native AMD64 GitHub
runner, for a `workflow_dispatch`-selected `stage` (an allowlisted `choice`
input, `dev` today). That commit is either already on `main` (current `main` by
default) or the merge of an open pull request with `main`, so a change can reach
a stage before it merges.

The merge commit rather than the head: the workflow definition comes from the
dispatch ref while the deploy job checks out the resolved commit, so a head that
is behind `main` would pair new workflow YAML with old `apps/infra` tooling.
GitHub recomputes that merge whenever `main` or the head moves, so the resolved
SHA is a snapshot rather than a commit in anyone's history.

A fork's PR is accepted: dispatching already requires write access, and the
credential-bearing jobs sit behind the stage Environment's required reviewer.
`build-c`/`build-runner` are the exception — neither declares an `environment:`,
so a fork's build code runs on a hosted runner with no second look; the risk
there is compute abuse and build-time tampering, not credential theft.

Each component is built by its own job, and the two legs share only
`resolve-ref`, so they run side by side: the reusable C/Runner workflows produce
a Linux AMD64 Runner with `<workspace-version>+<sha>` identity and stage it in
the stage's private commit-keyed S3 path, while `build-api` calls
`build-apps-api-image.yml` for the same commit and pushes
`boxlite-app-<stage>-api:v<version>-<sha>`. The deploy itself compiles neither.
Deployment safety tests first enforce the Runner lifecycle options. Dispatch defaults to
preview-only; `apply=true` repeats the full structured preview and deploys only
when the Runner safety gate accepts the
plan. Routine control-plane deployment rejects every Runner create, delete,
replacement, or protected-property change; the routine workflow does not
provision Runners. The job rejects `--target` deploys outright — a targeted
update omits the shared and provider resources it still depends on, which is
how a `--target Api` dispatch stalled this stack on `StorageBucket`
mid-provider-migration — and accepts `--exclude` only for the two scopes the
`components` input can produce. It is serialized, uses the
selected stage's protected GitHub Environment, and authenticates to AWS with
short-lived OIDC credentials. Docker runs entirely in CI; no developer machine
or public SSH builder participates.

`components` (`api+runner`, `api`, `runner`) narrows a dispatch to one
deployable leg: the other leg's build jobs are skipped and its mutable half — the
service or instance, and the binary-upgrade commands — leaves the plan, so an
Api-only change need not rebuild the Runner. Its ref-independent scaffolding
(IAM role, instance profile, security group) still reconciles as a no-op. The
exclusion covers `sst.config.ts` as well as the SST command line — the
`UpgradeRunnerBinary-*` commands are siblings of the Runner instance rather
than children, so `--exclude Runner` alone would leave them firing against an
artifact the skipped build never published. `apps/infra/deployment/capabilities.json`
is the allowlist for both halves. A narrowed deploy leaves the excluded leg on
whatever commit an earlier run put there, so the stack is then mixed-commit.

The `stage` and `components` inputs are allowlists rather than free text: a
required-reviewers Environment cannot be targeted by an unbootstrapped or
misspelled name, and a deploy scope is picked from reviewed shapes rather than
composed on the spot. Every workflow that binds `environment:` to an input follows
this rule, and each list is independent — it names the stages *that* path is
meant to reach. Today the commit-build path (`deploy-infra.yml`) lists `dev`,
while the release path (`deploy-release.yml`, and `build-apps-api-image.yml`'s
`stage` and `source_stage`) lists `dev` and `prod`. Bootstrapping a stage means
adding it to whichever of those lists should reach it.

### `build-apps-api-image.yml` / `deploy-release.yml`

`build-apps-api-image.yml` has three operations, all writing immutable tags into
`boxlite-app-<stage>-api`:

| Operation | Entry point                | Checks out    | Tag                  | Target        |
| --------- | -------------------------- | ------------- | -------------------- | ------------- |
| `commit`  | `workflow_call` only       | the given SHA | `v<version>-<sha>`   | caller's stage |
| `build`   | dispatch                   | `v<version>`  | `<version>`          | `dev` only    |
| `promote` | dispatch                   | nothing       | `<version>`          | another stage |

`commit` is how `deploy-infra.yml` builds the API for the commit it deploys; the
`ref` input is call-only, so no dispatch can tag an image for a commit the
deployable-commit guard never saw. The two tag shapes cannot collide, which matters
because the repository is `IMMUTABLE` and a collision would be unrepairable.
`promote` copies an exact manifest registry-side, addressed by digest, and
verifies the digest survived; it never rebuilds. The dispatched operations run
from `main`, because a release event runs on a tag ref that the branch-scoped
deployment Environments block before the job can obtain AWS credentials.

`deploy-release.yml` accepts one stable `X.Y.Z` for both that API image and the
matching Runner GitHub Release assets, verifies both before SST runs, and
compiles neither component.

Required Environment configuration (per stage):

- Variable `AWS_DEPLOY_ROLE_ARN`
- Variable `AWS_REGION` (defaults to `ap-southeast-1`)
- Secret `DEPLOY_ENV` containing the stage's dotenv configuration

Bootstrap the scoped role, runtime permissions boundary, immutable API ECR
repository, and private Runner artifact bucket with
`apps/infra/bootstrap/aws/github-deploy-role.yaml`. Redeploy that CloudFormation stack when
its policy/resources change, then require reviewers before enabling deployments.

### `e2e-local.yml`

Runs VM-based integration tests on a persistent, self-hosted AWS EC2 runner — GitHub-hosted
runners can't expose `/dev/kvm`, which BoxLite's libkrun microVMs need. The instance is
started before a run and stopped (not terminated) after, so caches persist. AWS auth is
GitHub OIDC → STS; runner registration is a GitHub App. A pull request must carry the
`e2e-local` label (the cost gate) to run; fork PRs run via `pull_request_target` and only
the labeled head commit — re-label after new pushes.

See the **[E2E Local CI runbook](../../docs/ci/e2e-local.md)** for the jobs, the instance,
one-time provisioning (`scripts/ci/setup-ci-runner.sh`), and troubleshooting.

### `build-box-images.yml` / `release-box-images.yml`

The box images in `apps/box-images/` (`base`, `python`, `node`) carry their own `VERSION`,
independent of the product version, so build and release are split:

- **`build-box-images.yml`** validates. On PRs and `main` it builds all three flavors for
  `linux/amd64` and `linux/arm64` with `PUSH=0`, which exercises every layer without
  publishing. It holds `contents: read` only and has no registry login, so it cannot write
  to GHCR.
- **`release-box-images.yml`** publishes, and is the only workflow that can. It runs on an
  `apps/box-images/vMAJOR.MINOR.PATCH` tag — the same path-prefixed convention as the
  `sdks/go/v*` tags — or on manual dispatch, and only from a release tag or `main`. The tag
  must agree with `apps/box-images/VERSION`, and publishing aborts if that version already
  exists on GHCR unless dispatched with `allow-overwrite`, so a rebuild cannot silently move
  the tag a running box pulls. The existence check reads the registry API and branches on the
  HTTP status: only a 404 counts as free, so a 5xx or an expired token stops the release
  instead of reading as "not published".

Releasing is therefore an explicit tag; merging to `main` does not publish.

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
- `GH_APP_PRIVATE_KEY` - GitHub App private key for self-hosted E2E runner registration (see the [E2E Local CI runbook](../../docs/ci/e2e-local.md))

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
