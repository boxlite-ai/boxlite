# ADR: Template, Artifact, And Snapshot Naming

## Status

Accepted for pre-launch refactor.

## Context

The cloud control plane currently uses `Snapshot` for multiple meanings:

- a user-selectable thing used when creating a Box
- metadata and default resources around that selectable thing
- a pullable registry ref used by runners
- a per-runner cache/prewarm state

BoxLite core also has a real snapshot capability for Box state snapshot/restore. Keeping the current cloud naming would make future `Snapshot` work ambiguous and would force engineers to inspect context before knowing whether code is talking about product templates, registry artifacts, runner cache, or state snapshots.

There are no production users yet, so this is the best time to do a deeper rename. Dev data still exists and must be migrated deliberately.

## Decision

Use this naming model:

- `BoxTemplate` for the product/API/domain concept that users select when creating a Box.
- `Template` as the short Dashboard label.
- `RuntimeArtifact` and `artifactRef` for registry-backed startup material.
- `RunnerArtifactCache` for per-runner artifact pull/build/cache state.
- `BoxSnapshot` for a future cloud/user Box-state snapshot feature.
- `Snapshot` remains valid only in BoxLite core where it means state snapshot/restore.

The refactor should remove cloud control-plane `Snapshot`/`Environment` naming from active product code before launch, while preserving compatibility shims where needed for dev deployment and temporary clients.

## Consequences

Positive:

- Engineers can tell which layer they are reading from names alone.
- Future Box snapshot work will not collide with template/artifact code.
- Create Box can naturally show template default resources and resource overrides.
- Runner prewarm/cache concepts become artifact cache concepts instead of template concepts.

Costs:

- Touches API controllers, DTOs, services, entities, migrations, generated clients, Dashboard hooks, runner DTOs, infra service names, and docs.
- Requires dev database migration and dev deployment verification.
- Generated OpenAPI clients and SDK wrappers need regeneration or manual sync.

## Non-Goals

- Do not rename BoxLite core snapshot APIs or tests.
- Do not rewrite old historical migrations just to change old names.
- Do not introduce a second permanent abstraction if a direct pre-launch rename is enough.
- Do not make `Image` the primary user-facing concept for Create Box.

## Verification

The refactor is only complete when all of these are true:

- API exposes templates for listing and creating the objects used to create Boxes.
- Create Box accepts a template plus optional CPU/memory/disk resource overrides.
- Database migration preserves existing dev templates, artifact refs, runner cache rows, and Box creation data.
- Runner can build/pull/prewarm runtime artifacts and create Boxes from artifact refs.
- Dashboard lists templates, creates a template, creates a Box, shows template defaults, applies overrides, and works on mobile.
- Dev deployment proves templates list, create template, create Box, resource override, artifact pull/prewarm, and terminal usability.
