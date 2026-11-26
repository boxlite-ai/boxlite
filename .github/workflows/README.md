## TL;DR

Use this index to find CI checks, artifact publication and deployment workflows, with infrastructure procedures linked to their runbook.

# CI/CD workflows

Every GitHub Actions workflow in the repository: the pull-request checks, the SDK build and
publish chain, the cloud deploy path, the local and cloud end-to-end suites, and the box images.

Shared step bundles live one directory over, in [`.github/actions/`](../actions) — GitHub does not
support subdirectories under `.github/workflows/`, so composite actions are where reuse goes.

## Runner placement

Eligible Ubuntu x64 jobs use ephemeral workers through the
[BoxLite CI connection](../../apps/github-ci-runner/README.md).
The connection needs permission to register workers and quota for the requested
[resources](../../apps/libs/ci-listener/README.md#resource-labels).

| Runner label | Jobs |
| --- | --- |
| `boxlite` | Lightweight lint and setup, Python and Node SDK unit tests, Actions and Python CodeQL, plugin package validation, Go SDK release configuration, status and selected release artifact uploads |
| `boxlite-2vcpu-4gbmem-30gbdisk` | C/C++ CodeQL, API client drift and Secret Server PostgreSQL integration |
| `boxlite-2vcpu-8gbmem-30gbdisk` | Dashboard tests |
| `boxlite-4vcpu-8gbmem-30gbdisk` | Go CodeQL autobuild |
| `boxlite-4vcpu-16gbmem-30gbdisk` | Go SDK release checks, Node SDK release tests and Node release packaging |
| `boxlite-4vcpu-16gbmem-64gbdisk` | JavaScript/TypeScript and Rust CodeQL, Clippy, REST volume lifecycle E2E, Nix CLI build and boot, standard Linux x64 C SDK archives, standalone guest artifacts and the non-publishing multiarch Box image build |
| GitHub-hosted Ubuntu | API tests, Go SDK coverage, Node, Python and runtime native packaging, Rust coverage, selected-ref C SDK builds, protected publishing and runner recovery |

The Node release upload builds and packs the npm packages before attaching them.
Uploads of prepared C SDK archives, runtime archives and Python wheels use the default worker.

The C SDK workflow installs the BoxLite worker toolchain before source checkout.
A caller-selected commit or an x64-only recovery build runs on GitHub-hosted Ubuntu.
Linux ARM64 and macOS matrix jobs use their native platforms. Building an ARM64
container image with Buildx exercises a different path from native ARM64 SDK tests.

GitHub starts PostgreSQL and Redis services before checkout. The runner must
provide a working Docker daemon at registration time. Dashboard tests and
API client drift install Node 22 before enabling Corepack for the Yarn cache.
On cold installs, API client drift limits Yarn to four concurrent downloads on its 4 GiB worker.
Dashboard allows eight concurrent downloads on its 8 GiB worker.
[Docker startup contract](../../apps/libs/ci-listener/README.md#docker-startup).

Rust coverage exercises unprivileged user namespaces on hosted Ubuntu.
The Nix and REST jobs verify unprivileged namespaces on BoxLite before booting an Alpine box or starting the REST server.
The BoxLite guest can run the SSH suite under its default namespace policy.
AppArmor enforcement requires a guest kernel with the AppArmor interface.

The local E2E workflow uses its GCP runner pool for persistent caches and VM
lifecycle. Deployment recovery uses GitHub-hosted runners. npm publishing uses
GitHub-hosted capacity for its
[provenance requirement](https://docs.npmjs.com/generating-provenance-statements/).

## How they fit together

```text
PULL REQUEST / PUSH                     lint · test · codeql · api-client-drift
                                        e2e-local · build-box-images
RELEASE VERSION PULL REQUEST            release-dependency-audit (title-selected)

BUILD + CACHE (weekly)                  build-runtime

RELEASE CHAIN (workflow_run)            build-c ──▶ build-go
                                                └──▶ build-runner-binary

SDK TEST BUILDS (manual dispatch)       build-go ──▶ build-c ──▶ Go SDK tests
                                        build-runner-binary ──▶ build-c ──▶ Runner link

RELEASE (release event)                 build-runtime · build-c · build-node · build-wheels
                                        mbuild-release-on-release ──▶ mbuild-release
                                          GHCR images + required release assets ready
                                            ──▶ mdeploy-all (dev) ──▶ e2e-cloud (dev, release tag)
                                            ──▶ mdeploy-all (prod, awaiting approval) ──▶ Slack report
                                        apps/box-images/v* tag ──▶ release-box-images

LEGACY AWS (manual dispatch)            deploy-infra ─┬─▶ build-apps-api-image
                                                      ├─▶ build-c ──▶ build-runner-binary
                                                      └─▶ e2e-cloud
                                        deploy-release   (no builds; consumes published artifacts)
DEPLOY (manual dispatch)                mdeploy-all ─┬─▶ parallel plan/build legs (SHA/PR ──▶ dev/stage; stable tag as commit ──▶ stage)
                                                     └─▶ GHCR import    (release tag ──▶ dev/prod AR/ECR, no build)

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
| `release-dependency-audit.yml` | PR, merge_group | — | Audits production application dependencies on release version PRs selected by title; other PRs and merge groups skip the job |
| `codeql.yml` | push, PR, dispatch, weekly | — | CodeQL advanced setup, so fork PRs are scanned |
| `api-client-drift.yml` | PR | — | Fails if the committed generated clients no longer match their specs. It regenerates through the `generate:api-client` targets, `apps/hack` post-steps included, so regenerate with those targets rather than the bare generator |
| `author-review.yml` | PR (target), issue_comment, merge_group | — | Converts unacknowledged PRs to draft, posts author instructions, and publishes `Author reviewed the PR` on the current head. Merge queues carry forward the required PR admission check |
| `build-runtime.yml` | weekly, release, dispatch | — | Builds runtime/CLI artifacts and populates sccache together; publishes crates on release |
| `build-c.yml` | release, dispatch, `workflow_call` | yes | C SDK archives |
| `build-go.yml` | `workflow_run`, dispatch | — | Pins release tests and the Go tag to the C build commit. Compares public archives with that run before testing. Manual tests build their own C archive. |
| `build-node.yml` | release, dispatch | — | Node.js SDK, napi-rs addon and platform packages |
| `build-wheels.yml` | release, dispatch | — | Builds Python wheels and verifies their native extension in cibuildwheel before publishing |
| `build-runner-binary.yml` | `workflow_run`, dispatch, `workflow_call` | yes | Linux amd64 runner binary; manual builds first produce the selected commit's C archive |
| `build-apps-api-image.yml` | dispatch, `workflow_call` | yes | The `apps/api` image: build a commit, build a release, or promote one between stages. Retained legacy AWS path |
| `deploy-infra.yml` | dispatch | — | Builds and deploys one commit to a stage. Retained legacy AWS path |
| `deploy-release.yml` | dispatch | — | Deploys already-published artifacts for one `X.Y.Z`. Compiles nothing. Retained legacy AWS path |
| `e2e-cloud.yml` | dispatch, `workflow_call` | yes | End-to-end against a deployed stage: main suite, identity and isolated catalog lanes on `dev`/`stage`, `-m smoke` on `prod`. Run by `deploy-infra` after it applies, or dispatched with a `stage` |
| `mdeploy-all.yml` | dispatch | — | Dev/stage accept SHA/PR; stage treats stable tags as commit references. Dev/prod release dispatches run from main and import existing GHCR images into the target cloud registry |
| `mbuild.yml` | `workflow_call` | call-only | Reusable wrapper for the shared stage-image action; mdeploy-all invokes it in its image preparation leg |
| `mbuild-release.yml` | dispatch | — | Publishes GHCR images, waits for required release assets, dispatches dev deployment/E2E, creates a prod approval request, and reports to Slack; `build-only=true` selects publication only |
| `mbuild-release-on-release.yml` | release | — | A stable published release dispatches `mbuild-release` from `main` using its default full pipeline |
| `e2e-local.yml` | push, `pull_request_target`, dispatch | — | VM-based tests on a self-hosted GCP VM runner. Needs `/dev/kvm`; PRs need the `e2e-local` label |
| `build-box-images.yml` | PR, push, dispatch | — | Builds changed flavors for both arches; shared inputs and manual runs build every flavor |
| `release-box-images.yml` | `apps/box-images/v*` tag, dispatch | — | Publishes the curated box image flavors to GHCR |

Longer treatments live with their subject rather than here: [E2E local
runbook](../../docs/contributing/development/e2e-local.md), [deployment](../../apps/infra/docs/deployment.md).

The [release runbook](../../apps/infra/docs/release.md) documents fixed child inputs, timeouts, and recovery.

Full releases require reviewers on the `prod` Environment. A full release can send #release a dev approval link before polling, then the E2E result and prod approval link.

Deployment applies can also notify #dev_deployment for dev or #release for prod before each approval batch. Each button opens the corresponding GitHub run.

Release deployments need one target Environment approval; commit deployments use two batches: parallel artifact preparation, then deploy.
Wait until both preparation legs are awaiting review before approving their shared Environment; queued or later jobs can require another review.

Cloud E2E accepts an optional release-client `tag`; see the
[suite guide](../../apps/e2e/README.md) for downloaded clients and remaining dev driver builds.
Cloud dev E2E also requires the three-profile [identity configuration](../../apps/e2e/README.md#the-cloud-legs-ci).
Its separate identity step verifies cross-organization isolation and same-organization
read-only access; missing or mis-scoped credentials fail setup. The catalog lane uses
p2's independent image quota and requires image read/delete scopes on its key.
Prod keeps its single-key smoke suite.
The p1 dev suite reads `BOXLITE_E2E_DOMAIN` from repository Actions Variables
for [subdomain acceptance](../../apps/e2e/README.md#subdomain-acceptance).

## Routine checks

`lint` and `test` always report their required conclusion on PRs and merge groups. A newer PR
commit cancels its superseded lint, test and client-drift runs. Release and deployment jobs keep
their existing sequencing.

Joining a [native GitHub stack](https://docs.github.com/en/pull-requests/tutorials/roll-out-stacked-prs#5-update-your-programmatic-tooling)
emits `pull_request.stacked`, which starts Test with the existing suite and draft filters.
GitHub evaluates native stack PRs against the stack's trunk, so `branches: [main]`
covers upper layers when the trunk is `main`; every layer needs `Test (conclusion)`.
Adding the trigger does not retroactively start missing runs for PRs already in a stack.

Draft PRs defer the Rust, Python, Node and Go SDK coverage matrices, including Go
vet and golangci-lint, which reuse the Go job's native build. The Lint and Format
workflow (including Go formatting), CodeQL, managed Code Quality, API tests and
setup checks retain their existing selection. Workflow and infrastructure changes
run `make coverage:infra` in a separate, path-filtered job whose failures block
`Test (conclusion)`. It preserves tooling typechecks and all infrastructure suites, collects
TypeScript source coverage with c8, and uploads `target/coverage/infra/lcov.info` using OIDC
under the `infra` flag. These changes cannot select the empty-upload path.
The `nix` job builds the CLI in the flake dev shell, with the runner's
environment and Rust homes dropped, and boots `alpine:latest`. It runs when the
flake or an input of `make cli` changes (Make recipes, build scripts,
`src/deps/`, `build.rs`, Cargo manifests, the toolchain), or on manual
dispatch; not weekly, because `flake.lock` pins its inputs. It is not yet in
`Test (conclusion)`, so its failures show on the PR without blocking merge; it
becomes required once it has proven stable. It compiles through sccache but
does not cache `/nix/store`. Ubuntu still has `/usr/lib`, so it misses
regressions that break only on NixOS.
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
non-VM integration tests and Linux guest tests. Linux CI also runs the volume REST lifecycle
against a real `boxlite serve` process. Codecov requires 90% coverage of changed lines
and reports total coverage.

The Linux Rust jobs enable unprivileged user namespaces on their disposable runners
so SSH guest tests can create private user/mount namespaces. This temporarily disables
Ubuntu's AppArmor user-namespace restriction, as the Nix job does for its jailer.
Namespace setup failures remain test errors.

`make coverage:bindings:external` runs `make test:unit:scripts` before collecting
native SDK profiles. The infra job also runs `make test:unit:scripts` whenever
`tests/scripts/` or a script it drives (`scripts/ci/`, `scripts/test/coverage-bindings.sh`)
changes. A relative `CARGO_TARGET_DIR` is resolved from the repository
root once, so Python and Node builds share the report's object directory.

Linux x64 also runs the native KVM hardware tests and adds their profiles before
the Rust coverage upload. Missing `/dev/kvm` access fails this qualification.
When a change matches the `vmm` filter (the VMM and hypervisor crates, the kernel
build and its Make recipes), and on the weekly and manual runs, the job also runs
the VMM's real-kernel boot tests with `make coverage:vmm:boot`. It restores the
pinned `vmlinux` from the Actions cache, keyed on the kernel pins and build
script, or builds it with `make vmm:boot:host` on a miss.
The boot coverage target also builds the static production guest mount test
init with `make vmm:guest-mount-init` and exports `VMM_GUEST_MOUNT_INIT` to
the tests. This keeps the guest mount test in the boot coverage suite rather
than skipping it. The selected Linux x64 job installs the musl Rust target,
musl compiler and gperf, and uses the musl compiler for Rust linking and C
dependencies. The boot step's five-minute budget includes the release build
of this init; its guest execution remains bounded by the test watchdog.

`Dashboard Tests` runs the dashboard's vitest suite on one Linux runner and
uploads v8 coverage under the `dashboard` flag. `@nx/vite` infers the project's
`test` target from the `test` block in `apps/dashboard/vite.config.mts`; without
that block the target does not exist, nothing runs the suite, and a
dashboard-only change reaches Codecov with no report — which the patch status
rejects as a missing report rather than as low coverage. Specs choose their own
environment with a `// @vitest-environment jsdom` pragma.

`API Tests` also runs the shared CI Listener and standalone host suites, using
the job's disposable PostgreSQL service through the same `DB_HOST`, `DB_PORT`,
`DB_USERNAME`, `DB_PASSWORD` and `DB_DATABASE` settings as other API tests.
Changes to either CI project select this job on drafts and ready PRs. Their
LCOV reports are uploaded with the API report under the `api` flag; local checks
use `make coverage:ci-listener` and `make coverage:github-ci-runner`. Leaving the
database URL unset skips the PostgreSQL contracts locally, so that run cannot
certify hosted persistence or rollback behavior.

When none of the coverage suites is selected on a PR or merge group, the
`Codecov (no coverage changes)` job runs a validated `empty-upload`. Codecov
checks the changed files before publishing a passing or failing status; the
workflow never forces a pass. Failed file detection cannot select this path,
and upload errors fail `Test (conclusion)`. Source changes still need reports
and 90% patch coverage; missing reports fail the patch status.

Plugin resources, `scripts/plugins`, `tests/plugins`, and their Make/CI inputs select
the lightweight `Plugin package coverage` job, including on drafts. It measures
package tests and real check/dist commands through `make plugin:boxlite:coverage`,
saves the Cobertura XML as the `plugin-coverage` artifact, and uploads it with OIDC
under the `plugins` carryforward flag. Selected plugin source cannot take the
empty-upload path; package or upload failures block `Test (conclusion)`.

The package validator requires onboarding to name a distributed, frontmatter-validated
`skills/<name>/SKILL.md` inventory. Excluded caches and shipped reference files cannot
serve as onboarding skills, even when both manifests name the same existing file or alias.
Each onboarding regression restores original manifest bytes and removes its invalid resource
before the next case, so leftover invalid state cannot mask a later failure.

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

## Release dependency preflight

`Release dependency audit` runs on PRs targeting `main` whose title starts with
`chore(release): bump version to `, such as `chore(release): bump version to 0.11.2`.
It includes drafts and reruns on new commits, reopening, or metadata edits, so renaming
a PR re-evaluates selection. Renaming outside that convention excludes the PR.
The separate workflow leaves the existing Test workflow's triggers unchanged.

The job runs `make audit:apps` with Node 22, using the pinned Yarn version without
installing dependencies. It applies the same production, high/critical audit as
[mbuild publication](../../apps/infra/mbuild/README.md#dependency-audit-failures).
Findings and registry/service failures fail the check and retain their diagnostics.
Other PRs skip the job before runner allocation; merge groups also skip because
release PRs complete their preflight before queue admission. Publication retains its
own audit because advisory data can change after the PR check.

After the workflow lands and produces a check run, require `Release dependency audit`
from GitHub Actions in the `main` ruleset. Until enabled, a failure is visible but does
not itself block merging; `Test (conclusion)` does not aggregate this separate workflow.

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

Deployment composites receive stage configuration and cloud identity settings through explicit inputs.
The calling job binds the target Environment, reads its `vars`, and supplies those values with `with`;
for example, `gcp-deployer: ${{ vars.GCP_DEPLOYER }}` becomes `${{ inputs.gcp-deployer }}` inside the action.
Composite action manifests have a narrower context set than workflows and cannot reference `vars` directly.

The reusable image workflow carries the promotion source declaration separately through `stage-config-from`.

The mdeploy tests parse composite-step input expressions against the Runner's supported contexts and check every caller's configuration bindings.
Run them with `make test:apps:mdeploy`; workflow lint alone does not exercise loading a local action manifest.

| Action | Sites | Used by |
| --- | --- | --- |
| `mbuild` | 2 | mdeploy-all image preparation and the reusable mbuild workflow |
| `build-staged-runner` | 1 | mdeploy-all Runner preparation |
| `mdeploy` | 2 | mdeploy-all release apply and commit deploy |
| `ci-config` | 3 | config, lint, test |
| `setup-rust` | 10 | build-c, build-node, build-runtime ×2, build-wheels, lint ×2, test ×3 |
| `sccache` | 7 | build-c, build-node, build-runtime, build-wheels, lint, test ×2 |
| `build-guest` | 4 | build-c, build-node, build-runtime, build-wheels |
| `upload-to-release` | 5 | build-c, build-node, build-runner-binary, build-runtime, build-wheels |
| `run-in-manylinux` | 3 | build-c, build-node, build-runtime |
| `setup-go` | 4 | build-go, build-runner-binary, lint, test |
| `setup-python` | 5 | lint ×2, test ×3 |
| `setup-buildx` | 2 | build-box-images, release-box-images |

`setup-infra` saves an exact dependency-cache miss immediately after `npm ci`,
using the key recorded by its restore step. Callers may then change their checkout.
The deployment action saves a generated SST platform after use, before returning to its caller.

Both caches use `v2` namespaces and exact keys; stage state and configuration stay outside their paths.

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

## Manual SDK and Runner builds

Dispatching `build-runner-binary.yml` builds the selected full commit SHA's Linux x64 C SDK,
then links the Runner against that same-run artifact. Its archive and version identity include
the commit SHA. Dispatching `build-go.yml` builds the selected workflow ref's C SDK on all
supported platforms, then tests each Go SDK against its matching artifact. Neither manual
path requires a published release for the current `Cargo.toml` version.

The release chain still downloads the published C archives. Reusable Runner callers retain their explicit
`libboxlite_source` selection: `deploy-infra.yml` supplies its existing C artifact without a
second C build. A C build failure stops its consumers; manual runs publish no releases or tags.

Runner release uploads and Go module tagging run only after successful release-origin C SDK
builds, followed by a successful Runner build or Go test matrix respectively.
The manual `build-c` job is intentionally skipped on that path, so each publication job uses
`!cancelled()` and explicit prerequisite-result checks to override the implicit `success()`
check inherited through the dependency chain. Failed or skipped prerequisites and workflow
cancellation still prevent publication; manual builds, reusable deployment builds, and
non-release upstream runs do not publish through these jobs.

## Do not rename these

Two workflows chain off another's **display name**, not its filename. Changing the `name:` below
silently stops the chain — no error, the downstream workflow simply never fires.

| `name:` | Depended on by |
| --- | --- |
| `Build C SDK` | `build-go.yml`, `build-runner-binary.yml` |

Go release tests require the canonical C workflow and read the platform matrix and toolchain
at that run's commit. A missing or different C run archive stops testing. Before creating
the Go module tag, the workflow checks that the remote product tag still points to the tested commit.

## Adding a stage

Define the stage in `.mstage.config.json`, bootstrap its intended cloud/path, and publish its declaration
with `npm run mstage config put -- --stage <stage>`. The GitHub Environment name must match the stage.

Manual workflow choices are allowlists: mdeploy-all currently exposes `dev`, `stage` and `prod`, with distinct
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
- `SLACK_WEBHOOK_URL` — optional #release webhook for release dev approvals, final reports and prod apply approvals
- `SLACK_DEV_DEPLOYMENT_WEBHOOK_URL` — optional #dev_deployment webhook for dev apply approvals. An empty secret skips that channel.

## Plugin release artifacts

The build workflow validates the Codex and Claude packages and saves five files for previews and publication. [Build workflow](build-plugins.yml)

The publishing workflow verifies the tag from `main` and publishes one versioned GHCR artifact. [Publishing workflow](publish-plugins.yml)

The publisher downloads the exact artifact ID for the validated build attempt. A main-only environment supplies the registry credential.

Same-version runs serialize. An identical digest can resume attestation, and a conflicting digest stops publication.

The [plugin publishing guide](../../scripts/plugins/README.md#publish-versioned-packages-to-ghcr) covers migration, registry access, retries, and downloads.
Run `make test:apps:infra` to exercise the workflow guards with real plugin packages.
