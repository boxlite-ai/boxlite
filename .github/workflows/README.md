## TL;DR

Use this index to find CI checks, artifact publication and deployment workflows, with infrastructure procedures linked to their runbook.

# CI/CD workflows

Every GitHub Actions workflow in the repository: the pull-request checks, the SDK build and
publish chain, the cloud deploy path, the local and cloud end-to-end suites, and the box images.

Shared step bundles live one directory over, in [`.github/actions/`](../actions) — GitHub does not
support subdirectories under `.github/workflows/`, so composite actions are where reuse goes.

## How they fit together

```text
PULL REQUEST / PUSH                     lint · test · codeql · api-client-drift
                                        e2e-local · build-box-images

BUILD + CACHE (weekly)                  build-runtime

RELEASE CHAIN (workflow_run)            build-c ──▶ build-go
                                                └──▶ build-runner-binary

RELEASE (release event)                 build-runtime · build-c · build-node · build-wheels
                                        apps/box-images/v* tag ──▶ release-box-images

LEGACY AWS (manual dispatch)            deploy-infra ─┬─▶ build-apps-api-image
                                                      ├─▶ build-c ──▶ build-runner-binary
                                                      └─▶ e2e-cloud
                                        deploy-release   (no builds; consumes published artifacts)
DEPLOY (manual dispatch)                mdeploy-all ─┬─▶ mbuild         (a commit or #<n> ──▶ <sha> images, dev)
                                                     └─▶ mbuild-release (v<X.Y.Z> ──▶ v<X.Y.Z>-<sha>, dev then prod)

CONFIG                                  ci-config action ◀── lint, test, config workflow
                                        config workflow ◀── build workflows
```

## Workflows

**Callable** marks a workflow another one can invoke with `uses:`. `config.yml` and `mbuild.yml` are
the two that are *exclusively* callable; workflows with `workflow_dispatch` can also run on their
own.

| Workflow | Triggers | Callable | Purpose |
| --- | --- | --- | --- |
| `config.yml` | `workflow_call` | call-only | Loads `.github/ci-config.json` before build matrices expand |
| `lint.yml` | push, PR, merge_group | — | Format and lint per language, plus the installer smoke test. `Lint (conclusion)` is the required check |
| `test.yml` | push, PR, merge_group, weekly, dispatch | — | Lightweight draft checks; SDK tests and combined Rust/CLI coverage on ready PRs. Compact routine matrices and full weekly/manual matrices. Codecov requires 90% patch coverage |
| `codeql.yml` | push, PR, dispatch, weekly | — | CodeQL advanced setup, so fork PRs are scanned |
| `api-client-drift.yml` | PR | — | Fails if the committed generated clients no longer match their specs |
| `author-review.yml` | PR (target), issue_comment, merge_group | — | Converts unacknowledged PRs to draft, posts author instructions, and publishes `Author reviewed the PR` on the current head. Merge queues carry forward the required PR admission check |
| `build-runtime.yml` | weekly, release, dispatch | — | Builds runtime/CLI artifacts and populates sccache together; publishes crates on release |
| `build-c.yml` | release, dispatch, `workflow_call` | yes | C SDK archives |
| `build-go.yml` | `workflow_run`, dispatch | — | Tests the released C archive and tags the Go module; automatic builds follow successful C SDK releases |
| `build-node.yml` | release, dispatch | — | Node.js SDK, napi-rs addon and platform packages |
| `build-wheels.yml` | release, dispatch | — | Builds Python wheels and verifies their native extension in cibuildwheel before publishing |
| `build-runner-binary.yml` | `workflow_run`, dispatch, `workflow_call` | yes | Linux amd64 runner binary; automatic builds follow successful C SDK releases |
| `build-apps-api-image.yml` | dispatch, `workflow_call` | yes | The `apps/api` image: build a commit, build a release, or promote one between stages. Retained legacy AWS path |
| `deploy-infra.yml` | dispatch | — | Builds and deploys one commit to a stage. Retained legacy AWS path |
| `deploy-release.yml` | dispatch | — | Deploys already-published artifacts for one `X.Y.Z`. Compiles nothing. Retained legacy AWS path |
| `e2e-cloud.yml` | dispatch, `workflow_call` | yes | End-to-end against a deployed stage. Run by `deploy-infra` after it applies |
| `mdeploy-all.yml` | dispatch | — | Current mdeploy orchestration for prepared GCP/AWS stages. A commit SHA builds for dev, and so does `#<number>` — a pull request, by the commit it would merge to; a release tag publishes into dev or promotes to prod, and is all prod accepts. Applies the stack itself |
| `mbuild.yml` | `workflow_call` | call-only | The commit line's images, for a dev rollout. Callee only: nobody publishes a commit by hand |
| `mbuild-release.yml` | dispatch, `workflow_call` | yes | The release line's images, tagged `v<X.Y.Z>-<sha>`: publish a version into dev, or promote it to prod. One job per artifact, and a version the target already holds is refused rather than skipped |
| `e2e-local.yml` | push, `pull_request_target`, dispatch | — | VM-based tests on a self-hosted EC2 runner. Needs `/dev/kvm`; PRs need the `e2e-local` label |
| `build-box-images.yml` | PR, push, dispatch | — | Builds changed flavors for both arches; shared inputs and manual runs build every flavor |
| `release-box-images.yml` | `apps/box-images/v*` tag, dispatch | — | The only workflow that writes to GHCR |

Longer treatments live with their subject rather than here: [E2E local
runbook](../../docs/contributing/development/e2e-local.md), [deployment](../../apps/infra/docs/deployment.md).

## Routine checks

`lint` and `test` always report their required conclusion on PRs and merge groups. A newer PR
commit cancels its superseded lint, test and client-drift runs. Release and deployment jobs keep
their existing sequencing.

Draft PRs defer the Rust, Python, Node and Go SDK coverage matrices, including Go
vet and golangci-lint, which reuse the Go job's native build. The Lint and Format
workflow (including Go formatting), CodeQL, managed Code Quality, API tests and
setup checks retain their existing selection. Workflow and infrastructure changes
run `make test:apps:infra` in a separate, path-filtered job whose failures block
`Test (conclusion)`.
Marking a PR **Ready for review** triggers the SDK matrix and both Go analyzers
without requiring another commit. When a user returns it to draft, the new run
cancels the prior Test run and runs the lightweight selection. The author-review bot uses `GITHUB_TOKEN`;
[GitHub suppresses that token's draft-conversion event](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow),
so automatic conversion cannot cancel an already-running matrix. Main pushes,
merge groups, weekly runs and manual dispatches retain SDK testing.
Deferred coverage may remain pending on a draft; it is never replaced by
an empty upload when coverage-bearing files changed.

Python runs all four supported versions on Linux x64 and the latest on macOS and Linux ARM
(six jobs); Node runs all three versions on Linux x64 and the latest on the other platforms
(five jobs). Weekly and manually dispatched tests exercise every platform/version combination
and bypass change filters. Combined Rust and CLI coverage runs on all three platforms, including
non-VM integration tests and Linux guest tests. Codecov requires 90% coverage of changed lines
and reports total coverage.

When none of the coverage suites is selected on a PR or merge group, the
`Codecov (no coverage changes)` job runs a validated `empty-upload`. Codecov
checks the changed files before publishing a passing or failing status; the
workflow never forces a pass. Failed file detection cannot select this path,
and upload errors fail `Test (conclusion)`. Source changes still need reports
and 90% patch coverage; missing reports fail the patch status.

After verifying normal uploads and the skipped-coverage path on PRs and merge
groups, require `codecov/patch` from the Codecov app in the main ruleset alongside
`Test (conclusion)`. Deploy the workflow before enabling that requirement so
existing documentation-only PRs do not wait for a status they cannot publish.

Go vet and golangci-lint run after Linux x64 Go coverage, reusing its native SDK build.
Go module-download caches hash the repository's nested `go.mod` and `go.sum` files;
there is no root `go.sum`, and the SDK needs its `go.mod` included even without a
checksum file. The Go build cache is not restored because it cannot detect changes
to externally linked CGO libraries such as `libboxlite.a`.
Formatting-only jobs disable module caching. Go test jobs initialize
submodules before Rust cache setup and retain build state for both the root Cargo
workspace and vendored libkrun. They retain workspace compilation outputs, while
still invoking `make coverage:go` to rebuild changed code and current Git metadata.
Finished native libraries are not reused without Cargo's freshness checks.
The Go lint job retains formatting checks. SDK and API test filters exclude Markdown and select
the Make recipes they execute; the changes job still parses every Make include with `make -n help`.
Client drift and VM E2E triggers also exclude Markdown-only changes.

Client drift checks watch API code, shared libraries, generators and workspace configuration.
Guest artifact qualification runs only weekly or when manually dispatched, retaining all five
platform/profile combinations. PR, push, and merge-queue runs skip that job; use
`make test:guest-artifacts` to check guest build changes locally before merging. Infrastructure
tests run in hosted CI for infrastructure, workflow and relevant Make changes, including drafts,
and remain available through `make test:apps:infra` and the local pre-push check;
`make test:apps:infra-config` explicitly installs and type-checks the SST configuration.

## Author review gate rollout

Require the commit status `Author reviewed the PR` from GitHub Actions on the target
branch after this workflow is deployed. The handler job `Update author review status`
only reports whether event processing succeeded; it is not the acknowledgment.

Post `/recheck-author-review` as a PR comment to initialize existing PRs or retry a failed
handler. Any new non-bot PR comment rechecks live state without acknowledging the diff.
Comment events run the default-branch workflow; rechecks cannot select a modified branch
workflow. Bot instruction edits and deletions are reconciled too.
The bot comment includes the exact command the author must post. No fork branch writes,
extra GitHub App, or personal token are needed. The workflow runs only the immutable
upstream revision in `AGENT_TOOLING_REV`; update that pin through a reviewed PR.

Draft conversion requires `contents: write` as well as `pull-requests: write`;
`statuses: write` publishes the acknowledgment. The contents permission authorizes
the GraphQL mutation; the workflow does not push commits or write to fork branches.

Merge queues must require the same PR status before admission. Queue commits carry
that result forward; authors acknowledge their own PR head, not the temporary merge.
Unacknowledged PRs are converted to draft. After the author acknowledgment passes,
click **Ready for review** when reviews are wanted; acknowledgment preserves the draft
state. A new commit or editing/deleting the only acknowledgment returns the PR to draft.

## Composite actions

In [`.github/actions/`](../actions). Each replaces a step bundle that was previously copied into
every consumer.

| Action | Sites | Used by |
| --- | --- | --- |
| `ci-config` | 3 | config, lint, test |
| `setup-rust` | 10 | build-c, build-node, build-runtime ×2, build-wheels, lint ×2, test ×3 |
| `sccache` | 6 | build-c, build-node, build-runtime, build-wheels, lint, test |
| `build-guest` | 4 | build-c, build-node, build-runtime, build-wheels |
| `upload-to-release` | 5 | build-c, build-node, build-runner-binary, build-runtime, build-wheels |
| `run-in-manylinux` | 3 | build-c, build-node, build-runtime |
| `setup-go` | 4 | build-go, build-runner-binary, lint, test |
| `setup-python` | 3 | lint, test ×2 |
| `setup-buildx` | 2 | build-box-images, release-box-images |

Two ordering rules, stated in each action's own header: `sccache` runs after `setup-rust`, and
`build-guest` and `run-in-manylinux` run after both. They are separate actions rather than one
because sccache is job-scoped — `run-in-manylinux` mounts the sccache binary and reads the
variables `sccache` exported, long after `build-guest` is done with them.

A `uses: ./...` action is resolved from the **checked-out tree**, not from the ref that defines the
workflow. Jobs that check out a caller-selected commit — `build-c` and `build-runner-binary`, when
`deploy-infra` drives them — therefore need `.github/actions/` to exist in *that* commit. A commit
predating these directories fails with `Can't find 'action.yml'`; select a newer one.

## sccache

Jobs invoking [the sccache action](../actions/sccache/action.yml) use sccache 0.17.0 with a
1 GiB local compiler cache, restored and saved as one GitHub Actions archive per job. This
replaces per-compilation remote writes, which were failing across native builds. Restore keys
prefer the same workflow/job and lockfiles, then fall back to the same runner OS/architecture.
Each successful run saves a new snapshot; compiler content hashes still decide whether entries
are reusable. The lockfile hash is captured before compilation, so saving the archive does not
scan private lockfiles created by root containers. A cold cache still requires a full build.

- The action sets `SCCACHE_GHA_ENABLED=false`, `RUSTC_WRAPPER=sccache` and
  `CARGO_INCREMENTAL=0`. Direct preprocessing mode is disabled when reusing archives.
- Host and Linux containers share `$RUNNER_TEMP/sccache` (mounted at `/cache/sccache` in
  manylinux). It stays outside the checkout so cibuildwheel does not copy a large cache with
  the sources. Only one server may use it at a time:
  the host stops before the container starts, and the container flushes its cache before exiting.
  Root-owned container entries return to the runner user before the archive is saved.
- `SCCACHE_BASEDIRS` normalizes source paths: the workspace on the host, `/work` in
  manylinux, and `/project` in cibuildwheel. Different compilers or build flags still produce
  different cache keys.
- cibuildwheel copies the host action's verified binary and accesses its cache through the
  `/host` mount. Standalone builds use an existing binary or PyPI's published 0.16.0 package.
  Its absolute wrapper survives Python-specific PATH changes. A local wheel
  build without a host directory uses a temporary cache inside the container.
- Host setup exports the wrapper only after the server starts. Ordinary jobs warn and compile
  uncached on setup failure; scheduled runtime builds require successful setup. Containers drop
  a missing wrapper (manylinux) or install a pass-through shim (cibuildwheel). A server failure
  inside a container can still fail that build. Host diagnostics go to
  `$RUNNER_TEMP/sccache-error.log`; post steps print statistics before archiving.
- Rust coverage and guest qualification use the target-directory cache provided by
  `setup-rust-toolchain`, rather than this sccache action.
- Linux runtime, C, Node and wheel distribution jobs disable that separate Cargo cache:
  guest staging discards the host toolchain and target directory before container builds.
  Their shared compiler cache remains enabled. macOS and other jobs retain Cargo caching.

Runtime, C, Node and wheel release builds can reuse compiler snapshots for their platform.
They still assemble their own SDK artifacts and perform cold builds when no compatible entry
exists. Runtime distribution builds run weekly, manually and on releases; routine tests and
Clippy continue checking platform-specific code.

## Box image cache

Both box-image workflows export Buildx runtime cache credentials through `setup-buildx`.
`apps/box-images/build.sh` imports and exports a separate GitHub Actions layer cache for each
image flavor. Export failures are tolerated and bounded to three minutes. Local builds without
GitHub credentials do not use the remote cache.

## CodeQL

`codeql.yml` uses CodeQL **advanced** setup rather than default setup, because default setup does
not analyze pull requests from forks — which makes the `code_scanning` ruleset rule ("Require code
scanning results") permanently block fork PRs. Advanced setup runs on `pull_request`, so fork PRs
in this public repo are scanned and the gate is satisfiable without an admin bypass.

Markdown-only pushes and PRs skip CodeQL; any code change retains the full language matrix.
Weekly and manual scans remain unfiltered. The required security ruleset stays in place;
GitHub's separate managed Code Quality analysis is unchanged.

The `analyze` job is a matrix over `actions`, `c-cpp`, `go`, `javascript-typescript`, `python` and
`rust`. All use `build-mode: none` (source only, no compile) except `go`, whose extractor has to
observe a real build and therefore uses `autobuild`.

## Do not rename these

Two workflows chain off another's **display name**, not its filename. Changing the `name:` below
silently stops the chain — no error, the downstream workflow simply never fires.

| `name:` | Depended on by |
| --- | --- |
| `Build C SDK` | `build-go.yml`, `build-runner-binary.yml` |

## Adding a stage

Define the stage in `.mstage.config.json`, bootstrap its intended cloud/path, and publish its declaration
with `npm run mstage config put -- --stage <stage>`. The GitHub Environment name must match the stage.

Manual workflow choices are allowlists: mdeploy-all currently exposes `dev` and `prod`, with distinct
commit/release policies. A new stage requires reviewing dispatch choices, ref-resolution/promotion
policy and the associated workflow tests, including `apps/infra/deployment/release-safety.test.ts`.
Declaring a stage locally does not make every workflow accept it.

Promotion needs both source and destination declarations. The source job reads its own Environment
and carries the declaration to the destination job; setup-infra restores the needed blocks.
Verify live reviewers and cloud federation trust after bootstrap. For retained legacy workflows,
review their independent `stage`/`source_stage` choices and capability checks as well.

## Deploy configuration

The current [deployment runbook](../../apps/infra/docs/deployment.md) owns setup and apply instructions.
Stage declarations travel through `BOXLITE_MSTAGE_BOXLITE_APP_CONFIG` on the matching GitHub Environment;
[setup-infra](../actions/setup-infra/action.yml) restores the ignored `.mstage.config.json` for each job.

| Cloud/path | GitHub inputs established by bootstrap |
| --- | --- |
| GCP | `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOYER`, `GCP_IMAGE_PUBLISHER` Environment variables |
| AWS | `AWS_ACCOUNT_ID`, `AWS_REGION` Environment variables for federated credentials |
| Legacy AWS wrapper | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_DEFAULT_ACCOUNT_ID` Environment secrets |

mdeploy reads application values from the encrypted stage store through mstage. The retained legacy
AWS wrapper uses its SST manifest and bootstrap credential copies. AWS bootstrap still prepares
legacy `boxlite` resources while mdeploy names `boxlite-app`; read the
[compatibility boundary](../../apps/infra/bootstrap/aws/README.md#aws-mdeploy-compatibility) before switching.

[Configuration](../../apps/infra/docs/configuration.md) explains groups, digests and secret handling;
[security](../../apps/infra/docs/security.md) distinguishes workflow gates from live IAM and Environment settings.

## Publishing secrets

Repository secrets, in Settings → Secrets and variables → Actions:

- `CARGO_REGISTRY_TOKEN` — crates.io, for the Rust crates
- `PYPI_API_TOKEN` — PyPI, for the wheels
- `NPM_TOKEN` — npm, for the Node packages
- `GH_APP_PRIVATE_KEY` — GitHub App key that registers the self-hosted E2E runner
