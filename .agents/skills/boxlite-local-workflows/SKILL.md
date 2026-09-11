---
name: boxlite-local-workflows
description: Run reproducible local BoxLite workflows, using infra-local as the default local deployment and providing apps builds, Dex E2E, and fixed full rebuild/restart flows.
---

# BoxLite local workflows

This is a repository-local skill. Its authoritative location is
`<repo-root>/.agents/skills/boxlite-local-workflows`; do not look for it under
`~/.agents` or `$CODEX_HOME/skills`.

Resolve the repository root first so the workflow can be invoked from any
current directory:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKFLOW_SCRIPT="$REPO_ROOT/.agents/skills/boxlite-local-workflows/scripts/local_workflows.sh"
```

Use the bundled script instead of composing these commands manually:

```bash
"$WORKFLOW_SCRIPT" WORKFLOW [OPTIONS]
```

Choose the workflow by intent:

| Situation | Workflow |
| --- | --- |
| Build app artifacts with the local Go SDK | `apps` |
| Start the Docker-backed Dex E2E environment | `e2e-local` |
| First deployment or recovery of `infra-local` | `infra-local` |
| Source changes in an already-running `infra-local` stack | `redeploy-infra-local` |

For an unspecified local deployment request, use `infra-local`. Use
`e2e-local` only when the request explicitly needs the Docker-backed Dex E2E
environment. The script still requires the workflow name on the command line;
this keeps service startup explicit.

Do not use `make up` alone as a source-change redeploy. Use the fixed
`redeploy-infra-local` workflow so generated clients, full apps artifacts, and
all four infra-local L2 applications stay in one predictable sequence.

## Apps build

Use when you need generated app artifacts or want to verify the apps workspace:

```bash
"$WORKFLOW_SCRIPT" apps
```

It runs:

1. `make dev:go`, producing `target/debug/libboxlite.a` and the development Go SDK.
2. `VERSION=<workspace version> GOFLAGS=-tags=boxlite_dev make build:apps`.

An explicitly set `VERSION` is preserved. Otherwise the script reads the
version from `[workspace.package]` in the root `Cargo.toml`. The workflow does
not start or redeploy local services.

Use `--dry-run` to inspect commands without running them:

```bash
"$WORKFLOW_SCRIPT" --dry-run apps
```

## Docker-backed local E2E

Use when the goal is a local Dex/browser/integration test run. Each invocation
regenerates clients and reuses the full `apps` build workflow before starting
the E2E services:

```bash
"$WORKFLOW_SCRIPT" \
  e2e-local -- npm --prefix apps run e2e:dev
```

The workflow runs:

1. `npm --prefix apps run generate:api-client`.
2. The `apps` workflow (`make dev:go` and `build:apps`).
3. `npm run e2e:local`, which checks Docker, starts or reuses Postgres, Redis,
   Dex, and the local registry, prepares missing runtime images, and starts a
   fresh API, runner, proxy, and dashboard `serve-slim` process group.
4. It waits for Dex, API `/config`, and dashboard readiness before running the
   supplied command.

Without a command, it leaves the newly started environment running until
interrupted. Stop any previous foreground `e2e-local` process before invoking
the workflow again so its ports are available; Docker dependencies are reused.

The underlying E2E entrypoint still only builds the native library when it is
missing, but this workflow has already rebuilt it through the `apps` workflow.
Runtime image Dockerfile changes require a new
`BOXLITE_E2E_RUNTIME_IMAGE_TAG` or an explicit image rebuild; an existing tag is
reused.

Do not use `start`, `start:dex`, or `serve-slim` directly for E2E; the entrypoint
also configures OIDC, registry, runtime images, and Go build-cache invalidation.

## First `infra-local` deployment

Use this when `infra-local` has not been initialized, or when you intentionally
need its self-healing startup:

```bash
"$WORKFLOW_SCRIPT" infra-local
```

The workflow runs:

1. `make -C apps/infra-local up`
   - creates or reuses `.venv-infra`;
   - ensures the repository's local Python BoxLite SDK and native assets;
   - creates or repairs the L1 BoxLite microVM services;
   - builds missing runner/proxy binaries;
   - prepares `apps/api/.env`;
   - starts API, runner, proxy, and dashboard;
   - initializes the API and waits for the default runner registration.
2. `make -C apps/infra-local status`.

The stack persists state under `.apps-local/`. This workflow does not wipe the
database or runner home. `make nuke` is destructive and is not part of any
standard workflow.

## Redeploy changed `infra-local` code

Use this only after the initial `infra-local` stack is running. The workflow
intentionally has no component-selection branch: every redeploy regenerates
clients, rebuilds all apps, and restarts all four L2 applications.

```bash
"$WORKFLOW_SCRIPT" \
  redeploy-infra-local
```

The fixed sequence is:

1. `npm --prefix apps run generate:api-client`
2. Run the `apps` workflow (the same `make dev:go` and `build:apps` sequence)
3. `make -C apps/infra-local restart COMPONENTS="api runner proxy dashboard"`

This handles Box/Rust/FFI, API, Runner, Proxy, Dashboard, and generated client
changes with one path. The reused `apps` workflow creates the full build and
client `dist` outputs; the final restart does not separately rebuild client
libraries and only restarts the four listed L2 applications. It does not
recreate L1 boxes. The script preserves L1 boxes, database data, and runner
state; it does not run `reset`, `down --all`, or `nuke`.

The Makefile currently accepts the four L2 components through `COMPONENTS=`;
the workflow treats that as its internal implementation of `all` rather than
asking callers to select components.

If Python SDK or L1 orchestration code changed, restart the affected L1 box:

```bash
make -C apps/infra-local restart COMPONENTS=postgres
```

For a deliberate full L1 recreation, use `make -C apps/infra-local down
ARGS=--all` followed by `make -C apps/infra-local up`; this removes the L1 boxes
but keeps their data volumes. Only use `make -C apps/infra-local reset
ARGS=--hard` when intentionally rebuilding the database schema.

## Checks

Before `apps`, inspect the relevant Make targets:

```bash
make -n dev:go
make -n build:apps
test -f sdks/go/bridge_cgo_dev.go
```

Before `e2e-local`, verify Docker and app dependencies:

```bash
docker ps
test -d apps/node_modules
```

After a real workflow, verify relevant outputs and always run:

```bash
test -f target/debug/libboxlite.a
git diff --check
```

Record the actual exit status. A dry-run only proves command construction; it
does not prove that a build, deployment, or test passed.
