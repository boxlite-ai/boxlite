# Invitation registration and reward delivery

Delivery scope: Dashboard sharing is available. The registration page and OIDC handoff follow in the next change.

## Contract and ownership

The [Story](https://app.notion.com/p/boxlite-Story-3db8d8d9717980709461e04a9edb49e4) and
[feature design](https://app.notion.com/p/3db8d8d9717980339baaf7e970ad0eeb) are supplemented by these approved rules:

- Registration accepts invitation **links only**. `/register?referredCode=...` shows a read-only code; `/register` has no code input. This supersedes manual-entry BL-08 and X02 scenarios.
- Every member may share the selected organization's code. The organization receives the reward. A user identity can be attributed only on its first local registration. Its default organization stores `inviterOrganizationId` as the attribution identity and `referredCode` only as the original code snapshot for audit.
- BoxLite owns attribution and event delivery. Commerce owns reward amounts, limits, coupons, redemptions and wallets. BoxLite never initializes a wallet before sending an event.
- After an inviter becomes available again, a verified pending registration is rechecked on the invitee's next organization query. There is no eligibility scanning job.

```mermaid
sequenceDiagram
  participant UI as Register / OrganizationsProvider
  participant JWT as JWT strategy
  participant U as UserService
  participant DB as PostgreSQL
  participant P as Publisher
  participant C as Commerce
  UI->>JWT: GET organizations?referredCode (first business request)
  JWT->>JWT: signature, identity, email policy, code syntax
  JWT->>U: authenticate (internal registration context)
  U->>DB: subject lock, reread identity and registration
  U->>DB: default organization + registration + accepted event (one transaction)
  DB-->>UI: OrganizationDto[] after commit
  UI->>UI: clear draft; mount business providers and Socket
  P->>DB: short SKIP LOCKED claim transaction
  P->>C: POST immutable billing event outside transaction
  C-->>P: matching processed / skipped receipt
  P->>DB: persist result only if claimToken still matches
```

### Public API

Both GET routes return `Cache-Control: private, no-store`, including authentication and business errors.

| Route | Authentication | Success |
| --- | --- | --- |
| `GET /api/organizations/:organizationId/referral-code` | Existing user JWT or organization-scoped API key; organization member or system administrator | `{organizationId, referralCode}`; no URL |
| `GET /api/organizations?referredCode=...` | JWT only; dedicated registration guard | Existing `OrganizationDto[]` shape |

Codes contain 10 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; the API trims and uppercases them. Missing/blank API query means ordinary login. The browser rejects a blank, repeated, bracket-shaped or malformed invitation parameter before OIDC. Header values and parameters on other routes cannot enable attribution.

| HTTP | Code / meaning | Client behavior |
| --- | --- | --- |
| 400 | `invalid_referral_code` | Stop; obtain a new valid link |
| 403 | `email_verification_required` | Preserve context; verify and sign in again |
| 403 | Referral code read denied, or `invitation_unavailable` for an unavailable sharing organization | Do not expose a code |
| 409 | `registration_already_finalized` | Preserve invitation until user explicitly chooses ordinary login |
| 410 | `registration_unavailable` | Retained registration has no live user; stop registration |
| 422 | `invitation_unavailable` | Unknown/unavailable inviter; stop; no silent ordinary fallback |
| 503 | `registration_busy` / `referral_code_unavailable` | Retry original request after bounded lock contention / code generation exhaustion |

Existing finalized users can retry their original code; they cannot change it. A query without a code does not clear stored attribution. Ordinary signup, additional organizations and membership invitations never emit this event.

The ordinary organization-creation API forwards only its public name and default-region fields. Caller-supplied invitation fields cannot reach the internal creation service; only the registration coordinator may set attribution.

Generated TypeScript calls are `listOrganizations()`, `listOrganizations(code)` and `listOrganizations(undefined, options)`. Existing options-only callers must use the third form. Generate with `make generate:apps:referral`, then run the contract/type checks.

### Durable state

The pre-deploy migration `AddOrganizationReferral1789500000000` adds nullable `referralCode`, `referredCode` and `inviterOrganizationId` columns. `AddInvitationRegistration1789500000001` then adds `user_registration` and `organization_business_event_outbox`. These migrations start from the main branch schema; the unpublished combined migration is replaced, with no upgrade migration for its temporary shape. Existing users are backfilled as `none`, with their default organization when one exists; no historical reward is emitted. Users created by an older writer after migration are also captured as `none` when first observed or before deletion by the new service.

`user_registration.userId` is unique after the existing JWT subject normalization (including Okta `uid`). JIT creation, administrator creation, verification and deletion use the same PostgreSQL transaction lock. Default organization creation and email-verification listeners finish using the same EntityManager before confirmation. There is no listener-order dependency.

`pending_verification` becomes `accepted` only when the user is verified and both organizations are available. Confirmation saves `acceptedAt`, a stable `eventId`, and the outbox row atomically. Failure rolls back the entire transaction. An accepted registration is never re-evaluated or reassigned.

Attribution and outbox tables deliberately have **no foreign keys** to live users/organizations and survive their deletion. `referralCode` is globally unique when non-null. The default organization and registration save the resolved `inviterOrganizationId` together; confirmation and delivery use that ID, never a new lookup of the audit-only `referredCode`. The organization inviter ID has no foreign key, so deleting the inviter preserves other organizations' attribution. `referredCode` is a repeatable historical snapshot. See [schema](../SCHEMA.md).

### Commerce event protocol

`POST {USAGE_EXPORT_URL}/internal/organization/{inviterOrganizationId}/billing-events`, bearer `USAGE_EXPORT_TOKEN`:

```json
{
  "eventId": "<stable UUID>",
  "type": "InvitationRegistrationSucceeded",
  "occurredAt": "<acceptedAt UTC timestamp>",
  "data": { "registrationId": "<UUID>", "inviteeUserId": "<normalized subject>" }
}
```

Only HTTP **200** with matching `eventId` and `organizationId` is delivered. Both receipts require boolean `replayed`:

- `processed`: `reason: null`; `result` has `scene: InvitationReward`, positive integer `creditCents`, and UUID `couponId`, `redemptionId`, `walletTransactionId`.
- `skipped`: `reason: reward_limit_reached`, `result: null`. This is a terminal business result, not a delivery failure or an amount credited.

Invalid 200 receipts, network errors, timeouts, 429 and 5xx retry within the failure budget. 400/401/409/413 block immediately. Other unexpected statuses also retry with a bounded budget. `attempts` counts failures; replay retains the original event and occurrence time. Claim expiry cannot let an old worker overwrite the new worker's result.

## Configuration

| Environment variable | Default | Validation / meaning |
| --- | --- | --- |
| `BUSINESS_EVENTS_ENABLED` | `true` | Explicit `true` or `false`; independent of usage export |
| `USAGE_EXPORT_URL` | none | Commerce service origin/base path, without `/api/billing`, query, fragment or embedded credentials |
| `USAGE_EXPORT_TOKEN` | none | Shared Commerce internal token; required when enabled |
| `BUSINESS_EVENTS_INTERVAL_MS` | `30000` | Scan interval |
| `BUSINESS_EVENTS_BATCH_SIZE` | `20` | Maximum claimed records per cycle |
| `BUSINESS_EVENTS_CONCURRENCY` | `4` | Maximum HTTP requests per worker |
| `BUSINESS_EVENTS_TIMEOUT_MS` | `10000` | Request timeout |
| `BUSINESS_EVENTS_VISIBILITY_MS` | `120000` | Claim visibility lease |
| `BUSINESS_EVENTS_MAX_ATTEMPTS` | `10` | Failed-attempt limit |
| `BUSINESS_EVENTS_MAX_BACKOFF_MS` | `900000` | Exponential retry cap with jitter; valid `Retry-After` may extend it |

All numeric settings are positive safe integers. `ceil(batchSize / concurrency) * timeoutMs + 5000` must be **less** than visibilityMs. Enabled but missing/invalid connection settings fails API startup. Local examples explicitly disable the publisher until Commerce is configured. The native local launcher also defaults publishing off for older `.env` files, while preserving explicit settings. Infrastructure forwards these settings independently from the existing usage-export switch.

Shutdown stops new claims, aborts HTTP requests, and waits for the active cycle within `timeoutMs + 5000`. Interrupted events retain their lease and event identity for another worker.

## Test entry points and evidence

The default API unit-test job disables event publishing and excludes the referral database and Commerce suites. The integration and acceptance make targets use `api/jest.referral.config.ts` explicitly; missing service dependencies still fail those targets.

Set `REFERRAL_ARTIFACTS_DIR` to the approved external-disk directory. Inject `DB_HOST/PORT/USERNAME/PASSWORD` and `REDIS_HOST/PORT/USERNAME/PASSWORD` securely; do not put passwords in commands or reports. Database creation permission is required. Each run creates its own random database via the `postgres` administrative database and drops only that database. Redis uses a run-specific key prefix; there is no shared-key flush. Missing dependencies fail the entry point; tests do not silently skip.

| Make target | Coverage |
| --- | --- |
| `test:apps:referral:unit` | API normalization/config/receipts; generated client call shapes; adjacent auth/organization regression |
| `test:apps:referral:integration` | D/C/R/E/P: real migrations, signed JWT routes, two Nest API instances, lock barriers, transactions, real Redis, controllable HTTP receiver |
| `test:apps:referral:dashboard` | F/U/I: sharing, clipboard outcomes, draft state, first-request barrier and recovery |
| `test:apps:referral:acceptance` | Real local `COMMERCE_WORKSPACE` with its dependencies; separate fresh Commerce DB; X01–X05 and automated portion of X06 |
| `check:apps:referral` | Regeneration consistency, affected project type checks, API/Dashboard production builds, changed-source lint/format |

All build outputs, Nx/Vite/Jest caches, Chromium installation, logs and reports are under the artifact directory. `apps/dist` must be absent or a symlink to its `dist` directory. Dependency installation follows the local dependency exception. Code generation needs the Java runtime required by the existing OpenAPI generator.

Integration concurrency uses actual PostgreSQL locks and `pg_stat_activity` barriers to prove overlap. The two focused Nest instances run in one test process with separate DB connections; VM/Runner services are omitted. Authentication is not mocked. The browser fixture mounts the actual registration, code and organization-membership handlers; unrelated post-registration dashboard routes are outside this fixture's scope.

Cross-repository tests set **M=137 cents, N=2** and disable unrelated signup credits/payments and Commerce's optional Redis cache. BoxLite still uses the designated Redis service. Each organization has a recorded zero ledger baseline. X05 shares as an ordinary member, never reads the wallet API, and compares the actual wallet table before and after delivery. Receipt IDs are matched against coupon redemptions and wallet transactions. Commerce source is loaded in its own process with its own TypeORM version.

Reports include command logs, JSON test results, run metadata and `acceptance-evidence.json` containing case IDs, database names, revisions, registration/event IDs and ledger IDs. These reports contain test identities; restrict access accordingly. A missing service or failed cleanup makes the run unsuccessful.

### Manual completion checklist

The automated suites do not mark the Story complete. Retain case ID, both release revisions, environment, command/action, HTTP/DB assertions and result for:

- U03/U04: the deployed hosted OIDC signup/verification journey, real browser identity switching and session loss.
- F03/F04: native clipboard allow/deny behavior, selectable fallback, narrow viewport and keyboard use.
- X06: staged production-style rollout and rollback using the exact compatible Commerce and API builds; confirm ledger and migration history survive.
- Final deployed smoke: link signup, duplicate event, cap reached, and first wallet creation. Record coupon, redemption and movement IDs.

## Release and rollback

1. Deploy Commerce migration, billing-events route, reward rules and a compatible rollback build.
2. Run the BoxLite **pre-deploy** migration through the existing deployment migration mechanism.
3. Deploy **all** BoxLite API replicas with valid Publisher configuration; verify the new GET contract.
4. Publish the Dashboard invitation entry only after all replicas accept it.
5. Execute the deployed smoke scenarios and capture evidence.

For rollback, remove the front-end entry first, stop/disable publishers and roll back application builds. Retain new columns/tables, registration facts, event rows and migration history. Schema `down` acquires table locks and refuses if any registration, outbox row or organization code exists; use it only on an unused empty feature schema. A historical-user backfill also makes schema `down` unsafe.

## Monitoring and recovery

Structured logs carry registrationId, eventId, target organization, attempt, HTTP status, business outcome/reason and next retry time. Periodic backlog logs include oldest pending age, blocked count and pending-registration age/count. Pending-registration logs distinguish unavailable inviter from unavailable default organization.

| Symptom | Action |
| --- | --- |
| 401 blocked | Repair shared-token configuration, then restore the original event |
| 400/409/413 blocked | Compare the exact persisted envelope and Commerce contract; fix the producer/receiver before recovery |
| Network/429/5xx | Check availability and Retry-After; retries are automatic until the configured limit |
| Response lost / unknown reward result | Replay the original event; Commerce deduplication and the matching receipt settle the result |
| Verified registration remains pending | Restore original inviter/default organization availability; invitee refreshes organizations; do not rebind or scan for replacements |
| Delivered + skipped | Cap reached; do not treat this as credited money or requeue it |

After correcting a blocked event, an operator may use a parameterized statement in a short transaction. Record the operator and reason in the incident log. This resets the failure budget, not attribution or event identity:

```sql
UPDATE organization_business_event_outbox
SET status = 'pending', attempts = 0, "availableAt" = CURRENT_TIMESTAMP,
    "claimToken" = NULL, "lastError" = NULL
WHERE "eventId" = $1::uuid AND status = 'blocked'
RETURNING "eventId", "organizationId";
```

Never delete deduplication facts, mint a replacement event ID, change the target organization, or rewrite accepted attribution to recover a delivery.
