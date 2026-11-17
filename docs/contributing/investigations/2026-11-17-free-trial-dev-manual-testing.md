# Free trial dev manual testing

Use this guide with the trial-aware Commerce and Dashboard builds deployed to dev. It covers card setup, first-subscription trial activation, automatic paid conversion, and inexpensive negative paths.

## Safety and prerequisites

- Use only dev data and Stripe **test-mode** keys. Never use a real card or live-mode credentials.
- Confirm Commerce has `FREE_TRIAL_ENABLED=true` and its Stripe webhook delivery works.
- Start each case with a new user and organization with no trial or paid-subscription history.
- Use a Dashboard owner account. For API checks, set `DEV_COMMERCE_URL`, `ORG_ID`, and `DEV_USER_TOKEN` without printing or committing the token.
- Trial conversion requires dev database access and coordination before any Commerce restart.

Read the authoritative plan response with:

```bash
curl -H "Authorization: Bearer $DEV_USER_TOKEN" \
  "$DEV_COMMERCE_URL/api/billing/organization/$ORG_ID/plan"
```

Downstream plan/cache readers can take 30–60 seconds to converge. Use the Commerce response when checking the exact transition.

## 1. Bind a card and activate a trial

1. In Dashboard, choose a standard self-serve paid monthly plan such as Pro.
2. Confirm the first subscription. With no saved card, Commerce returns Stripe Checkout for card setup; it does not activate a trial yet.
3. Use Stripe test card `4242 4242 4242 4242`, any future expiry, and any valid-looking CVC/postal code.
4. Return to Dashboard and confirm the subscription again. Card completion does not replay the subscription request automatically.
5. Read the plan response.

Expected result:

- `status` is `active` and entitlements are active.
- `trial.startedAt` and `trial.endsAt` are exactly seven days apart.
- `trial.conversionState` is `not_attempted`.
- `trial.conversionAmountCents` equals the selected plan's full monthly price.
- `cycleTo` equals `trial.endsAt`; the selected plan's quota is available.
- Stripe records the SetupIntent, but no first-month PaymentIntent or charge.

Repeating the same subscription request returns success without moving `trial.endsAt` or creating a payment.

## 2. Convert a due trial to paid

Do not deploy a build with a hardcoded one-minute trial. Move only the dev test organization's trial boundary into the past, using the same time-travel shape as `test/free-trial.e2e-spec.ts`.

In `psql`, replace the example organization ID and run:

```sql
\set org_id 'org-dev-trial-success'

BEGIN;

UPDATE commerce_subscriptions
SET trial_ends_at = now() - interval '1 minute',
    ending_at = CASE
      WHEN ending_at IS NULL THEN NULL
      ELSE now() - interval '1 minute'
    END,
    updated_at = now()
WHERE organization_id = :'org_id'
  AND trial_source = 'first_subscription'
  AND status = 'active'
  AND trial_conversion_state = 'not_attempted';

UPDATE commerce_wallet_transactions
SET expiration_at = now() - interval '1 minute'
WHERE organization_id = :'org_id'
  AND source_invoice_id IS NULL
  AND subscription_credit_kind = 'cycle'
  AND expiration_at > now();

COMMIT;
```

The subscription update must affect exactly one row on a fresh test organization. If it affects zero rows, stop and check the organization ID and trial state. The wallet update expires the trial lot with the trial boundary; skipping it can distort the quota check.

Read the plan before the sweep. An uncanceled due trial should be `past_due`, with suspended entitlements and `conversionState: pending`. This proves time expiry alone does not grant paid entitlement.

There is no public manual-sweep endpoint. Either wait for the next hourly `renew-cycles` pass, or coordinate a dev Commerce restart; scheduled jobs run once at process startup. A restart affects everyone using that dev environment.

Expected result after the pass:

- `status` is `active`, entitlements are active, and `conversionState` is `succeeded`.
- Exactly one successful off-session PaymentIntent charges the locked `conversionAmountCents`.
- The conversion invoice is paid; the paid plan receives its full monthly quota once.
- `cycleFrom` equals the actual payment-success timestamp, not the webhook or sweep time.
- `cycleTo` is one clamped calendar month after `cycleFrom`.
- Another sweep does not create a second charge or quota grant.

## 3. Simple negative and boundary paths

### Reject plan changes and cancellation undo

1. Activate a trial.
2. Attempt to upgrade to another plan; expect HTTP 400 with `Plan changes are unavailable during a trial`.
3. Cancel the trial; expect `cancelAtPeriodEnd: true`, active entitlement, and the same `trial.endsAt`.
4. Attempt to restart or change the plan; expect HTTP 400. No payment should be created.

### Expire a canceled trial without charging

1. Cancel a trial, then apply the SQL in section 2. The `ending_at` expression moves the cancellation boundary too.
2. Wait for or trigger `renew-cycles`.
3. Expect no live plan, no conversion invoice, and no PaymentIntent.

### Close a declined conversion without retrying

Use a fresh user and organization. Bind Stripe's `4000 0000 0000 0341` test card, which [attaches successfully but declines charges](https://docs.stripe.com/testing#cards). Activate a trial, apply the time-travel SQL, and run the sweep.

Expected result:

- `status` is `canceled`, entitlements are suspended, and `conversionState` is `failed`.
- Stripe shows one declined conversion attempt; another sweep creates no retry.
- Replace the card with `4242 4242 4242 4242` and subscribe again. The result is an ordinary paid subscription with immediate payment and no new trial.

If Stripe rejects this card during setup in the dev configuration, stop that case rather than treating it as a conversion failure. The deterministic FakeStripe E2E already covers the off-session decline path.

### Consume eligibility across organizations

Using the same user and card in a second organization must not produce another self-service trial. The second subscription follows the ordinary paid path and creates a test-mode charge. This is expected fallback behavior, not an HTTP error.

## Leave asynchronous race cases to E2E

Pending payments, duplicate webhooks, failed-then-late-success, and cancellation-race refunds require controlled provider state transitions. Use `test/free-trial.e2e-spec.ts` with PostgreSQL and FakeStripe rather than attempting to manufacture those races manually in dev.

For any failure, record the organization ID, transition timestamps, invoice/payment IDs, and Commerce `renew-cycles` logs. Do not record card numbers, credentials, or webhook secrets.
