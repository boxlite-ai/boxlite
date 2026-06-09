# Boxes Naming Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make "Box" / "Boxes" the user's product concept across the dashboard, browser routes, visible permission labels, visible webhook labels, and onboarding/playground copy, while keeping existing Sandbox internals as the implementation language.

**Architecture:** Treat `Sandbox` as the current implementation/storage/API name and introduce `Box` at the dashboard/user boundary. Make `/dashboard/boxes` canonical, redirect legacy `/dashboard/sandboxes...` URLs, and update visible copy. Keep generated clients, backend controllers, event values, permission enum values, hook names, and route params as `sandbox` for compatibility and lower risk.

**Approved scope update:** After risk review, the safer implementation is external `Box`, internal `sandbox`. Backend/public API facades, generated client renames, event value renames, and permission enum renames are deferred until there is a separate reason to expose those as customer-facing contracts.

**Tech Stack:** React + React Router + TanStack Query dashboard, NestJS API, TypeORM/Postgres enum migrations for permission aliases, OpenAPI Generator TypeScript client, Socket.IO-style notification events, Nx/Yarn under `apps/`, repo-level Make targets for build/lint/test.

---

## Risk Assessment

Overall risk is **low to medium if staged**, and **high if implemented as a deep rename in one pass**.

The low-risk path is safe because there are no production users, but the codebase has generated clients, OpenAPI operation names, permissions, webhook/event strings, and database enum values. A half-rename can compile but still break dashboard navigation, API-key permissions, webhooks, cache invalidation, or generated client imports.

Do **not** start with a database/entity/module rename. Keep these internal names for now:

- `apps/api/src/sandbox/**`
- `SandboxService`, `SandboxRepository`, `Sandbox` TypeORM entity
- existing migration history containing `sandbox`
- runner API paths that already speak `/sandboxes`
- low-level security terms such as OS sandboxing, `sandbox-exec`, seccomp, jailer sandbox modules

The user-facing dashboard boundary should become Box:

- dashboard URL and navigation
- page titles, buttons, empty states, toasts, dialogs, command palette labels
- permissions shown to users
- webhook/event names shown to users
- onboarding and playground prose/snippet variable names where possible without SDK API changes

Current important references:

- Canonical product story already says Boxes: `README.md:14`
- Box OpenAPI already uses `/boxes`: `openapi/box.openapi.yaml:18`, `openapi/box.openapi.yaml:183`
- Dashboard still routes to Sandboxes: `apps/dashboard/src/enums/RoutePath.ts:21`
- Dashboard sidebar still says Sandboxes: `apps/dashboard/src/components/Sidebar.tsx:101`
- Cloud API still exposes `@Controller('sandbox')`: `apps/api/src/sandbox/controllers/sandbox.controller.ts:85`
- Dashboard currently uses generated `SandboxApi`: `apps/dashboard/src/api/apiClient.ts:22`
- Events still use `sandbox.created`: `apps/api/src/sandbox/constants/sandbox-events.constants.ts:7`
- Permissions still use `write:sandboxes`: `apps/api/src/organization/enums/organization-resource-permission.enum.ts:19`

There is an existing dirty file unrelated to this plan:

- `apps/dashboard/src/assets/Logo.tsx`

Do not touch or revert it.

## Success Criteria

- Visiting `https://dev.boxlite.ai/dashboard/boxes` is the canonical dashboard list route.
- Visiting old `/dashboard/sandboxes`, `/dashboard/sandboxes/:id`, `/terminal`, and `/vnc` redirects to the matching `/dashboard/boxes...` path.
- A new user sees only "Box" / "Boxes" in dashboard UI for the product object.
- Existing backend behavior is unchanged for create/start/stop/delete/archive/recover/resize.
- Existing generated dashboard client/API/event/permission values remain unchanged internally.
- `rg` checks show no accidental user-facing `Sandbox`/`Sandboxes` leftovers, excluding approved internal/compatibility paths.

## Out of Scope

- Renaming TypeORM tables or historical migrations from sandbox to box.
- Renaming runner internal `/sandboxes` APIs.
- Renaming low-level security sandbox terminology.
- Renaming backend controllers, generated API clients, SDK exported type names, event values, or permission enum values.
- Renaming route param names from `sandboxId` to `boxId`; URLs are user-facing, params are implementation details.
- Removing compatibility aliases before the dev environment has been verified with the new names.

## Deferred Tasks

Tasks 3-7 below are kept as future notes only. They are intentionally not part of the approved safe pass because they cross backend/API/permission/event compatibility boundaries.

---

### Task 1: Dashboard Canonical Routes

**Files:**

- Modify: `apps/dashboard/src/enums/RoutePath.ts`
- Modify: `apps/dashboard/src/App.tsx`
- Modify: `apps/dashboard/src/components/Sidebar.tsx`
- Modify: `apps/dashboard/src/components/Sandbox/CreateSandboxSheet.tsx`
- Modify: `apps/dashboard/src/components/SandboxDetailsSheet.tsx`
- Modify: `apps/dashboard/src/components/SandboxTable/SandboxTableActions.tsx`
- Modify: `apps/dashboard/src/components/sandboxes/SandboxDetails.tsx`
- Modify: `apps/dashboard/src/components/sandboxes/SandboxFullscreenShell.tsx`
- Modify: `apps/dashboard/src/components/sandboxes/SandboxTerminalFullscreen.tsx`
- Modify: `apps/dashboard/src/components/sandboxes/SandboxTerminalTab.tsx`
- Modify: `apps/dashboard/src/components/sandboxes/SandboxVncFullscreen.tsx`
- Modify: `apps/dashboard/src/components/sandboxes/SandboxVncTab.tsx`

**Step 1: Add canonical Box route constants**

In `RoutePath.ts`, add Box routes and keep legacy Sandbox routes:

```ts
BOXES = '/dashboard/boxes',
BOX_DETAILS = '/dashboard/boxes/:boxId',
BOX_TERMINAL = '/dashboard/boxes/:boxId/terminal',
BOX_VNC = '/dashboard/boxes/:boxId/vnc',

LEGACY_SANDBOXES = '/dashboard/sandboxes',
LEGACY_SANDBOX_DETAILS = '/dashboard/sandboxes/:sandboxId',
LEGACY_SANDBOX_TERMINAL = '/dashboard/sandboxes/:sandboxId/terminal',
LEGACY_SANDBOX_VNC = '/dashboard/sandboxes/:sandboxId/vnc',
```

Keep old `SANDBOXES` aliases temporarily only if too many imports would churn in this task. If aliases remain, point them to the new Box paths, not the old `/sandboxes` paths.

**Step 2: Add redirect routes**

In `App.tsx`, make the dashboard index redirect to `RoutePath.BOXES`.

Add legacy redirects:

```tsx
<Route path={getRouteSubPath(RoutePath.LEGACY_SANDBOXES)} element={<Navigate to={`${getRouteSubPath(RoutePath.BOXES)}${location.search}`} replace />} />
<Route path={getRouteSubPath(RoutePath.LEGACY_SANDBOX_DETAILS)} element={<Navigate to={legacyBoxPath('details')} replace />} />
<Route path={getRouteSubPath(RoutePath.LEGACY_SANDBOX_TERMINAL)} element={<Navigate to={legacyBoxPath('terminal')} replace />} />
<Route path={getRouteSubPath(RoutePath.LEGACY_SANDBOX_VNC)} element={<Navigate to={legacyBoxPath('vnc')} replace />} />
```

Implement the small helper in `App.tsx` with `useParams` via tiny redirect components, not by parsing `window.location`.

**Step 3: Update navigation call sites**

Replace product navigation to use `RoutePath.BOXES`, `RoutePath.BOX_DETAILS`, `RoutePath.BOX_TERMINAL`, and `RoutePath.BOX_VNC`.

Keep route param name conversion local: existing data still has `sandbox.id`; route param can become `boxId`. Details components should read `boxId` first and fall back to `sandboxId` only inside legacy redirect code if needed.

**Step 4: Verify with route grep**

Run:

```bash
rg -n '/dashboard/sandboxes|RoutePath\.SANDBOX' apps/dashboard/src
```

Expected: only legacy redirect constants/routes remain.

**Step 5: Commit**

```bash
git add apps/dashboard/src/enums/RoutePath.ts apps/dashboard/src/App.tsx apps/dashboard/src/components/Sidebar.tsx apps/dashboard/src/components/Sandbox/CreateSandboxSheet.tsx apps/dashboard/src/components/SandboxDetailsSheet.tsx apps/dashboard/src/components/SandboxTable/SandboxTableActions.tsx apps/dashboard/src/components/sandboxes
git commit -m "feat(dashboard): make boxes the canonical dashboard route"
```

---

### Task 2: Dashboard User-Facing Copy

**Files:**

- Modify: `apps/dashboard/src/pages/Sandboxes.tsx`
- Modify: `apps/dashboard/src/components/Sandbox/CreateSandboxSheet.tsx`
- Modify: `apps/dashboard/src/components/SandboxDetailsSheet.tsx`
- Modify: `apps/dashboard/src/components/SandboxTable/BulkActionAlertDialog.tsx`
- Modify: `apps/dashboard/src/components/SandboxTable/SandboxTableHeader.tsx`
- Modify: `apps/dashboard/src/components/SandboxTable/index.tsx`
- Modify: `apps/dashboard/src/components/SandboxTable/useSandboxCommands.tsx`
- Modify: `apps/dashboard/src/components/sandboxes/*.tsx`
- Modify: `apps/dashboard/src/pages/Onboarding.tsx`
- Modify: `apps/dashboard/src/pages/Limits.tsx`
- Modify: `apps/dashboard/src/pages/Runners.tsx`
- Modify: `apps/dashboard/src/pages/OrganizationSettings.tsx`
- Modify: `apps/dashboard/src/pages/Spending.tsx`
- Modify: `apps/dashboard/src/components/CreateApiKeyDialog.tsx`
- Modify: `apps/dashboard/src/components/ApiKeyTable.tsx`
- Modify: `apps/dashboard/src/constants/CreateApiKeyPermissionsGroups.ts`
- Modify: `apps/dashboard/src/constants/OrganizationPermissionsGroups.ts`
- Modify: `apps/dashboard/src/constants/webhook-events.ts`
- Modify: `apps/dashboard/src/components/RunnerDetailsSheet.tsx`
- Modify: `apps/dashboard/src/components/RunnerTable.tsx`
- Modify: `apps/dashboard/src/components/RegionTable.tsx`
- Modify: `apps/dashboard/src/components/RegistryTable.tsx`
- Modify: `apps/dashboard/src/components/VolumeTable.tsx`
- Modify: `apps/dashboard/src/components/snapshots/**/*.tsx`

**Step 1: Replace user-visible nouns**

Use these copy rules:

- `Sandbox` -> `Box`
- `Sandboxes` -> `Boxes`
- `sandbox` -> `box`
- `sandboxes` -> `boxes`

Do this only for rendered text, aria labels, titles, toast messages, dialog copy, email subjects/body text, and empty states.

Do not change generated enum names or permission enum identifiers in this task.

Examples:

```tsx
<PageTitle>Boxes</PageTitle>
toast.success('Box created')
handleApiError(error, 'Failed to create box')
```

**Step 2: Keep API identifiers stable**

Variables may still be named `sandbox` during this task if they are typed as generated `Sandbox`. Avoid a risky mechanical rename that mixes copy changes with API/client changes.

**Step 3: Verify user-facing grep**

Run:

```bash
rg -n "'[^']*Sandbox|\"[^\"]*Sandbox|>[^<]*Sandbox|aria-label=\"[^\"]*sandbox|title=\"[^\"]*Sandbox" apps/dashboard/src
```

Expected: no user-visible product labels remain, except approved compatibility text in developer-facing API snippets if still intentionally showing old API.

**Step 4: Commit**

```bash
git add apps/dashboard/src
git commit -m "feat(dashboard): rename sandbox copy to boxes"
```

---

### Task 3: Dashboard Box Facade Naming

**Files:**

- Create: `apps/dashboard/src/api/boxApi.ts`
- Create: `apps/dashboard/src/hooks/useBoxes.ts`
- Create: `apps/dashboard/src/hooks/useBoxLogs.ts`
- Create: `apps/dashboard/src/hooks/useBoxMetrics.ts`
- Create: `apps/dashboard/src/hooks/useBoxTraces.ts`
- Create: `apps/dashboard/src/hooks/useBoxTraceSpans.ts`
- Modify: `apps/dashboard/src/api/apiClient.ts`
- Modify: `apps/dashboard/src/pages/Sandboxes.tsx`
- Modify: `apps/dashboard/src/components/SandboxTable/types.ts`
- Modify: `apps/dashboard/src/components/SandboxTable/useSandboxTable.ts`
- Modify: `apps/dashboard/src/hooks/mutations/*.ts`

**Step 1: Create a dashboard-local Box API adapter**

Create `boxApi.ts` that wraps generated `SandboxApi` without changing wire behavior:

```ts
import type { SandboxApi } from '@boxlite-ai/api-client'

export class BoxApi {
  constructor(private readonly sandboxApi: SandboxApi) {}

  listBoxesPaginated(...args: Parameters<SandboxApi['listSandboxesPaginated']>) {
    return this.sandboxApi.listSandboxesPaginated(...args)
  }

  getBox(...args: Parameters<SandboxApi['getSandbox']>) {
    return this.sandboxApi.getSandbox(...args)
  }

  createBox(...args: Parameters<SandboxApi['createSandbox']>) {
    return this.sandboxApi.createSandbox(...args)
  }

  startBox(...args: Parameters<SandboxApi['startSandbox']>) {
    return this.sandboxApi.startSandbox(...args)
  }

  stopBox(...args: Parameters<SandboxApi['stopSandbox']>) {
    return this.sandboxApi.stopSandbox(...args)
  }

  deleteBox(...args: Parameters<SandboxApi['deleteSandbox']>) {
    return this.sandboxApi.deleteSandbox(...args)
  }
}
```

Add more delegated methods only as call sites need them. Do not pre-wrap every generated method.

**Step 2: Expose `boxApi` from `ApiClient`**

In `apiClient.ts`, keep `_sandboxApi` private and add `_boxApi = new BoxApi(this._sandboxApi)`. Existing code can migrate gradually.

**Step 3: Rename hooks at the dashboard boundary**

Create Box-named hooks by moving logic from `useSandboxes.ts`. Keep exported compatibility aliases for one task:

```ts
export const getBoxesQueryKey = (...)
export function useBoxes(...)

export const getSandboxesQueryKey = getBoxesQueryKey
export const useSandboxes = useBoxes
```

The query key should become `['boxes', organizationId]`. During the same task, update all call sites to use the Box names.

**Step 4: Verify dashboard code grep**

Run:

```bash
rg -n 'useSandboxes|getSandboxesQueryKey|sandboxApi|Sandboxes Data|Sandbox Action' apps/dashboard/src
```

Expected: only compatibility aliases and generated type references remain.

**Step 5: Commit**

```bash
git add apps/dashboard/src/api apps/dashboard/src/hooks apps/dashboard/src/pages apps/dashboard/src/components
git commit -m "refactor(dashboard): introduce box-facing API hooks"
```

---

### Task 4: Backend Box Controller Facade

**Files:**

- Create: `apps/api/src/sandbox/controllers/box.controller.ts`
- Create: `apps/api/src/sandbox/dto/box.dto.ts`
- Create: `apps/api/src/sandbox/dto/create-box-dashboard.dto.ts`
- Create: `apps/api/src/sandbox/dto/list-boxes-query.dto.ts`
- Create: `apps/api/src/sandbox/dto/paginated-boxes.dto.ts`
- Create: `apps/api/src/sandbox/dto/resize-box.dto.ts`
- Modify: `apps/api/src/sandbox/sandbox.module.ts`
- Test: `apps/api/src/sandbox/controllers/box.controller.spec.ts`

**Step 1: Write controller spec first**

Create a focused Jest spec that constructs `BoxController` with mocked `SandboxService` and verifies:

- `listBoxesPaginated` delegates to `sandboxService.findAll`
- `createBox` delegates to the same create path as `createSandbox`
- returned payload is Box-shaped and does not expose a top-level `sandbox` key

Run:

```bash
cd apps && yarn nx run api:test -- box.controller.spec.ts
```

Expected before implementation: FAIL because `BoxController` does not exist.

**Step 2: Add Box DTO schemas**

Use Box schema names, not DashboardBox:

```ts
@ApiSchema({ name: 'Box' })
export class BoxDto extends SandboxDto {}

@ApiSchema({ name: 'CreateBox' })
export class CreateBoxDashboardDto extends CreateSandboxDto {}

@ApiSchema({ name: 'ListBoxesQuery' })
export class ListBoxesQueryDto extends ListSandboxesQueryDto {}

@ApiSchema({ name: 'PaginatedBoxes' })
export class PaginatedBoxesDto {
  @ApiProperty({ type: [BoxDto] })
  items: BoxDto[]

  @ApiProperty()
  total: number

  @ApiProperty()
  page: number

  @ApiProperty()
  totalPages: number
}
```

Avoid naming the class `CreateBoxDto` because `apps/api/src/boxlite-rest/dto/create-box.dto.ts` already uses that class name for the separate `/api/v1/:prefix/boxes` REST contract.

**Step 3: Add `BoxController`**

Use `@Controller('boxes')` and `@ApiTags('boxes')`. Mirror dashboard-needed methods from `SandboxController`:

- `GET /boxes`
- `GET /boxes/paginated`
- `POST /boxes`
- `GET /boxes/:boxIdOrName`
- `DELETE /boxes/:boxIdOrName`
- `POST /boxes/:boxIdOrName/start`
- `POST /boxes/:boxIdOrName/stop`
- `POST /boxes/:boxIdOrName/recover`
- `POST /boxes/:boxIdOrName/archive`
- `POST /boxes/:boxIdOrName/resize`
- label, SSH, preview, telemetry endpoints only if dashboard still calls them directly

Internally call `SandboxService`. Do not duplicate business logic.

**Step 4: Register controller**

Add `BoxController` to `SandboxModule.controllers`, next to `SandboxController`.

**Step 5: Run focused API test**

Run:

```bash
cd apps && yarn nx run api:test -- box.controller.spec.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/api/src/sandbox/controllers/box.controller.ts apps/api/src/sandbox/controllers/box.controller.spec.ts apps/api/src/sandbox/dto/box.dto.ts apps/api/src/sandbox/dto/create-box-dashboard.dto.ts apps/api/src/sandbox/dto/list-boxes-query.dto.ts apps/api/src/sandbox/dto/paginated-boxes.dto.ts apps/api/src/sandbox/dto/resize-box.dto.ts apps/api/src/sandbox/sandbox.module.ts
git commit -m "feat(api): add boxes controller facade"
```

---

### Task 5: Generated API Client Migration

**Files:**

- Generated: `apps/libs/api-client/src/**`
- Modify: `apps/dashboard/src/api/boxApi.ts`
- Modify: `apps/dashboard/src/api/apiClient.ts`
- Modify: `apps/dashboard/src/hooks/useBoxes.ts`
- Modify: dashboard mutation hooks that still call delegated sandbox methods

**Step 1: Generate OpenAPI and client**

There is no top-level Make target for API-client generation. Use the existing apps workspace target:

```bash
cd apps && yarn nx run api:openapi
cd apps && yarn nx run api-client:generate:api-client
```

Expected:

- `apps/libs/api-client/src/api/boxes-api.ts` or equivalent tag-generated Box API appears.
- `apps/libs/api-client/src/models/box.ts`, `create-box.ts`, and `paginated-boxes.ts` appear.
- Existing `sandbox-api.ts` remains unless the old controller is removed.

Do not manually edit generated files.

**Step 2: Replace dashboard adapter internals**

Update `boxApi.ts` to use generated `BoxesApi` directly. Keep its public methods as `getBox`, `createBox`, etc.

**Step 3: Replace dashboard generated types**

Update dashboard imports:

- `Sandbox` -> `Box`
- `PaginatedSandboxes` -> `PaginatedBoxes`
- `CreateSandbox` -> `CreateBox`

Keep internal variables named `sandbox` only where they are still dealing with legacy events or compatibility adapters.

**Step 4: Verify no direct dashboard `SandboxApi` dependency**

Run:

```bash
rg -n 'SandboxApi|sandboxApi|PaginatedSandboxes|CreateSandbox|ListSandboxes' apps/dashboard/src
```

Expected: no direct dashboard dependency on generated sandbox API/types, except explicitly documented compatibility code.

**Step 5: Commit**

```bash
git add apps/libs/api-client/src apps/dashboard/src
git commit -m "refactor(dashboard): use generated boxes api client"
```

---

### Task 6: Events and Webhooks Compatibility

**Files:**

- Modify: `apps/api/src/sandbox/constants/sandbox-events.constants.ts`
- Modify: `apps/api/src/notification/services/notification.service.ts`
- Modify: `apps/api/src/webhook/constants/webhook-events.constants.ts`
- Modify: `apps/api/src/webhook/dto/webhook-event-payloads.dto.ts`
- Modify: `apps/api/src/webhook/services/webhook-event-handler.service.ts`
- Modify: `apps/dashboard/src/constants/webhook-events.ts`
- Modify: `apps/dashboard/src/pages/Sandboxes.tsx`
- Modify: `apps/dashboard/src/hooks/useSandboxWsSync.ts`
- Test: add/update focused webhook or notification specs if nearby patterns exist

**Step 1: Add Box event constants**

Add `BoxEvents`:

```ts
export const BoxEvents = {
  ARCHIVED: 'box.archived',
  STATE_UPDATED: 'box.state.updated',
  DESIRED_STATE_UPDATED: 'box.desired-state.updated',
  CREATED: 'box.created',
  STARTED: 'box.started',
  STOPPED: 'box.stopped',
  DESTROYED: 'box.destroyed',
  PUBLIC_STATUS_UPDATED: 'box.public-status.updated',
  ORGANIZATION_UPDATED: 'box.organization.updated',
  BACKUP_CREATED: 'box.backup.created',
} as const
```

Keep `SandboxEvents` as aliases or legacy constants.

**Step 2: Dual-emit notifications**

Where the app currently emits `sandbox.*`, emit both `box.*` and `sandbox.*` with the same payload during the dev transition.

**Step 3: Update dashboard subscriptions**

Listen to `box.created`, `box.state.updated`, and `box.desired-state.updated`. Optionally keep `sandbox.*` listeners for compatibility until all emitters are verified.

**Step 4: Update webhook UI labels**

In dashboard, display "Box Created" and category "Box". If the persisted event value is still `sandbox.created`, show the Box label but keep value stable until backend accepts `box.created`.

**Step 5: Commit**

```bash
git add apps/api/src apps/dashboard/src
git commit -m "feat(api): add box events with sandbox compatibility"
```

---

### Task 7: Permissions Compatibility

**Files:**

- Modify: `apps/api/src/organization/enums/organization-resource-permission.enum.ts`
- Create: new migration under `apps/api/src/migrations/pre-deploy/`
- Create: new migration under `apps/api/src/migrations/post-deploy/` only if needed by existing migration pattern
- Modify: `apps/api/src/organization/constants/global-organization-roles.constant.ts`
- Modify: role bootstrap/seed migrations or services that assign global roles
- Modify: `apps/dashboard/src/constants/CreateApiKeyPermissionsGroups.ts`
- Modify: `apps/dashboard/src/constants/OrganizationPermissionsGroups.ts`
- Modify: `apps/dashboard/src/components/CreateApiKeyDialog.tsx`
- Modify: `apps/dashboard/src/components/ApiKeyTable.tsx`
- Modify: dashboard permission checks around create/start/delete

**Step 1: Decide permission strategy**

Recommended for lowest risk:

- Add `write:boxes` and `delete:boxes`
- Keep `write:sandboxes` and `delete:sandboxes`
- Treat either Box or Sandbox permission as sufficient during transition
- New API keys/roles should receive Box permissions
- Existing dev data can be migrated from Sandbox to Box once the UI is verified

**Step 2: Add enum values and migration**

Postgres enum migrations must add values, not rewrite migration history. Existing historical migrations stay untouched.

**Step 3: Add permission helper**

Create a helper in API authorization code:

```ts
const BOX_WRITE_PERMISSIONS = [
  OrganizationResourcePermission.WRITE_BOXES,
  OrganizationResourcePermission.WRITE_SANDBOXES,
]
```

Use helpers at controller boundaries so both old and new permissions work.

**Step 4: Update dashboard permission UI**

User-facing labels become Boxes. New API key defaults should select Box permissions when available.

**Step 5: Commit**

```bash
git add apps/api/src apps/dashboard/src
git commit -m "feat(api): add box permissions with sandbox compatibility"
```

---

### Task 8: File and Component Rename Cleanup

**Files:**

- Move: `apps/dashboard/src/pages/Sandboxes.tsx` -> `apps/dashboard/src/pages/Boxes.tsx`
- Move: `apps/dashboard/src/components/Sandbox/` -> `apps/dashboard/src/components/Box/`
- Move: `apps/dashboard/src/components/SandboxTable/` -> `apps/dashboard/src/components/BoxTable/`
- Move: `apps/dashboard/src/components/sandboxes/` -> `apps/dashboard/src/components/boxes/`
- Move: `apps/dashboard/src/types/sandbox.ts` -> `apps/dashboard/src/types/box.ts`
- Move: Box-facing hooks/mutations from Sandbox names to Box names

**Step 1: Rename files using `git mv`**

Use `git mv` for each directory/file so review is readable.

**Step 2: Update imports**

Use `rg` to find stale imports:

```bash
rg -n '@/components/Sandbox|@/components/SandboxTable|components/sandboxes|pages/Sandboxes|types/sandbox' apps/dashboard/src
```

Expected: no stale imports.

**Step 3: Keep compatibility aliases only where helpful**

Avoid exporting both `BoxTable` and `SandboxTable` unless a file still needs it. The dashboard should be Box-facing after this task.

**Step 4: Commit**

```bash
git add apps/dashboard/src
git commit -m "refactor(dashboard): rename sandbox components to boxes"
```

---

### Task 9: Verification

**Files:**

- No source files unless verification exposes an issue.

**Step 1: Static grep checks**

Run:

```bash
rg -n 'Sandboxes|Sandbox|sandboxes|sandbox' apps/dashboard/src
```

Expected: only approved compatibility/generated/internal references remain.

Run:

```bash
rg -n '@Controller\\(' apps/api/src | rg 'sandbox|boxes'
```

Expected: both `sandbox` legacy and `boxes` canonical controllers exist.

**Step 2: Format check**

Run:

```bash
make fmt:check:apps
```

Expected: PASS.

**Step 3: Lint**

Run:

```bash
make lint:apps
```

Expected: PASS.

**Step 4: Build**

Run:

```bash
make build:apps
```

Expected: PASS.

**Step 5: Manual dashboard smoke**

Start the app using the repo's existing dev flow, then check:

- `/dashboard/boxes` loads.
- `/dashboard/sandboxes` redirects to `/dashboard/boxes`.
- Create Box opens a terminal route under `/dashboard/boxes/:boxId`.
- Start/stop/delete/archive/recover actions still call the API successfully.
- Webhook UI shows Box category and labels.
- API-key UI shows Boxes permissions.

**Step 6: Commit verification fixes only if needed**

```bash
git add <changed-files>
git commit -m "fix: complete boxes rename verification"
```

---

## Recommended Execution Order

For lowest risk, ship in this order:

1. Task 1 + Task 2: immediate user mental model win, minimal protocol risk.
2. Task 3: dashboard code starts speaking Box without backend protocol changes.
3. Task 4 + Task 5: backend and generated client expose canonical Box API.
4. Task 6 + Task 7: events and permissions become Box-compatible.
5. Task 8: cleanup code names after behavior is stable.
6. Task 9: full verification.

If speed matters more than review granularity, combine Tasks 1-3 into one frontend PR and Tasks 4-7 into one API PR. Do not combine Task 8 with the protocol work; rename-only churn makes real regressions harder to see.
