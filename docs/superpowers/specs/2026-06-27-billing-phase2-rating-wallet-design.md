# Billing Phase 2 — Rating + Wallet (backend) design

Status: implemented (this branch). Stripe stubbed; UI/auto-suspend deferred.
Grounded in: Lago (self-hosted billing), OpenMeter (grant/version-snapshot), the
forked dashboard `OrganizationWallet` contract, Stripe webhook idempotency docs.

## Scope

In: rating (usage→USD, version-frozen), dual-pool wallet (free→paid), append-only
ledger, payment-provider seam (Fake now / Stripe later), idempotent webhook
settlement, pre-deploy migration, unit + (env-gated) integration tests.

Out (deferred): live Stripe, dashboard UI wiring, auto-suspend box, refund/chargeback
reversal, ongoing-balance refresh job.

## Data flow

```
usage_period (Phase 1, closed)
   └─ RatingService sweep ── resolve plan version + override, freeze snapshot
        └─ rated_period (UNIQUE usagePeriodId → idempotent; unitRates jsonb frozen)
             └─ WalletService.debit ── burn free→paid (planDebit)
                  └─ wallet_transaction (append-only) + wallet (materialized, FOR UPDATE)
TopUpService.createCheckout → provider intent → (user pays) → webhook
   └─ WebhookService.ingest ── processed_stripe_event PK + topUpWithin (one txn)
```

## Components (one purpose each)

| Unit | Responsibility | Depends on |
|---|---|---|
| `rate-math.ts` | pure: rate snapshot, seconds×rate (decimal.js), per-period totals | decimal.js |
| `rating.service.ts` | sweep closed→unrated periods, freeze rate, write rated_period | usage_period, rated_period, pricing_plan, override |
| `pricing.service.ts` | active plan + warn-threshold read | pricing_plan |
| `wallet-math.ts` | pure: burnDown, applyTopUp, deriveBillingStatus | — |
| `wallet-plan.ts` | pure: planDebit / planCredit → ledger rows + balances | wallet-math |
| `wallet.service.ts` | txn + FOR UPDATE; debit/topUp/grant; `*Within` variants | DataSource |
| `payment-provider.interface.ts` | money-movement seam | — |
| `fake/stripe-payment-provider.ts` | Fake (tests) / Stripe (stub) | — |
| `webhook.service.ts` | idempotent settlement (marker + credit, one txn) | DataSource, WalletService, provider |
| `top-up.service.ts` | two-stage top-up (pending record + checkout intent) | DataSource, provider |

## Invariants (enforced)

1. Version snapshot — rated_period freezes `unitRates`; reads never join the live
   plan; plan rate columns never updated. (price change can't move history)
2. Burn order — free(1)→paid(2), soonest-expiry, FIFO; expired lots excluded.
3. Append-only — ledger only inserts; reversals stamp `voidedAt`.
4. Idempotency — rating `UNIQUE(usagePeriodId)`; webhook `processed_stripe_event`
   PK inserted in the SAME transaction as the credit.
5. Balance — `balanceCents == SUM(ledger)`; when `>= 0` it equals `free + paid`;
   overage writes a debt row and goes bounded-negative.
6. Concurrency — every wallet mutation runs in one txn with `SELECT FOR UPDATE`.
7. Precision — decimal.js accumulate; round half-up only at the cent boundary;
   money is integer-cents bigint, never float.

## Key decisions (deviations noted)

- **Pessimistic lock** (`SELECT FOR UPDATE`) over optimistic-retry: all work is in
  one transaction, so it's simpler with the same no-lost-update guarantee.
  `lockVersion` retained for a future optimistic path.
- **grant is not an HTTP endpoint** — admin-only (a member must not self-credit).
- **Two-stage top-up** — POST returns a checkout URL; the wallet is credited only
  by the confirming webhook.

## Tests

68 unit (pure math + service orchestration + webhook idempotency-guard) + an
env-gated real-Postgres integration spec (`RUN_DB_IT=1`): migration + CHECK +
rating idempotency + dual-pool end-to-end + webhook idempotency.

Full report + ASCII diagrams: Obsidian `1-Projects/2026-06-Billing/08-Phase2-实现报告.md`.
