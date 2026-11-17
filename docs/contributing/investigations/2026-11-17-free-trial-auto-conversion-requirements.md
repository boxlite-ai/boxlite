**Status:** Accepted

# Free trial with automatic conversion requirements

[Linear BUI-1776](https://linear.app/polygala/issue/BUI-1776/free-trial-with-auto-charge-and-conversion-to-paid-for-new-subscribers) defines the product contract for a first-subscription free trial, automatic conversion to a paid subscription, cancellation, and payment-failure recovery. This record resolves the open product rules without expanding into the related card-setup, pricing, or general billing work. The implementation approach and safety controls are in the [design record](2026-11-17-free-trial-auto-conversion-design.md).

## Objective

Offer each eligible user a seven-day free trial of a selected self-serve paid monthly plan. During the trial, provide the plan's established entitlements and quota without charging a subscription fee. When an uncanceled trial ends, charge the selected plan automatically and activate the paid subscription only after payment succeeds.

## Eligibility and plan coverage

- The trial lasts exactly seven days, starting when trial creation succeeds and ending at the same time of day seven days later.
- A real user can receive only one self-service first-subscription trial across all organizations:
  - Creating or joining another organization, or registering again, does not restore eligibility.
  - Members of the same organization cannot claim separate trials for that organization.
  - A previous trial, paid subscription, or trial whose conversion payment failed consumes the user's self-service eligibility.
  - An existing free user who has never subscribed remains eligible.
- Only standard, self-serve paid monthly plans participate. Custom plans, offline contracts, free tiers, and special pricing do not.
- The user selects one plan when starting the trial. That plan and its locked-in price define the later conversion.
- The system records the trial eligibility decision, selected plan, start time, and end time.
- Repeated requests cannot create another trial, extend the trial, or reset its end time.
- An ineligible user can still subscribe through the normal paid flow.

## Trial behavior

- The trial grants the selected plan's established entitlements and full plan quota. No subscription fee is charged during the trial.
- Before starting, the user can see the trial duration, plan entitlements, conversion amount, conversion time, payment method, and cancellation path.
- The selected plan cannot be upgraded or downgraded during the trial. The plan and original trial end time remain fixed.
- Existing usage, overage, wallet, and insufficient-balance behavior remains unchanged.

## Cancellation

- The user can cancel during the trial.
- Cancellation is final for that trial. There is no undo, resume, or restoration of automatic conversion.
- Cancellation prevents the automatic conversion charge. If an extreme race has already produced a charge, a targeted reversal restores zero retained net charge; this does not add a general refund workflow.
- The plan entitlements and remaining trial quota remain available until the original trial end time.
- After the trial ends, the user cannot reopen or extend it. A later self-service subscription uses the normal paid flow.

## Automatic conversion

- When an uncanceled trial ends, the system automatically charges one full monthly period at the price locked in when the trial started.
- The first paid period is not prorated or adjusted for trial usage, and its subscription charge is not paid from the wallet balance.
- The conversion flow introduces no special coupon, credit, or offline-discount handling.
- Initiating a charge or receiving a pending payment state does not activate a paid subscription. Only confirmed payment success does.
- The first paid billing period starts at the actual payment-success time. The next renewal is one monthly billing period after that start.
- Remaining trial quota does not carry over. A successful conversion grants the selected plan's full quota for the new paid period.
- Duplicate expiry jobs, payment callbacks, or user operations cannot create duplicate charges, billing periods, or quota grants.

## Payment failure and repurchase

- After the first conversion-payment failure, the subscription is marked unpaid and plan entitlements are suspended immediately in Commerce's authoritative state. It is not treated as a paid subscription and receives no free entitlement grace period; existing downstream caches may converge within their current 30–60 second propagation window.
- The system does not automatically retry the conversion payment. It reports the failure to the user and closes the trial subscription without restoring trial eligibility.
- The user can purchase a plan again through the normal paid subscription flow. The new purchase does not reopen or extend the ended trial.
- Throughout failure and repurchase, the subscription state, effective entitlements, and user-visible state must agree, with a clear paid-repurchase action.
- Duplicate failure callbacks and repeated user operations cannot cause duplicate charges or move the subscription back to an obsolete state.
- A delayed confirmation of an actual payment success must be reconciled with the real funds result without another charge or trial restoration; a confirmed charge cannot remain represented as unpaid.

## User visibility and notifications

- Billing surfaces distinguish trial-active, trial-canceled-pending-expiry, conversion-payment-failed, and paid-active states, with the applicable end time or recovery action.
- Existing notification channels may add trial-started, 24-hour expiry-reminder, conversion-succeeded, and conversion-failed notification types where the current mechanism supports them.
- This requirement does not add a notification channel or a notification-preference system.
- Notification delivery failure does not change trial, payment, cancellation, or subscription state.

## Reusable trial granting

The self-service first-subscription flow must delegate trial creation to a reusable internal trial-granting capability. A future administrator-granted trial should be able to reuse that capability and the same cancellation, conversion, and payment-failure lifecycle.

An administrator API, UI, authorization flow, or other granting channel is not part of BUI-1776. No administrator channel is required for acceptance; the internal capability is an extension point for later work.

## Related requirements and ownership

| Issue | Owns | BUI-1776 relationship |
| --- | --- | --- |
| [BUI-1773](https://linear.app/polygala/issue/BUI-1773) | Plan prices, quota values, billing periods, and overage rules | Consume the selected plan's configured values; do not redefine them. |
| [BUI-1774](https://linear.app/polygala/issue/BUI-1774) | Plan copy, subscription confirmation, and billing-state presentation | Provide accurate trial, conversion, entitlement, and failure data; do not duplicate the presentation work. |
| [BUI-1775](https://linear.app/polygala/issue/BUI-1775) | Removal of card-connection credit rewards | Do not add or retain a separate card-reward behavior in the trial flow. |
| [BUI-1777](https://linear.app/polygala/issue/BUI-1777) | Card validation through a $0.50 payment and refund | Use the existing payment-method boundary; do not implement card validation or card-validation refunds here. |

## Acceptance criteria

1. An eligible user's first subscription to a standard self-serve paid monthly plan starts one seven-day trial with the selected plan's established entitlements and quota.
2. An ineligible user receives no trial but can still start a normal paid subscription.
3. Repeated trial-creation requests preserve one trial and its original end time.
4. Trial cancellation prevents the conversion charge and preserves entitlements until the original end time, with no cancellation-undo path.
5. An uncanceled trial produces exactly one full-month conversion charge, and only confirmed success activates the paid subscription.
6. The paid period starts at actual payment success, trial quota does not carry over, and the new paid quota is granted in full.
7. Duplicate jobs, payment callbacks, and user operations produce no duplicate charge, billing period, quota grant, or state regression.
8. A failed conversion payment immediately suspends plan entitlements, closes the trial subscription without automatic retries, and offers a normal paid-repurchase path without restoring the trial.
9. A delayed payment success is reconciled with the actual funds result without another charge, trial restoration, or a persistent paid-but-unpaid mismatch.
10. Subscription state, effective entitlements, and Billing presentation remain consistent in every trial, cancellation, conversion, failure, and repurchase state.
11. Notifications reuse only existing channels, and notification failures do not affect the subscription lifecycle.
12. First-subscription trial creation uses the reusable internal granting capability; no administrator granting channel is delivered in this issue.

## Non-goals

- Changing overage charging, wallet debit, or insufficient-balance behavior.
- Adding or changing card setup, card validation, the $0.50 verification payment, or a general refund workflow. The targeted cancellation-race reversal remains part of the cancellation invariant.
- Changing plan prices, quota values, plan descriptions, or general plan-comparison content.
- Adding a notification channel or notification-preference system.
- Supporting plan changes during a trial or cancellation undo.
- Delivering an administrator trial-granting channel.
