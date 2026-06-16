# Agent Runtime Images Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish BoxLite agent runtime Docker images from source-controlled Dockerfiles using new GHCR package names and version tags.

**Architecture:** Restore the historical `images/agent-runtime` Dockerfiles and startup script, with one multi-arch correction: Dockerfiles copy `boxlite-daemon-${TARGETARCH}` so each platform gets the matching daemon binary. Add a reusable local build script and a GitHub Actions workflow that derives `vX.Y.Z` from root `Cargo.toml`, then pushes `linux/amd64` and `linux/arm64` images to new `*-v2` GHCR packages. Update the API allowlist, infra fallbacks, and dashboard picker to use the new package names and version tag.

**Tech Stack:** Docker Buildx, GitHub Actions, GHCR, Go daemon build, TypeScript/Jest API tests, React/Vitest dashboard tests, Makefile verification.

---

### Task 1: Restore Agent Runtime Sources

**Files:**
- Create: `images/agent-runtime/base.Dockerfile`
- Create: `images/agent-runtime/python.Dockerfile`
- Create: `images/agent-runtime/node.Dockerfile`
- Create: `images/agent-runtime/start-agent-runtime.sh`
- Modify: `.dockerignore`

**Step 1: Restore the historical files**

Use commit `fc88aa0b` as the source for the three Dockerfiles and `start-agent-runtime.sh`.

**Step 2: Fix Docker build context**

Modify `.dockerignore` so `apps/dist/apps/daemon-runtime/boxlite-daemon-amd64` and `apps/dist/apps/daemon-runtime/boxlite-daemon-arm64` can be copied into the Docker build context while unrelated app build output remains ignored.

**Step 3: Verify Dockerfile sources exist**

Run:

```bash
test -f images/agent-runtime/base.Dockerfile
test -f images/agent-runtime/python.Dockerfile
test -f images/agent-runtime/node.Dockerfile
test -f images/agent-runtime/start-agent-runtime.sh
```

Expected: all commands exit 0.

**Step 4: Commit**

```bash
git add .dockerignore images/agent-runtime
git commit -m "build: restore agent runtime Dockerfiles"
```

### Task 2: Add Versioned Build Script

**Files:**
- Create: `scripts/images/build-agent-runtime.sh`

**Step 1: Write script behavior**

Create a script that:

- Reads `TAG` from env or derives `v$(Cargo.toml package.version)`.
- Uses `REGISTRY=ghcr.io/boxlite-ai` by default.
- Uses package names `boxlite-agent-base-v2`, `boxlite-agent-python-v2`, and `boxlite-agent-node-v2`.
- Accepts `PLATFORMS=linux/amd64,linux/arm64` by default.
- Accepts `PUSH=0` for local dry-run and `PUSH=1` for registry publishing.
- Fails on unsupported platforms.
- Builds `boxlite-daemon-amd64` and/or `boxlite-daemon-arm64` before Docker builds.
- Uses Buildx `--platform "$PLATFORMS"` for pushes.

**Step 2: Run script help or dry validation**

Run:

```bash
bash -n scripts/images/build-agent-runtime.sh
```

Expected: exit 0.

**Step 3: Commit**

```bash
git add scripts/images/build-agent-runtime.sh
git commit -m "build: add versioned agent runtime image script"
```

### Task 3: Add Publish Workflow

**Files:**
- Create: `.github/workflows/publish-agent-runtime-images.yml`

**Step 1: Create workflow**

Add a workflow with:

- `name: Publish Agent Runtime Images`
- `push` trigger on `main` for `images/agent-runtime/**`, `apps/daemon/**`, `scripts/images/build-agent-runtime.sh`, and the workflow file.
- `workflow_dispatch` input `version` for manual override.
- `permissions: contents: read, packages: write`.
- `docker/setup-qemu-action`, `docker/setup-buildx-action`, and `docker/login-action`.
- Version extraction from root `Cargo.toml` when no manual version is provided.
- `TAG=v<version> PUSH=1 PLATFORMS=linux/amd64,linux/arm64 bash scripts/images/build-agent-runtime.sh`.

**Step 2: Validate workflow syntax structurally**

Run:

```bash
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/publish-agent-runtime-images.yml'); puts 'ok'"
```

Expected: prints `ok`.

**Step 3: Commit**

```bash
git add .github/workflows/publish-agent-runtime-images.yml
git commit -m "ci: publish agent runtime images"
```

### Task 4: Update API And Infra Refs Test-First

**Files:**
- Modify: `apps/api/src/box/constants/curated-images.constant.spec.ts`
- Modify: `apps/api/src/box/constants/curated-images.constant.ts`
- Modify: `apps/infra/sst.config.ts`

**Step 1: Write failing API expectation**

Update the API allowlist spec to expect:

```text
ghcr.io/boxlite-ai/boxlite-agent-base-v2:v0.9.5
ghcr.io/boxlite-ai/boxlite-agent-python-v2:v0.9.5
ghcr.io/boxlite-ai/boxlite-agent-node-v2:v0.9.5
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd apps && yarn test api/src/box/constants/curated-images.constant.spec.ts
```

Expected: FAIL because production code still returns old `boxlite-agent-*` refs.

**Step 3: Update production refs**

Update `curated-images.constant.ts` and `sst.config.ts` to use the `*-v2:v0.9.5` refs.

**Step 4: Run test to verify it passes**

Run:

```bash
cd apps && yarn test api/src/box/constants/curated-images.constant.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/box/constants/curated-images.constant.ts apps/api/src/box/constants/curated-images.constant.spec.ts apps/infra/sst.config.ts
git commit -m "feat: switch curated API refs to agent runtime v2"
```

### Task 5: Update Dashboard Picker Test-First

**Files:**
- Create: `apps/dashboard/src/components/Box/supportedBoxImages.ts`
- Create: `apps/dashboard/src/components/Box/supportedBoxImages.test.ts`
- Modify: `apps/dashboard/src/components/Box/CreateBoxSheet.tsx`

**Step 1: Extract desired refs into a test**

Create a dashboard test that imports `SUPPORTED_BOX_IMAGES` from `supportedBoxImages.ts` and expects the three `*-v2:v0.9.5` refs, base first and default.

**Step 2: Run test to verify it fails**

Run:

```bash
cd apps && yarn vitest run dashboard/src/components/Box/supportedBoxImages.test.ts
```

Expected: FAIL while the module is missing or still old.

**Step 3: Extract production constant**

Move the `SUPPORTED_BOX_IMAGES` array out of `CreateBoxSheet.tsx` into `supportedBoxImages.ts`, update refs to `*-v2:v0.9.5`, and import it from the sheet.

**Step 4: Run test to verify it passes**

Run:

```bash
cd apps && yarn vitest run dashboard/src/components/Box/supportedBoxImages.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/dashboard/src/components/Box/CreateBoxSheet.tsx apps/dashboard/src/components/Box/supportedBoxImages.ts apps/dashboard/src/components/Box/supportedBoxImages.test.ts
git commit -m "feat: switch dashboard image picker to agent runtime v2"
```

### Task 6: Final Verification

**Files:**
- All changed files.

**Step 1: Run focused syntax checks**

Run:

```bash
bash -n scripts/images/build-agent-runtime.sh
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/publish-agent-runtime-images.yml'); puts 'ok'"
```

Expected: both pass.

**Step 2: Run app tests**

Run:

```bash
make test:apps
```

Expected: PASS. If the suite is too broad or blocked by environment, run the focused API and dashboard tests and report the blocker.

**Step 3: Optional Docker dry-run**

If Docker is available:

```bash
PLATFORMS=linux/amd64 PUSH=0 bash scripts/images/build-agent-runtime.sh
```

Expected: local build succeeds for all three images. If Docker is unavailable, report that this was not run.

**Step 4: Inspect final diff**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
```

Expected: clean working tree and scoped diff.

**Step 5: Push and open PR**

```bash
git push -u origin codex/agent-runtime-images-v2
gh pr create --base main --head codex/agent-runtime-images-v2 --title "Publish agent runtime images from Dockerfiles" --body-file /tmp/agent-runtime-images-pr.md
```

Expected: PR created for review.
