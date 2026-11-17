**Status:** Implemented

# Free trial with automatic conversion design

[Linear BUI-1776](https://linear.app/polygala/issue/BUI-1776/free-trial-with-auto-charge-and-conversion-to-paid-for-new-subscribers) adds a seven-day first-subscription trial with automatic paid conversion. The [accepted requirements](2026-11-17-free-trial-auto-conversion-requirements.md) are the behavioral source of truth. This design follows the existing Commerce implementation rather than introducing a second billing engine.

## Decision

Keep the trial, subscription chain, billing periods, and quota in Commerce's PostgreSQL model. Reuse the existing card setup, plan-axis locks, fee invoices, off-session PaymentIntents, signed webhooks, and hourly fee sweep.

No Stripe Subscription object is needed. Commerce already owns subscription renewal. At trial expiry, its existing fee engine creates one full-month conversion invoice and charges it once. Actual payment success re-anchors the same Commerce subscription and invoice to the provider-attested charge time.

Do not add a general distributed-lock library, notification channel, administrator-granting channel, or parallel payment scheduler.

## Existing seams confirmed in code

- `POST organization/:id/plan/upgrade` is already the first-subscription entry point. Its controller can pass the verified OIDC subject into the use case; static organization tokens do not gain user-level trial eligibility.
- `PlanAxis` serializes plan decisions with a PostgreSQL advisory lock, including organizations with no existing subscription row.
- `BeginSubscription`, `RenewCycle`, and `SettlePaidFee` already collect plan fees and reconcile late provider outcomes.
- `GrantCredit` and `ReconcileSubscriptionCredits` provide idempotent, expiring subscription quota. Trial candidates join that owner instead of assembling wallet writes in the caller.
- The Stripe adapter already verifies raw signed webhooks and uses stable payment-row idempotency identities.
- FakeStripe is a real HTTP stand-in used by E2E tests, so provider request construction, idempotency, and response parsing stay in the tested path.
- BoxLite's plan readers already consume `status`, `entitlements`, cycle timestamps, and quota. They need no trial-specific enforcement branch.

Stripe is not asked to own the trial schedule. Its native trial defaults the billing anchor to `trial_end`, while this requirement anchors the paid month to actual payment success. Resetting a Stripe anchor can also issue another invoice ([Stripe billing periods](https://docs.stripe.com/billing/subscriptions/billing-cycle)). Keeping Commerce's existing cycle arithmetic avoids both problems.

## Organization-plan compatibility

Do not add `trialing` to `OrganizationPlan.status`; existing consumers strictly validate `active`, `past_due`, and `canceled`. Add optional `trial` metadata instead:

```ts
type TrialInfo = {
  startedAt: string
  endsAt: string
  conversionAmountCents: number
  currency: 'USD'
  conversionState: 'not_attempted' | 'pending' | 'failed' | 'succeeded'
}
```

`trial` is present for an activated trial and retained as history after conversion. It is absent for ordinary paid subscriptions. Checkout-incomplete grants have no live plan because card setup happens before trial activation.

| Lifecycle | Existing plan fields | Effective access |
| --- | --- | --- |
| Trial active | `active`, active entitlement, `not_attempted` | Selected plan until `trial.endsAt` |
| Trial canceled before expiry | `active`, active entitlement, `cancelAtPeriodEnd: true` | Selected plan until the unchanged end |
| Conversion pending or due | `past_due`, suspended entitlement, `pending` | None until actual payment success |
| Conversion failed | `canceled`, suspended entitlement, `failed` | None; normal paid repurchase remains available |
| Conversion paid | `active`, active entitlement, `succeeded` | New paid month and full quota |

A failed-trial fallback is read only when no newer subscription lifecycle exists. It cannot reappear after a later paid subscription ends.

Before creation, BUI-1774's confirmation flow and card setup disclose duration, entitlements, locked conversion amount and time, payment method, and cancellation path. BUI-1776 supplies the values; it does not take over that presentation work.

## Trial granting module

`GrantTrial.execute` is the reusable internal module. Its input contains authenticated user ID, organization ID, plan ID, source, and an optional caller transaction. `source` is currently `first_subscription`; a future administrator flow may add its own authorized source without consuming self-service eligibility.

The module performs the complete grant behind one use-case interface:

1. Resolve a standard self-serve paid monthly plan under the existing catalog read lock.
2. Require a saved default card with a provider fingerprint. Missing identity support falls back to paid purchase.
3. For first subscription, acquire deterministic advisory locks for user and card identity, then check trial and paid-subscription history. Independent uniqueness rules cover the user across organizations, the organization across users, and the card across accounts.
4. Insert one active trial with immutable plan, price, quota, start, and exact seven-day end.
5. Invoke `ReconcileSubscriptionCredits` with the durable trial ID. Its trial candidate derives the expiring quota grant from that row and reuses the existing exactly-once grant key.

Repeated activation of the same current trial is a no-op and never moves its end. A user with attributable prior paid history receives no trial but can still purchase. No administrator route, UI, or public grant operation is included.

Commerce enforces repeat-registration protection only when an OIDC subject, organization, or card fingerprint links the attempts. A deliberately new OIDC subject combined with a new card has no reliable identity link in the current system; adding such an identity capability is outside this issue.

## Durable records

Extend the existing subscription row with nullable fields rather than creating a second lifecycle store:

- Trial user/source, start/end, conversion state, locked amount, and locked quota.
- Subscriber user ID and provider payment fingerprint, including ordinary paid starts so attributable previous paid history consumes self-service eligibility.
- Existing organization, plan, status, subscription anchor, cancellation, and chain fields remain authoritative.

There is no identity backfill for pre-migration paid rows. Any active or terminated legacy row blocks a later trial in that same organization even when its new identity fields are null. A legacy row cannot block a trial in another organization because Commerce has no subscriber identity to associate with it.

Partial unique indexes apply only to `first_subscription` trials. Existing paid rows and future administrator sources do not inherit those constraints. All money and entitlement writes join the existing Commerce transaction and lock order.

## Lifecycle

### Start and cancel

Card setup remains the existing flow. Only verified OIDC identity reaches user-level trial eligibility. Browser return alone activates nothing. After card setup and eligibility succeed, the trial and quota commit together.

Cancellation uses the existing null-target downgrade route. It schedules the unchanged trial end and cannot be undone. Commerce rejects every other plan mutation while the trial is active or cancellation is pending, including direct calls that bypass Dashboard.

At the original end, `ensureCurrentCycle` moves an uncanceled trial to conversion-pending, so a read cannot preserve entitlement past expiry. A canceled trial instead terminates without opening a conversion invoice. A cancel arriving after the due transition but before a conversion invoice exists cannot erase the amount owed; once a payment is in flight, cancellation remains effective and the late-success rule below applies.

### Convert

The existing fee sweep selects only due trials. `RenewCycle` then:

1. Opens or reuses the trial-conversion invoice for the locked full monthly amount and quota. No wallet debit, proration, trial-usage adjustment, coupon, credit, or offline-discount handling is added.
2. Marks conversion pending and attempts one off-session PaymentIntent through the existing payment row. A pending payment never receives paid entitlement.
3. On real success, reads the provider-attested charge time from the successful payment record. `SettlePaidFee` marks the invoice paid, re-anchors the subscription and invoice to that time, and grants the full paid-month quota once.
4. The next Commerce renewal follows the existing clamped monthly anniversary arithmetic. Trial quota does not carry over; its lot expires at the original trial boundary.

If provider setup or a local write fails, the existing durable invoice/payment records drive the next reconciliation. No second PaymentIntent is created for the same decided payment.

### Fail and repurchase

A definitive first failure marks the conversion invoice failed, terminates the trial, and suspends entitlement. The same rule applies to an immediate decline and a failure learned through a webhook or provider probe: the presence of a failed conversion attempt bypasses the generic dunning schedule. There is no automatic retry and no `pay-open-charge` path for the failed trial.

A subsequent purchase uses the ordinary paid flow and records the subscriber identity. It creates no trial.

### Late success and cancellation races

The fee sweep also selects settled trial conversions whose local invoice or lifecycle has not converged. `ReconcileTrialConversion` reads the successful payment and applies one outcome:

- An uncanceled pending or failed trial converts/restores without another charge.
- A conversion that succeeded after accepted cancellation keeps cancellation effective and issues one targeted, provider-idempotent refund.
- If a normal paid repurchase is newer, that paid lifecycle remains authoritative and the stale trial payment is refunded instead of creating another paid lifecycle.

Provider refund failure leaves the mismatch retryable by the same sweep. The payment row records `refunded` only after provider confirmation. Duplicate success callbacks cannot duplicate conversion, quota, or refund.

Existing BoxLite caches retain their current 30–60 second convergence behavior. “Immediate” suspension means Commerce's authoritative response changes when the transition commits; no new downstream invalidation system is needed.

## Safety invariants

| Invariant | Enforcement |
| --- | --- |
| One self-service trial per linked user, organization, and card | OIDC identity, attributable paid/trial history, legacy same-organization rows, ordered advisory locks, independent unique indexes |
| Trial time never extends through retry | Immutable active-trial timestamps and current-trial replay |
| Client cannot choose price, quota, or payment state | Server catalog, durable grant fields, provider records |
| Browser return or pending payment grants nothing | Verified card setup and actual payment state only |
| Paid entitlement requires real success | Successful payment record, conditional subscription/invoice transition |
| Cancellation and retained charge cannot both stand | Cancellation-aware conversion, provider readback, targeted idempotent refund |
| Duplicate work cannot duplicate money or quota | Existing event/payment ledgers, provider idempotency, database uniqueness |
| Failure never looks paid | Suspended Commerce entitlement and terminal failed conversion |
| Late events cannot regress state | Actual provider state and conditional lifecycle transitions, not event order |
| Redis is not financial truth | PostgreSQL constraints and transactions decide correctness |
| Card data and credentials stay out of logs | Provider IDs/fingerprints only, existing redacted payment events |
| Administrator granting remains closed | No administrator channel or publicly callable grant route in this issue |

Reuse an existing Commerce control whenever it satisfies the row. No new general security or compensation platform is required.

## Test strategy

### Module and policy tests

Use in-memory/faked persistence and controlled time for seven-day arithmetic, plan eligibility, state projection, cancellation finality, exact amount, and monthly clamping. These tests do not require Redis.

### Real PostgreSQL and FakeStripe E2E

`test/free-trial.e2e-spec.ts` runs real Commerce HTTP handlers, OIDC verification and membership, PostgreSQL migrations, actual locks, fee collection, quota grants, and signed webhooks. FakeStripe replaces only the remote Stripe service.

The matrix covers:

- Activation without a first-month charge, exact seven-day window, and replay.
- User, organization, card, and previous-paid eligibility, including concurrent cross-organization claims.
- Plan-change refusal, cancellation finality, canceled expiry, and due-time suspension.
- Successful conversion, locked price, actual-success anchoring, exact paid month, and non-carried trial quota.
- Immediate and webhook-delivered failure without retry, followed by normal paid repurchase.
- Pending payment, duplicate success webhooks, failed-then-late-success, and cancellation-race refund.
- Failed-trial history after later paid termination and concurrent first-subscription requests.

Dashboard MSW tests owned by BUI-1774 prove presentation only. The BoxLite client test proves additive trial hydration and Date conversion; neither substitutes for payment E2E.

A Stripe sandbox may additionally exercise real provider compatibility. That acceptance complements, rather than replaces, deterministic concurrency and failure tests. Never run mutation or reversal cases with live-mode credentials.

## Rollout and operations

- `FREE_TRIAL_ENABLED` is off by default. Deploy schema and trial-aware read/write paths with the flag off, verify them, then enable trial creation. Disabling the flag leaves ordinary paid subscription unchanged and does not alter existing trials.
- Existing trials require a trial-aware binary. Rollback after trials exist must retain the migration and trial-aware read/webhook/sweep behavior; do not roll back to a pre-trial binary that would treat them as ordinary monthly subscriptions.
- Reuse Commerce payment logs for grant, conversion, failure, refund, and reconciliation. Logs include organization/payment/invoice IDs, never cards or credentials. Sweep failures remain visible and retry from durable state.
- BUI-1773 owns price/quota values and overage rules; BUI-1774 owns presentation; BUI-1775 owns card-reward removal; BUI-1777 owns card-validation payment/refund behavior. This design does not reimplement those scopes.
