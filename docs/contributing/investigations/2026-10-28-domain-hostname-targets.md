## TL;DR

Identify held domains by full hostname and reserve typed App targets while preserving Box routing and organization ownership.

## Scope

This is an implementation addendum to the current domain PR. Remove the short
`name` response field throughout REST, Rust, C, Python, Node and Go. Lists display
`hostname`; unbind requires a complete hostname and addresses the exact held row,
independently of the currently configured platform suffix. Bind keeps its existing
short-label convenience and platform checks. Multiple platform-root configuration
and custom-domain onboarding remain outside this change.

The repository currently has no business App entity or lifecycle service. Reserve
App storage and expose its tagged representation, but reject App binding explicitly
until existence, organization ownership and routing can be validated. No App is
created and no App traffic is forwarded by this change. This change revises the
original domain migration and requires applying it from a fresh migration state.

## Research and alternatives

- At baseline `262c45d8148a65f50003f37320b6fac7e53f0d48`,
  `apps/api/src/box/services/domain.service.ts:129` expands bare labels using one
  configured suffix, including during unbind. `nameOf` at line 291 discards the
  suffix. Two future roots can both contain `demo`, so use the stored unique
  hostname as the externally visible identity. Keep normalization of case and one
  trailing root dot, but reject URLs, ports, empty labels and bare labels for unbind.
- `apps/api/src/box/entities/domain.entity.ts:34` and the original domain migration
  use a real Box foreign key with `ON DELETE SET NULL`. Preserve it rather than
  replacing both target identities with an unchecked generic `target_id` or JSON.
  [PostgreSQL 17 constraints, sections 5.5.1 and 5.5.5](https://www.postgresql.org/docs/17/ddl-constraints.html)
  explain that CHECK accepts NULL and cannot enforce cross-table references.
  Use explicit NULL tests in target-shape checks; retain the Box FK. App existence
  cannot be checked before its table exists, so the write API remains closed for App.
- `src/boxlite/src/runtime/domains.rs:20` already uses an internally tagged,
  non-exhaustive target enum. [Serde's internally tagged representation](https://serde.rs/enum-representations.html#internally-tagged)
  supports distinct struct variants under `type`. Extend this existing contract
  instead of adding another bind endpoint or an untyped payload.
- `apps/api/src/box/controllers/preview.controller.ts:134` composes target lookup
  and tunnel authorization. Keep that boundary; only a Box target can proceed to
  current public-port checks. Returning a stored App reference must never be
  mistaken for a Box ID.
- `apps/api/src/boxlite-rest/boxlite-rest.module.ts:30` currently registers Box
  routes before Domain routes. `DELETE /v1/domains/boxes/target` can therefore
  match the legacy Box route with prefix `domains` and Box name `target`.
  Register the Domain controller first, so its full-hostname validation handles
  invalid bare labels before any resource mutation. Keep the existing reserved
  names for bind; that rule alone cannot protect a malformed unbind request.

## Mechanism

The domain row gains `target_type` (`box` or `app`, default `box`) and a nullable
`app_id` (opaque string, at most 255 characters). Keep `box_id` and `port`.
The selected target reference determines whether the row is bound; no selected
reference means a held, unbound domain. A Box hard deletion can leave its old port
beside a null `box_id`, as today; readers ignore that port.

| Target type | Valid reference fields | Wire target |
| --- | --- | --- |
| `box` | `app_id` null; non-null `box_id` requires a valid port | `{type: "box", box: "<id>", port: 3000}` or null |
| `app` | `box_id` and `port` null; `app_id` null or nonblank | `{type: "app", app: "<id>"}` or null |

Retargeting to a Box sets its type and clears `app_id` atomically under the existing
organization lock. Unbind clears both references and port, retaining ownership and
quota usage. Box destruction touches only Box bindings. Add an App lookup index;
future App integration must add its ownership/existence checks and deletion policy.
REST and SDK target representations distinguish both variants. CLI binding remains
Box-only; listing can describe either. Unsupported App binding returns 400 with a
specific error before any Box lookup or write.

Remove `name` from generated/public C layouts together with all language adapters.
For example, list returns `demo.boxliteapp.com`; `unbind("demo")` fails, while
`unbind("demo.boxliteapp.com")` affects only that exact hostname. This intentionally
changes the unmerged domain API and C ABI; clients must rebuild/update together.
The API compatibility checker will determine any required explicit gate approval.

## Validation

Before production changes, run regression checks against baseline production:
REST list must omit `name`, bare-label unbind must fail before mutation, a held
hostname from a different configured suffix must remain independently unbindable,
and the migration must expose typed App storage. Observe assertion failures, not
compiler/setup failures. Restore all production changes and rerun the same tests.
Include a real Nest HTTP routing test using production controllers in the module's
actual registration order: canonical and prefixed DELETE requests for bare labels,
including `boxes`, must return 400 without calling Box deletion or a domain write.

Use real PostgreSQL migration and service tests for target-shape constraints,
Box/App row separation, Box hard deletion, unbind/rebind and organization isolation.
Use local HTTP servers through production SDK request code for hostname-only
responses, full-hostname DELETE paths, App target decoding and exact tagged request
bodies. Retain tunnel-policy regressions and preview rejection of App targets.
Run focused make targets for API, Rust REST/domain, CLI, SDKs and proxy; regenerate
the C header through its make build.

The focused API, Rust domain/REST, CLI, Python/Node/Go domain, C/FFI and proxy
checks passed. Real PostgreSQL checks cover the migration, typed target lifecycle
and whitespace-only App references. The compatibility inspection found no breaking
or default changes relative to the PR merge base; domain endpoints are additions.
Full apps lint remains failing in E2E and infrastructure files outside this change.
