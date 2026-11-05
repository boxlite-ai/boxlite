# Dashboard creation after a startup timeout

## TL;DR

Keep the created Box's identity in startup timeout responses so the dashboard can open its details and follow startup without repeating creation.

## Problem

At base `3f8e7d2d`, `BoxliteBoxController.createBox` persists a Box before waiting up to 30 seconds for `STARTED`.
`BoxStateWaiterService.timedOut` returns HTTP 408 while the Box continues starting, including while an image is being pulled.
The response identifies the Box only inside its message; image preparation also supplies `progress` and `Retry-After`.
Both console templates and the create dialog use `useCreateBoxMutation`, which treats this response as creation failure.
The template picker then invites a retry even though a resource exists.

This failure path is established from source and local regression tests; live production reproduction is outside this investigation.

## Scope

- Add a structured `boxId` to state-wait timeout responses and forward it through the exception filter.
- Recover only HTTP 408 with a nonempty string `boxId` in the shared create mutation; read that Box through the existing organization-scoped API.
- Reuse existing navigation and detail-page polling; a Box still starting remains Starting, and a later ERROR remains visible.
- Preserve the 30-second limit, HTTP status, message, image progress, retry hint, and SDK startup contract.
- Never retry POST, infer identity from a name, parse an error message, or accept an unidentified network/gateway timeout as success.

No OpenAPI request field, database migration, dependency, deployment, or public issue is required.

## Related work and lessons

Known items before search: RFC 9110 section 9.2.2; resource-based long-running operations; RIFL request identity and replay records.

| Evidence | Lesson and disposition |
| --- | --- |
| [RFC 9110, 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2) | Adopt: do not automatically repeat non-idempotent POST without evidence that replay is safe. |
| [Microsoft Graph, long-running operations](https://github.com/microsoft/api-guidelines/blob/vNext/graph/patterns/long-running-operations.md), Solution | Adapt: observe the existing resource and its state; avoid introducing another operation resource. |
| [RIFL, SOSP 2015](https://web.stanford.edu/~ouster/cgi-bin/papers/rifl.pdf), sections 1–2; [Kudu retry design](https://github.com/apache/kudu/blob/master/docs/design-docs/rpc-retry-and-failover.md) | Reject replay infrastructure here: stable identity suffices because this fix sends no second mutation. These are historical mechanisms, not evidence of current SOTA. |
| [GitLab long polling](https://docs.gitlab.com/ci/runners/long_polling/), Enable long polling | Reject longer request holding as the repair: a finite wait still expires independently of underlying work. |
| [Axios 1.20.0 AxiosError](https://github.com/axios/axios/blob/v1.20.0/lib/core/AxiosError.js), constructor | Reuse `response.status` and `response.data`; the dashboard's raw REST Axios instance does not flatten errors. Installed Axios version verified locally. |
| NestJS common 11.2.5, installed `exceptions/http.exception.js` and `request-timeout.exception.js` | Object response bodies preserve structured metadata; the project's filter explicitly selects fields, so it must also change. |

Alternatives: merely increasing the timeout postpones the failure; name lookup risks selecting an older Box; parsing the message couples behavior to prose.
An asynchronous create option would change more public contracts and require SDK/server coordination, so defer it.

Research log, 2026-11-05: web search plus original-page reads; arXiv (2 queries, no relevant new result), ACM (2 queries, RIFL found through author mirror), GitHub (2 queries, Graph/Kudu), GitLab (1 query, long polling), web (RFC query), dependency source inspection (Axios/NestJS), and local/upstream Git history (`cloudBox.ts`, state waiter).
Kept queries: `site.rfc-editor.org rfc 9110 idempotent retry POST timeout`; `site.dl.acm.org "Implementing linearizability at large scale"`; `site.github.com microsoft api-guidelines long running operations`; `site.github.com "RIFL" "RAMCloud"`; `site.gitlab.com long running operation polling timeout`.
Stop round: `site.arxiv.org "linearizability" "RPC" retries` and the ACM/GitHub/GitLab follow-up queries added no mechanism needed beyond identity and safe reads.
Bidirectional citation chase connected RIFL to Kudu and the Kudu reference back to RIFL.
No qualifying recent paper/project SOTA item was established; vendor guidance establishes the pattern's existence, not superiority.

## How it works

1. The state waiter already knows the exact Box ID; include it in both plain and image-preparation timeout bodies, even when the best-effort progress read fails.
2. The exception filter forwards only a nonempty string `boxId`, retaining current metadata and HTTP status.
3. The shared create hook recognizes an Axios HTTP 408 containing that ID; its existing `getBox(id, organizationId)` verifies access and supplies the current Box.
4. The existing success path invalidates the organization's list and opens details. No state is synthesized as running.

The first request still waits up to 30 seconds. Server and dashboard must both be upgraded for recovery.
Old servers without structured identity, failed follow-up reads, and lost responses remain errors; they are not evidence that creation failed or succeeded.
Estimated production additions: under 50 lines, plus focused tests and documentation.

## Validation

Before changing production code, run added regressions against the original implementation and record their assertion failures.
Then apply all changes and rerun the same tests.

| Claim | Check |
| --- | --- |
| Identity survives slow image pulls and ordinary startup | Fake-time state-waiter tests assert the response's `boxId`, status, progress, and retry hint. |
| HTTP serialization preserves identity | Filter tests serialize a timeout and reject malformed identity metadata. |
| Dashboard opens the exact existing Box | Real create hook and Axios HTTP transport against a local server: POST returns 408; GET returns CREATING or STARTED; assert one POST, scoped GET, returned state, list invalidation. |
| Real failures remain errors | Missing/malformed ID, non-408 errors, transport errors, failed GET, and missing organization do not become successful creation. |
| Normal creation still works | 201 follows the same authenticated scoped read, preserving returned state. |

Run focused API and dashboard tests, relevant existing component tests, dashboard typecheck/build, and formatting checks.
Live production reproduction and deployment are outside local validation.
