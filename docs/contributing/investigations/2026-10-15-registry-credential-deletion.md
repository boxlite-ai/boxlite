## TL;DR

Serialize registry credential deletion with private-image box persistence so a concurrent create cannot succeed after its login is removed.

## Scope

- Coordinate `RegistriesService.delete` and `BoxRepository.insert`, including generated-name retries and optional box-limit admission.
- Preserve longest-prefix credential matching, curated/public image behavior, and the existing 409 refusal for credentials used by live boxes.
- Cover both operation orderings with real PostgreSQL transactions before changing production code.
- Secret-store/database crash atomicity and catalog-entry deletion are separate concerns.

## Related work and lessons

- At `7e41ef35`, `RegistriesService.delete` checks dependent boxes before destroying the password, without a transaction. `BoxService.create` resolves the proxy reference before placement and `BoxRepository.insert`; neither operation locks credentials. A create can resolve the existing login and persist after deletion checked for boxes.
- PostgreSQL [row locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS) last until transaction end. Shared row locks permit concurrent creators but conflict with the exclusive lock required by deletion. Box-limit admission runs under READ COMMITTED (POL-822), where each statement reads a fresh snapshot, so the shared-lock read sees a credential deleted before it as missing, and creation returns 409.
- TypeORM [transactions](https://typeorm.io/docs/advanced-topics/transactions/) require transaction-scoped managers for participating queries. Dependency checks and credential deletion must use the same manager holding the lock.
- A lock only on deletion leaves creation uncoordinated. A process mutex fails across API replicas. Holding a lock from image resolution through runner placement unnecessarily keeps a database connection across unrelated work. Rechecking the proxy reference at the existing box-persistence transaction is the smallest durable boundary.

## How it works

Before inserting a proxy-backed box, read that organization's upstream-host credential rows under a shared lock and verify that the repository still has a matching login. Reuse the existing longest-prefix selection rule. Hold the lock until the box and last-activity transaction commits. Public and curated references skip this lookup.

Deletion opens a READ COMMITTED transaction, locks its credential exclusively, checks committed dependent boxes, destroys the secret, and deletes the row before committing. Both sides use NOWAIT: contention returns 409 for retry instead of holding a pooled connection while another request performs secret-store work. This can transiently reject a concurrent create or delete; a request never succeeds with a credential knowingly removed during persistence.

No schema change, new dependency, or resolver API is required. Expected production additions are below 120 lines.

Deletion reads candidate credentials once through its transaction manager and
matches dependent boxes in memory with the same longest-prefix helper. This
replaces one repeated credential query per box and preserves the row lock.
The single-repository lookup service no longer needs a transaction-manager
argument or an injection into the deletion service.

## Validation

| Ordering | Controlled boundary | Required result |
| --- | --- | --- |
| Deletion first | Pause secret destruction after the dependent-box query; attempt a real box create | Creation returns 409, no box is saved, deletion can finish |
| Creation first | Pause the box transaction after INSERT and before commit; delete the credential | Deletion returns 409 without destroying the secret; creation commits |
| Resolution before completed deletion | Pause runner placement after the real resolver returns a proxy ref; delete, then resume creation | Creation returns 409, including with box-limit admission |
| Existing dependent box | Create and commit, then delete | 409 identifies the dependent box |
| Curated images | Create without a proxy ref after credential deletion | Existing behavior is preserved |

The reproduction runs against PostgreSQL with controlled promises, not timing sleeps. It exercises real resolver, repository, and deletion service code; runner selection and the secret-store boundary are test fixtures. With production unchanged, all six concurrency cases failed because the conflicting operation succeeded. With the fix, all six passed; the focused run passed 76 tests, including creation-admission regressions. Scoped lint and formatting also passed. Secret-store crash recovery and distributed Redis behavior are not exercised here.

Tracking context: https://github.com/boxlite-ai/boxlite/issues/1948

The query-count regression creates three boxes across broad and narrow
credentials. Before optimization, deletion correctly identified the dependent
box but read credential rows four times. After optimization it reads twice (the
locked target plus one candidate snapshot), with the dependent-box check intact.
All 99 selected credential, resolver, admission and box tests passed, along with
scoped lint and formatting.

The registry SDK layer now includes these corrections and their regressions,
because the backend layer has merged. The test calls `BoxService.create` with
`Context.user()` before admission options, matching the current service contract.
The focused service and PostgreSQL concurrency run passes all 16 selected tests.
