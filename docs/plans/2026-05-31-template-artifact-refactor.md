# Template Artifact Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename the cloud control-plane create-time `Snapshot`/`Environment` concept to `BoxTemplate`, rename startup material to `RuntimeArtifact`/`artifactRef`, rename runner prewarm state to `RunnerArtifactCache`, keep BoxLite core `Snapshot`, and verify local plus dev behavior before launch.

**Architecture:** The refactor is a deep pre-launch rename across API, DB, Dashboard, runner, artifact registry, and generated clients. Product/API code should speak `BoxTemplate`; runner/material code should speak `RuntimeArtifact` and `artifactRef`; core runtime snapshot/restore code remains `Snapshot`. Compatibility aliases may exist only at external route/payload boundaries and must be explicitly named as aliases.

**Tech Stack:** NestJS, TypeORM/Postgres migrations, React/TanStack Query Dashboard, OpenAPI Generator TypeScript/Go clients, Go runner and artifact registry services, SST dev deploy, repo-level `make` targets.

---

## Preconditions

- Worktree: `/Users/brian/1-Home/1-Code/4-Learn/boxlite/.claude/worktrees/template-artifact-refactor`
- Branch: `codex/template-artifact-refactor`
- Pre-refactor checkpoint: `cf1ace7 chore: checkpoint mvp journey before template refactor`
- Design docs:
  - `docs/plans/2026-05-31-template-artifact-refactor-design.md`
  - `docs/architecture/cloud-control-plane.md`
  - `docs/architecture/naming-glossary.md`
  - `docs/architecture/decisions/2026-05-31-template-artifact-snapshot.md`

Known checkpoint verification failures:

- Pre-commit `make lint:fix` failed because local Python venv creation failed.
- Pre-push `make test` failed because `sdk-typescript` has no tests, runner Go tests lacked `sdks/go/libboxlite.a`, and Rust integration had one failing `health_check_becomes_unhealthy_when_shim_killed`.
- Treat these as baseline until reproduced after setup; do not hide new failures behind them.

## Commit Cadence

Commit after each major green slice:

1. Architecture docs.
2. API tests and template naming.
3. DB migration/entity rename.
4. Artifact/cache manager rename.
5. Runner/artifact registry rename.
6. Dashboard Create Box/template/resource UI.
7. Generated clients and final verification fixes.

Use `git status --short --branch` before each commit. Never stage unrelated changes from another worktree.

---

### Task 1: Bootstrap The Refactor Worktree

**Files:**
- Read: `Makefile`
- Read: `make/setup.mk`
- Read: `apps/package.json`
- Read: `apps/infra/README.md`

**Step 1: Confirm clean branch**

Run:

```bash
git status --short --branch
```

Expected: branch is `codex/template-artifact-refactor` with no uncommitted changes.

**Step 2: Install local dependencies**

Run:

```bash
make setup:test
```

Expected: apps dependencies, test tools, and local Python/Rust/Node support are ready.

If Python venv creation fails, inspect:

```bash
python3 --version
which python3
make setup:build
```

Record the exact blocker. Do not change implementation scope to work around missing dependencies silently.

**Step 3: Reproduce focused baseline**

Run the smallest checks that cover this refactor:

```bash
make test:apps
make test:unit:go
make test:unit:rust
```

Expected: either pass or reproduce known baseline failures. Save the failure text in the turn notes before changing code.

---

### Task 2: Add Failing API Tests For Template Semantics

**Files:**
- Modify: `apps/api/src/sandbox/services/snapshot.service.spec.ts`
- Modify: `apps/api/src/sandbox/constants/system-templates.spec.ts`
- Modify: `apps/api/src/boxlite-rest/mappers/sandbox-to-box.mapper.spec.ts`
- Create if needed: `apps/api/src/sandbox/dto/box-template.dto.spec.ts`

**Step 1: Add template DTO mapping tests**

Add tests proving:

- a `BoxTemplateDto` contains `id`, `name`, `displayName`, `description`, `imageName`, `version`, `cpu`, `gpu`, `mem`, `disk`, `regionIds`, and `artifactRef`.
- system template labels are derived from current system template metadata.
- no DTO test imports `EnvironmentDto`.

**Step 2: Add create Box resource override tests**

Extend `sandbox-to-box.mapper.spec.ts` or a focused service/controller test to prove:

```typescript
const dto = createBoxToCreateSandbox({
  template: 'ubuntu:24.04',
  cpus: 2,
  memory_mib: 1536,
  disk_size_gb: 8,
})

expect(dto.templateId ?? dto.environmentId).toBeDefined()
expect(dto.cpu).toBe(2)
expect(dto.memory).toBe(2)
expect(dto.disk).toBe(8)
```

**Step 3: Verify tests fail for the right reason**

Run:

```bash
cd apps && yarn nx test api --runTestsByPath src/sandbox/services/snapshot.service.spec.ts src/boxlite-rest/mappers/sandbox-to-box.mapper.spec.ts
```

Expected: failures mention missing template names/types or missing `templateId` mapping, not test setup errors.

Commit only after implementation tasks make these tests pass.

---

### Task 3: Rename API DTOs, Controllers, And Template Service

**Files:**
- Rename: `apps/api/src/sandbox/controllers/environment.controller.ts` -> `apps/api/src/sandbox/controllers/template.controller.ts`
- Rename: `apps/api/src/sandbox/controllers/snapshot.controller.ts` -> `apps/api/src/sandbox/controllers/box-template.controller.ts`
- Rename: `apps/api/src/sandbox/dto/environment.dto.ts` -> `apps/api/src/sandbox/dto/box-template.dto.ts`
- Rename: `apps/api/src/sandbox/dto/create-snapshot.dto.ts` -> `apps/api/src/sandbox/dto/create-box-template.dto.ts`
- Rename: `apps/api/src/sandbox/dto/snapshot.dto.ts` -> `apps/api/src/sandbox/dto/box-template-details.dto.ts` or merge into `box-template.dto.ts`
- Rename: `apps/api/src/sandbox/dto/paginated-snapshots.dto.ts` -> `apps/api/src/sandbox/dto/paginated-box-templates.dto.ts`
- Rename: `apps/api/src/sandbox/dto/list-snapshots-query.dto.ts` -> `apps/api/src/sandbox/dto/list-box-templates-query.dto.ts`
- Rename: `apps/api/src/sandbox/services/snapshot.service.ts` -> `apps/api/src/sandbox/services/box-template.service.ts`
- Modify: `apps/api/src/sandbox/sandbox.module.ts`

**Step 1: Use `git mv`**

Run:

```bash
git mv apps/api/src/sandbox/controllers/environment.controller.ts apps/api/src/sandbox/controllers/template.controller.ts
git mv apps/api/src/sandbox/controllers/snapshot.controller.ts apps/api/src/sandbox/controllers/box-template.controller.ts
git mv apps/api/src/sandbox/dto/environment.dto.ts apps/api/src/sandbox/dto/box-template.dto.ts
git mv apps/api/src/sandbox/dto/create-snapshot.dto.ts apps/api/src/sandbox/dto/create-box-template.dto.ts
git mv apps/api/src/sandbox/dto/snapshot.dto.ts apps/api/src/sandbox/dto/box-template-details.dto.ts
git mv apps/api/src/sandbox/dto/paginated-snapshots.dto.ts apps/api/src/sandbox/dto/paginated-box-templates.dto.ts
git mv apps/api/src/sandbox/dto/list-snapshots-query.dto.ts apps/api/src/sandbox/dto/list-box-templates-query.dto.ts
git mv apps/api/src/sandbox/services/snapshot.service.ts apps/api/src/sandbox/services/box-template.service.ts
```

**Step 2: Rename exported classes**

Use these target names:

- `TemplateController` for `GET /templates`
- `BoxTemplateController` for create/get/list/update/delete template APIs
- `BoxTemplateDto`
- `CreateBoxTemplateDto`
- `PaginatedBoxTemplatesDto`
- `ListBoxTemplatesQueryDto`
- `BoxTemplateService`

**Step 3: Add compatibility route only if needed**

Preferred target:

```typescript
@ApiTags('templates')
@Controller('templates')
export class TemplateController {}
```

If `/environments` must remain temporarily, create a thin deprecated controller:

```typescript
@Controller('environments')
export class EnvironmentCompatibilityController {
  constructor(private readonly templateController: TemplateController) {}
}
```

Do not duplicate business logic in the compatibility controller.

**Step 4: Run focused API tests**

Run:

```bash
cd apps && yarn nx test api --runTestsByPath src/sandbox/constants/system-templates.spec.ts src/sandbox/services/snapshot.service.spec.ts
```

Expected: tests are updated to template names and pass.

---

### Task 4: Rename Entities, Columns, Enums, And Repositories

**Files:**
- Rename: `apps/api/src/sandbox/entities/snapshot.entity.ts` -> `apps/api/src/sandbox/entities/box-template.entity.ts`
- Rename: `apps/api/src/sandbox/entities/snapshot-region.entity.ts` -> `apps/api/src/sandbox/entities/box-template-region.entity.ts`
- Rename: `apps/api/src/sandbox/entities/snapshot-runner.entity.ts` -> `apps/api/src/sandbox/entities/runner-artifact-cache.entity.ts`
- Modify: `apps/api/src/sandbox/entities/build-info.entity.ts`
- Rename: `apps/api/src/sandbox/enums/snapshot-state.enum.ts` -> `apps/api/src/sandbox/enums/box-template-state.enum.ts`
- Rename: `apps/api/src/sandbox/enums/snapshot-runner-state.enum.ts` -> `apps/api/src/sandbox/enums/runner-artifact-cache-state.enum.ts`
- Modify: `apps/api/src/sandbox/entities/sandbox.entity.ts`
- Modify: `apps/api/src/sandbox/sandbox.module.ts`

**Step 1: Rename files with `git mv`**

Run the `git mv` commands for the files above.

**Step 2: Rename classes and properties**

Target names:

- `Snapshot` -> `BoxTemplate`
- `SnapshotRegion` -> `BoxTemplateRegion`
- `SnapshotRunner` -> `RunnerArtifactCache`
- `SnapshotState` -> `BoxTemplateState`
- `SnapshotRunnerState` -> `RunnerArtifactCacheState`
- `BuildInfo.snapshotRef` -> `BuildInfo.artifactRef`
- `generateBuildInfoHash` may keep its generic name, but it must return an artifact ref.

**Step 3: Preserve BoxLite core snapshot terms**

Do not change files under:

- `src/boxlite/**` when they implement snapshot/restore/clone/export.
- `docs/reference/**` where they document core snapshot/restore.
- Rust tests that prove core snapshot semantics.

**Step 4: Compile TypeScript enough to find broken imports**

Run:

```bash
cd apps && yarn nx test api --runTestsByPath src/sandbox/constants/system-templates.spec.ts
```

Expected: import/name errors are fixed before moving on.

---

### Task 5: Add Data Migrations For Dev Data

**Files:**
- Create: `apps/api/src/migrations/pre-deploy/1775000000000-template-artifact-rename.ts`
- Create: `apps/api/src/migrations/post-deploy/1775000000001-template-artifact-cleanup.ts` if compatibility cleanup is needed
- Modify: `apps/api/src/migrations/pre-deploy/data-source.ts` if migration exports require manual inclusion
- Modify: `apps/api/src/migrations/post-deploy/data-source.ts` if migration exports require manual inclusion

**Step 1: Inspect generated schema names**

Before writing SQL, inspect existing entity decorators and old migrations for table, constraint, enum, and index names:

```bash
rg -n '"snapshot"|"snapshot_runner"|"snapshot_region"|snapshotRef|SnapshotRunnerState|SnapshotState' apps/api/src/migrations apps/api/src/sandbox
```

**Step 2: Write pre-deploy migration**

The migration should preserve data:

```sql
ALTER TABLE "snapshot" RENAME TO "box_template";
ALTER TABLE "snapshot_region" RENAME TO "box_template_region";
ALTER TABLE "snapshot_runner" RENAME TO "runner_artifact_cache";
ALTER TABLE "build_info" RENAME COLUMN "snapshotRef" TO "artifactRef";
ALTER TABLE "runner_artifact_cache" RENAME COLUMN "snapshotRef" TO "artifactRef";
ALTER TABLE "box_template_region" RENAME COLUMN "snapshotId" TO "boxTemplateId";
```

Also rename indexes and constraints where Postgres supports it. If an index/constraint name is hard to rename safely, drop and recreate it in the same migration.

**Step 3: Write down migration**

Reverse every table, column, index, and constraint rename. Down migration must restore dev data to the old names.

**Step 4: Validate migration path**

Run:

```bash
bash apps/api/scripts/validate-migration-paths.sh apps/api/src/migrations/pre-deploy/1775000000000-template-artifact-rename.ts
```

Expected: migration path validation passes.

---

### Task 6: Update Create Box Contract And Resource Override Flow

**Files:**
- Modify: `apps/api/src/sandbox/dto/create-sandbox.dto.ts`
- Modify: `apps/api/src/sandbox/controllers/sandbox.controller.ts`
- Modify: `apps/api/src/sandbox/services/sandbox.service.ts`
- Modify: `apps/api/src/boxlite-rest/dto/create-box.dto.ts`
- Modify: `apps/api/src/boxlite-rest/mappers/sandbox-to-box.mapper.ts`
- Modify: `apps/api/src/boxlite-rest/mappers/sandbox-to-box.mapper.spec.ts`

**Step 1: Add `templateId`**

Add `templateId?: string` to `CreateSandboxDto` as the preferred field. Keep `environmentId?: string` as a compatibility alias until Dashboard and generated clients are fully moved.

**Step 2: Normalize source once**

Create a helper in the controller or service:

```typescript
const getRequestedTemplateId = (dto: CreateSandboxDto) => dto.templateId?.trim() || dto.environmentId?.trim()
```

Reject requests that specify more than one source (`templateId`, `environmentId`, `snapshot`, `buildInfo`) unless the caller is an admin using an explicitly preserved legacy flow.

**Step 3: Apply resource overrides**

For template creation:

- empty `cpu`, `memory`, `disk` means use template defaults.
- provided CPU/memory/disk override final Box resources.
- GPU remains rejected for templates unless the product explicitly supports it later.

**Step 4: Prove mapper behavior**

Run:

```bash
cd apps && yarn nx test api --runTestsByPath src/boxlite-rest/mappers/sandbox-to-box.mapper.spec.ts
```

Expected: Create Box mapper tests pass and resource overrides use template fields.

---

### Task 7: Rename Runtime Artifact Manager And Runner Cache Logic

**Files:**
- Rename: `apps/api/src/sandbox/managers/snapshot.manager.ts` -> `apps/api/src/sandbox/managers/runtime-artifact.manager.ts`
- Rename: `apps/api/src/sandbox/constants/snapshot-events.ts` -> `apps/api/src/sandbox/constants/box-template-events.ts`
- Rename: `apps/api/src/sandbox/events/snapshot-created.event.ts` -> `apps/api/src/sandbox/events/box-template-created.event.ts`
- Rename: `apps/api/src/sandbox/events/snapshot-activated.event.ts` -> `apps/api/src/sandbox/events/box-template-activated.event.ts`
- Rename: `apps/api/src/sandbox/events/snapshot-removed.event.ts` -> `apps/api/src/sandbox/events/box-template-removed.event.ts`
- Rename: `apps/api/src/sandbox/events/snapshot-state-updated.event.ts` -> `apps/api/src/sandbox/events/box-template-state-updated.event.ts`
- Rename: `apps/api/src/sandbox/subscribers/snapshot.subscriber.ts` -> `apps/api/src/sandbox/subscribers/box-template.subscriber.ts`
- Modify: `apps/api/src/sandbox/services/runner.service.ts`
- Modify: `apps/api/src/sandbox/managers/sandbox-actions/sandbox-start.action.ts`
- Modify: `apps/api/src/sandbox/runner-adapter/runnerAdapter.ts`
- Modify: `apps/api/src/sandbox/runner-adapter/runnerAdapter.v0.ts`
- Modify: `apps/api/src/sandbox/runner-adapter/runnerAdapter.v2.ts`

**Step 1: Rename manager class**

Use `RuntimeArtifactManager` for orchestration that pulls/builds/removes artifacts.

**Step 2: Rename cache operations**

Target method names:

- `getRunnerArtifactCache`
- `getRunnerArtifactCaches`
- `createRunnerArtifactCacheEntry`
- `artifactExists`
- `getArtifactInfo`

**Step 3: Update state names**

Target enum values:

- `PULLING_ARTIFACT`
- `BUILDING_ARTIFACT`
- `READY`
- `ERROR`
- `REMOVING`

If DB enum value changes are too risky in one migration, keep serialized DB values and map code enum names with explicit comments at the enum definition.

**Step 4: Run focused tests**

Run:

```bash
cd apps && yarn nx test api --runTestsByPath src/sandbox/services/snapshot.service.spec.ts
```

Expected: template/artifact service tests pass after rename.

---

### Task 8: Rename Runner Artifact DTOs And Jobs

**Files:**
- Modify: `apps/api/src/sandbox/enums/job-type.enum.ts`
- Modify: `apps/runner/pkg/api/controllers/snapshot.go`
- Modify: `apps/runner/pkg/api/dto/snapshot.go`
- Modify: `apps/runner/pkg/backend/backend.go`
- Modify: `apps/runner/pkg/backend/boxlite_adapter.go`
- Modify: `apps/runner/pkg/boxlite/registry.go`
- Modify: `apps/runner/pkg/boxlite/stubs.go`
- Modify: `apps/runner/pkg/runner/v2/executor/snapshot.go`
- Modify: `apps/runner/pkg/models/enums/snapshot_state.go`
- Modify: `apps/libs/runner-api-client/src/**` after regeneration

**Step 1: Rename job types**

Target job names:

- `BUILD_ARTIFACT`
- `PULL_ARTIFACT`
- `INSPECT_ARTIFACT_IN_REGISTRY`
- `REMOVE_ARTIFACT`

If v2 runner compatibility needs old serialized job strings during rollout, centralize mapping at the API job creation and runner executor dispatch boundary.

**Step 2: Rename Go DTOs and methods**

Target names:

- `PullArtifactRequestDTO`
- `BuildArtifactRequestDTO`
- `InspectArtifactInRegistryRequest`
- `PullArtifact`
- `BuildArtifact`
- `RemoveArtifact`

Payload field should be `artifactRef` or `artifact`. Avoid `snapshot` except compatibility tags that are explicitly documented.

**Step 3: Regenerate runner API client**

Run:

```bash
cd apps && yarn nx run runner:openapi
cd apps && yarn nx run runner-api-client:generate:api-client
```

Expected: generated runner client uses artifact names.

---

### Task 9: Rename Artifact Registry Service

**Files:**
- Rename directory if practical: `apps/snapshot-manager/` -> `apps/artifact-registry/`
- Modify: `apps/artifact-registry/go.mod`
- Modify: `apps/artifact-registry/Dockerfile`
- Modify: `apps/artifact-registry/project.json`
- Modify: `apps/artifact-registry/cmd/main.go`
- Modify: `apps/artifact-registry/internal/**`
- Modify: `apps/infra/sst.config.ts`
- Modify: `apps/infra/README.md`
- Modify: `apps/package.json` only if project names/scripts require it

**Step 1: Rename Nx project**

Use target project name `artifact-registry`. Update references from `snapshot-manager` to `artifact-registry` in project configuration and Docker build paths.

**Step 2: Rename service in SST**

In `apps/infra/sst.config.ts`, target:

```typescript
const artifactRegistry = new sst.aws.Service("ArtifactRegistry", {
  image: { context: "../..", dockerfile: "apps/artifact-registry/Dockerfile", cache: false },
})
```

Update environment variable names where they mean registry storage, for example `ARTIFACT_REGISTRY_STORAGE_S3_*`. If existing deployed env var names are needed during dev rollout, accept both old and new names in service config for one release.

**Step 3: Run Go tests for the service**

Run:

```bash
cd apps && yarn nx test artifact-registry
```

Expected: no test files or passing tests.

---

### Task 10: Update Dashboard Templates And Create Box Resources

**Files:**
- Rename: `apps/dashboard/src/hooks/queries/useEnvironmentsQuery.ts` -> `apps/dashboard/src/hooks/queries/useTemplatesQuery.ts`
- Rename: `apps/dashboard/src/hooks/mutations/useCreateSandboxFromEnvironmentMutation.ts` -> `apps/dashboard/src/hooks/mutations/useCreateBoxFromTemplateMutation.ts`
- Modify: `apps/dashboard/src/hooks/queries/queryKeys.ts`
- Modify: `apps/dashboard/src/components/Sandbox/CreateSandboxSheet.tsx`
- Modify: `apps/dashboard/src/lib/environment-display.ts` -> rename to `template-display.ts` if it only describes templates
- Modify: `apps/dashboard/src/pages/Snapshots.tsx` -> rename to `Templates.tsx` if active in routes
- Modify: `apps/dashboard/src/enums/RoutePath.ts`
- Modify: `apps/dashboard/src/components/Sidebar.tsx`

**Step 1: Rename hooks**

Target query:

```typescript
axiosInstance.get<BoxTemplate[]>('/templates', ...)
```

Target mutation body:

```typescript
{
  name,
  templateId,
  cpu,
  memory,
  disk,
  autoStopInterval,
  autoDeleteInterval,
}
```

**Step 2: Update Create Box UI**

Layout requirements:

- selector label is `Template`, not `Image`.
- template cards show label, description, version/default badge, and default resources.
- Advanced contains existing `Lifecycle` and new `Resources`.
- Resource fields keep left/right relationship on desktop but wrap cleanly on mobile.
- Inputs stretch to useful width inside their row.
- Empty field helper text explicitly says it uses the selected template default, for example `Default: 1 vCPU`.

**Step 3: Mobile verification**

After the dev server runs, use Browser/Playwright at:

- 390 x 844
- 768 x 1024
- 1440 x 1000

Check no overlap, clipped input text, or hidden advanced controls.

---

### Task 11: Regenerate OpenAPI Clients

**Files:**
- Generated: `apps/libs/api-client/src/**`
- Generated: `apps/api-client-go/**`
- Generated: `apps/libs/runner-api-client/src/**`
- Modify callers that import old generated names.

**Step 1: Generate API specs and clients**

Run:

```bash
cd apps && yarn nx run api:openapi
cd apps && yarn generate:api-client
```

Expected: generated clients contain `TemplatesApi`, `BoxTemplate`, and artifact runner DTOs where the API spec changed.

**Step 2: Fix imports**

Run:

```bash
rg -n "EnvironmentDto|CreateSnapshot|SnapshotDto|SnapshotsApi|snapshotRef|SnapshotRunner|PullSnapshot|BuildSnapshot" apps
```

Expected: remaining matches are either core snapshot/backup compatibility or documented temporary aliases.

---

### Task 12: Local Migration Verification

**Files:**
- Migrations from Task 5
- `apps/api/src/migrations/README.md`

**Step 1: Fresh local DB**

Run:

```bash
npm run dev:dex
```

In a second shell, run:

```bash
cd apps && yarn migration:run:init
```

Expected: fresh DB starts with `box_template`, `box_template_region`, `runner_artifact_cache`, and `artifactRef`.

**Step 2: Migrated local DB**

If existing local containers have old dev data, stop app, restore old branch schema if needed, then run:

```bash
cd apps && yarn migration:run:pre-deploy
cd apps && yarn migration:run:post-deploy
```

Expected: existing template rows survive, artifact refs survive, runner cache rows survive.

**Step 3: Revert smoke**

Run on a disposable DB only:

```bash
cd apps && yarn migration:revert
```

Expected: down migration restores old names without dropping data.

---

### Task 13: Local Functional Verification

**Files:**
- All modified files.

**Step 1: Focused tests**

Run:

```bash
make lint:apps
make build:apps
cd apps && yarn nx test api --runTestsByPath src/boxlite-rest/mappers/sandbox-to-box.mapper.spec.ts
cd apps && yarn nx test api --runTestsByPath src/sandbox/constants/system-templates.spec.ts
```

Expected: pass.

**Step 2: Runner and artifact tests**

Run:

```bash
make test:unit:go
make test:unit:rust
```

Expected: pass or only documented baseline failures that were reproduced before code changes.

**Step 3: Local browser E2E**

Run:

```bash
npm run e2e:local
```

Use Dex login:

```text
admin@boxlite.dev / password
```

Verify:

- templates list loads.
- Create Box selector uses `Template`.
- Resource defaults are visible.
- CPU/memory/disk overrides can be submitted.
- created Box detail opens terminal.
- mobile viewport has no overlapping Create Box controls.

---

### Task 14: Dev Deployment And Data Verification

**Files:**
- `apps/infra/sst.config.ts`
- `apps/infra/README.md`
- deployment scripts under `scripts/deploy/`

**Step 1: Confirm dev deploy target**

Run:

```bash
cd apps/infra && npx sst diff --stage dev
```

Expected: diff matches API/Dashboard/artifact-registry changes. Runner EC2 replacement must not appear unless deliberately intended.

**Step 2: Deploy pre-deploy migration**

Use existing migration path for dev. If the deploy pipeline does not run pre-deploy automatically, run it through the API task/container or documented SST shell:

```bash
cd apps/infra && npx sst shell --stage dev
cd apps && yarn migration:run:pre-deploy
```

Expected: dev DB has renamed template/artifact tables and data.

**Step 3: Deploy services**

Run:

```bash
cd apps/infra && npx sst deploy --stage dev
```

Expected: API, Dashboard, and artifact registry update. Runner EC2 remains protected.

**Step 4: Update runner binary if runner code changed**

Use the documented runner update script, not EC2 replacement:

```bash
scripts/deploy/runner-update-binary.sh
```

Expected: runner reports the new artifact job handling.

**Step 5: Dev verification matrix**

Verify against dev:

- `GET https://dev.boxlite.ai/api/templates` returns migrated templates.
- create a new template from image or build info.
- create a Box from the new template.
- create a Box with CPU/memory/disk override.
- runner pulls/prewarms the artifact and records ready cache state.
- terminal opens and accepts commands.
- mobile Create Box layout works at 390 px width.

**Step 6: Post-deploy cleanup**

Only after dev verification is green:

```bash
cd apps/infra && npx sst shell --stage dev
cd apps && yarn migration:run:post-deploy
```

Expected: compatibility-only DB objects are removed, if any.

---

### Task 15: Final Search And Completion Audit

**Files:**
- All modified files.

**Step 1: Search forbidden active cloud names**

Run:

```bash
rg -n "Environment|environmentId|Snapshot|snapshotRef|SnapshotRunner|snapshot-manager|BuildSnapshot|PullSnapshot|RemoveSnapshot" apps/api/src apps/dashboard/src apps/runner apps/snapshot-manager apps/artifact-registry apps/infra
```

Classify every remaining match as one of:

- core snapshot/restore allowed
- backup snapshot compatibility allowed
- temporary route/payload compatibility with TODO
- bug to fix before completion

**Step 2: Search docs**

Run:

```bash
rg -n "Snapshot|Environment|snapshotRef|snapshot-manager" docs openapi apps/libs
```

Expected: docs either talk about core snapshots or the new architecture boundary.

**Step 3: Final verification**

Run the broadest feasible local suite:

```bash
make lint
make test:apps
make build:apps
```

Then repeat the dev verification matrix from Task 14.

**Step 4: Commit and push**

Run:

```bash
git status --short --branch
git add <intentional files>
git commit -m "refactor: rename templates and runtime artifacts"
git push fork codex/template-artifact-refactor
```

Expected: branch pushed with passing required verification or explicitly documented baseline-only failures.
