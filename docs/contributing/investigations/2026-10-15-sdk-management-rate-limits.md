## TL;DR

SDK image and registry management routes omit the organization rate-limit guard. Reuse the console guard so both API surfaces consume the same quota and reject excess requests before service work.

## Scope

- Cover every handler and canonical, legacy-default, and organization-prefixed route on `BoxliteImageController` and `BoxliteRegistryController`.
- Preserve authentication, resource permissions, response shapes, and organization-specific limits.
- Leave credential-deletion concurrency and other SDK controllers outside this stack fix.
- Acceptance: excess requests return HTTP 429 without invoking catalog or credential services; another organization retains its own quota.

## Related work and lessons

- [NestJS guard binding](https://docs.nestjs.com/guards#binding-guards) applies a controller guard to every handler. Reuse that boundary instead of duplicating checks in services or handlers.
- [NestJS throttler customization](https://docs.nestjs.com/security/rate-limiting#customization) supports custom tracking and keys. BoxLite already implements both in `apps/api/src/common/guards/authenticated-rate-limit.guard.ts`: `getTracker` uses a verified organization, and `generateKey` omits the route so counters are shared.
- At stack head `66e2aecb5fec302efa9315ff3f6bb2c1245cff5e`, console controllers `apps/api/src/image/controllers/image.controller.ts:42` and `apps/api/src/registry/controllers/registries.controller.ts:25` run authentication, organization authorization, then `AuthenticatedRateLimitGuard`. SDK controllers `apps/api/src/boxlite-rest/boxlite-image.controller.ts:68` and `boxlite-registry.controller.ts:40` omit the last guard.
- `OrganizationAccessGuard` attaches the verified organization before the rate limiter selects its counter and custom limits. Running the limiter earlier would select a user fallback for JWT callers.
- A new limiter or a global guard would duplicate policy or change unrelated routes. No change leaves SDK callers able to bypass the console quota, including before registry secret writes. Adding the existing guard at the two controller boundaries is sufficient.

## How it works

Append `AuthenticatedRateLimitGuard` after `OrganizationResourceActionGuard` on both SDK controllers. The shared guard keeps existing Redis storage, per-organization overrides, response headers, and HTTP 429 behavior. No new dependencies, configuration, or service changes are required; production additions should stay below 20 lines.

Document the shared quota in `apps/API.md`. Existing routing-only tests may replace the added guard with a permissive fixture; a separate HTTP suite must exercise the real rate limiter and organization authorization guard.

## Validation

| Claim | Planned check | Expected result |
| --- | --- | --- |
| SDK callers cannot evade an exhausted console quota | Exhaust a two-request organization limit using console requests from different users, then call every SDK image/registry operation in all three path forms | HTTP 429 and no additional service call |
| SDK requests consume the same quota | Call SDK images and registries, then the console; request again as another organization | Console gets 429; the other organization succeeds |
| Authorization runs before throttling | Use the real organization guard and a custom organization limit lower than the default | Different users share the custom organization counter |
| The tests detect this defect | Run with every non-test file restored, then apply both controller changes and rerun | Original handlers return successful responses where 429 was expected; fixed handlers pass |

The HTTP suite uses real controllers, organization authorization, and `AuthenticatedRateLimitGuard`, with in-memory throttler storage and mocked authentication and service persistence. It does not test distributed Redis behavior or perform live Secret Manager writes.

Observed: with all non-test changes removed, all 25 regression cases failed because requests returned 200, 201, or 204 instead of 429. Restoring the fix passed all 25 cases; the focused API run passed 87 tests across six suites. The named throttler emits `Retry-After-authenticated`, which the HTTP tests also verify. The coverage command exited successfully but could not instrument the unchanged `tracing.ts` because its existing TypeScript configuration cannot resolve the OpenTelemetry incubating export. Full-workspace lint and formatting checks also reported errors in unchanged infrastructure and generated client files.

Tracking context: https://github.com/boxlite-ai/boxlite/issues/1948
