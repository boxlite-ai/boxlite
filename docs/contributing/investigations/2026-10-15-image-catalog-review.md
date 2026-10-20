## TL;DR

Correct the three CodeRabbit findings on #1951: preserve untagged registry ports in E2E references, make the removal warning conditional, and hide tags whose versions are not ready.

## Scope and evidence

All three remain present at `7e41ef35` and in #1951's current head `c86d4d401207d405186361f29ddfa9e4ca9385d3`.

- `apps/e2e/cases/test_images_catalog.py` removes everything after the final colon, including `:5000/acme/app` in an untagged reference. Strip a digest first and treat a colon as a tag separator only after the final slash. This is the same host-versus-tag distinction used by `apps/api/src/image/utils/image-ref.util.ts`.
- `apps/dashboard/src/pages/Images.tsx` says deletion will always be refused. `ImageCatalogService.assertNoBoxUsing` refuses only when a non-destroyed dependent box exists. State that condition directly.
- `ImageCatalogService.versionsByImage` and `ImageResolverService.resolveByTag` filter READY versions; `tagsByImage` does not. List and detail can advertise tags absent from their bootable versions. Join the version table when selecting tags, retaining organization/image filtering and alphabetical ordering.

## How it works

Keep the fixes at their existing boundaries. Put repository-name parsing beside the E2E image helpers and use it for catalog reference constants. Keep the dashboard change to its warning. Filter tags in the shared catalog read helper so list and detail agree without changing stored tags or history. SDK listReferences already rejects non-ready versions and needs no change.

A generic OCI parser dependency is unnecessary for stripping tag/digest suffixes. Filtering stored tags destructively would lose history and is rejected. Estimated additions are below 50 production lines.

## Validation

- Before the parsing fix, execute the catalog module's existing reference-constant setup in a test namespace with `registry.local:5000/acme/app`; assert the computed repository and unpullable image retain the host port. Parameterize tagged, digest-pinned, and ordinary references as additional assertions in the same regression.
- Before the query fix, register ready image versions through the real registrar, mark one DELETED, and assert list/detail expose only ready tags in sorted order. Also verify all-deleted versions yield no tags and the SDK view stays consistent.
- Keep non-test files at the previous commit for the failing run, then restore the fixes and rerun PostgreSQL integration tests and E2E helper unit tests.
- Exercise the existing Images page tests for the warning edit; no test should merely mirror the new sentence.

Tracking context: https://github.com/boxlite-ai/boxlite/issues/1948

Observed: the original parser failed the untagged port and digest-pinned port cases, and the original catalog query exposed the removed version's tag. Both regressions pass after the fixes. The PostgreSQL catalog suite passed 36 tests; the selected dashboard suites passed 20 tests. Scoped TypeScript lint passed. No live-VM E2E run was performed for these parsing and presentation changes.
