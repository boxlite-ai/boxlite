# Billing Payment Runbook

This runbook covers Stripe payment recovery and Billing pipeline health. It does not cover
zero-balance enforcement; PR7 remains suitable only for a monitored, allow-listed beta.

## Recovery Model

- Stripe webhooks are the low-latency path.
- `billing-payment-recovery` runs every minute and claims only due rows from PostgreSQL.
- Provider reads happen outside database transactions. Results are applied in row-locked,
  idempotent transactions.
- Setup and top-up retries reuse the original attempt, provider reference, and Stripe
  idempotency key.
- Failed webhook application is persisted in `payment_provider_event` and retried with
  exponential backoff from 1 minute to 1 hour.
- Refunds and disputes append immutable `adjustment` ledger entries. Historical transactions
  are never edited.

## Release Checklist

1. Run pre-deploy migrations before deploying the API.
2. Set stage-scoped SST secrets. Never place their values in Git or logs.
3. Set `BILLING_PAYMENT_PROVIDER=stripe` explicitly for the target stage.
4. Configure the Stripe endpoint at `/billing/webhooks/payment` with these events:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `checkout.session.async_payment_failed`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `refund.created`
   - `refund.updated`
   - `refund.failed`
   - `charge.dispute.created`
   - `charge.dispute.funds_withdrawn`
   - `charge.dispute.funds_reinstated`
5. Deploy the API, then verify `GET /admin/billing/health` as an administrator.
6. Run the Stripe Sandbox E2E and confirm one paid top-up maps to one wallet credit.

Local verification:

```bash
cd apps
yarn test:billing:ops
yarn e2e:billing:stripe
```

Run the PostgreSQL edge suite against a dedicated test database. If the local API shares the
512 MiB local PostgreSQL Box, stop the API before `test:billing:ops`; otherwise the API pool,
scheduled jobs, and concurrent fault tests can exhaust the test database process budget.

Fault exercises use the same browser flow:

```bash
# Pauses after card setup. Stop the listener, then press Enter to prove provider reconciliation.
BILLING_STRIPE_E2E_EXPECT_RECONCILE=1 BILLING_STRIPE_E2E_TIMEOUT_MS=180000 yarn e2e:billing:stripe

# Creates a real test-mode refund and requires one immutable -$5 wallet adjustment.
BILLING_STRIPE_E2E_REFUND=1 BILLING_STRIPE_E2E_TIMEOUT_MS=120000 yarn e2e:billing:stripe
```

AWS identity check before stage work:

```bash
AWS_PROFILE=boxlite-sso aws sts get-caller-identity
```

## Health and Alerts

`GET /admin/billing/health` returns counts, oldest age, and the oldest affected resource for:

| Alert                     | Trigger                                      | First action                                             |
| ------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `stale_pending_payment`   | Pending top-up older than 15 minutes         | Reconcile the returned top-up ID                         |
| `failed_payment_webhook`  | A normalized event failed to apply           | Inspect `lastError`, then run due recovery               |
| `negative_wallet_balance` | Wallet total is below zero                   | Verify settlement and payment recovery before adjustment |
| `rating_lag`              | Archived Usage is unrated for over 5 minutes | Check Rating cron and database health                    |
| `settlement_lag`          | Rated Usage is unsettled for over 5 minutes  | Check Settlement cron and wallet lock failures           |

Structured log prefixes:

- `[billing_alert]`: health threshold crossed; includes the health snapshot and resource locators.
- `[billing_payment]`: payment apply or reconcile failure; includes stage, local ID, provider reference,
  and the sanitized error.

## Manual Recovery

All recovery endpoints require the existing admin role and emit an audit record.

```text
POST /admin/billing/reconcile
POST /admin/billing/reconcile/top-up/:topUpId
POST /admin/billing/reconcile/setup/:organizationId
```

Use the narrow top-up or setup endpoint first. The broad endpoint processes only currently due
rows and is safe to repeat. Do not create a replacement top-up for an ambiguous Stripe response;
reconcile the existing row so the stable idempotency key remains effective.

For a missed Stripe delivery, inspect the event in Stripe, resend it to the endpoint, and then run
Billing recovery. Repeated and out-of-order events are deduplicated by provider event and provider
action IDs.

## Webhook Secret Rotation

The API accepts one current and one previous signing secret during a controlled overlap.

1. Set `STRIPE_WEBHOOK_SECRET_PREVIOUS` to the currently deployed secret.
2. Roll the endpoint secret in Stripe with a grace period.
3. Set `STRIPE_WEBHOOK_SECRET` to the new secret and deploy.
4. Confirm new deliveries succeed and signature failures remain at zero.
5. After the Stripe grace period has expired, clear `STRIPE_WEBHOOK_SECRET_PREVIOUS` and deploy again.

Keep `STRIPE_SECRET_KEY` rotation separate from webhook signing-secret rotation so failures have a
single cause.

## Rollback

- Roll back the API image first. The PR7 migration is additive, so the previous API can ignore the
  new columns.
- Do not drop recovery columns or indexes during an incident.
- Keep Stripe webhooks enabled; Stripe retries failed live deliveries for a bounded period.
- If provider calls are unhealthy, leave rows pending. Never mark a payment paid from operator
  judgment alone.
- After recovery, deploy the fixed image and run `POST /admin/billing/reconcile`.

## Incident Acceptance Boundary

A Stripe outage can delay wallet credit but must not duplicate it. An API or database outage can
delay webhook application, but the failed-event queue and provider reconciliation recover after
service restoration. PR7 does not stop Box create/start or running resources at zero balance; use
strict organization quotas and active monitoring until Enforcement is implemented.
