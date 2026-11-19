**Status:** Implemented

# Billing purchase information and payment wording

## Problem and scope
Billing uses connection terminology for adding cards and compares first-time
subscriptions against an absent subscription.
Registration, login, Welcome, Quickstart and onboarding guides are outside this Billing-only change.

## Design
Reuse current Console components and billing endpoints. Subscription remains the primary purchase path.
Wallet keeps payment methods above balance and top-up controls, uses Add card / Change card,
and retains existing top-up defaults. Empty-balance copy states only the balance, without promoting pay-as-you-go or assuming a consumed quota. First subscription confirmation shows only target values;
changes to existing subscriptions retain comparisons. A returned checkout link
stays available if navigation fails, with an exit back to Billing. Neither link
creation nor browser return is evidence of payment completion.

## Validation
Verify no diff in authentication, first-run components, Quickstart or onboarding
routes. Run Dashboard tests and build. Review the actual Wallet and subscription
pages with existing mock fixtures; real payment processing is not exercised.

## Resume card setup at explicit plan confirmation

Save a tab-scoped pending selection before leaving for checkout only when the fresh wallet read says no card is connected. Scope it to authenticated subject and organization, expire after 30 minutes, and store the plan ID, timestamp and a random document identifier. Session storage is navigation context, never payment evidence. Storage failures retain checkout access without claiming resume will work.

Billing consumes the matching pending selection once and navigates to the existing confirmation route with a setup-return marker. It never calls a mutation. Confirmation rereads wallet, plan and catalog before offering an explicit button; a connected card shows Card added, otherwise show setup unconfirmed and offer refresh. Eligibility and prices remain server-owned; do not promise a free trial or automatically resubmit. Unknown reads block confirmation. Existing plan match redirects to Billing normally. Cancel discards pending context. Late callbacks after organization/account changes cannot redirect the new context.

Preview uses mock card setup that returns to Billing and changes only the fixture's card status; no real charges. Validate storage scoping/expiry/one-shot consumption, return navigation without mutation, explicit confirmation, canceled/unknown and lost context. Registration/login/Welcome/Quickstart remain untouched.

## Source references and decisions

- `apps/dashboard/src/components/billing/planChange.ts`: reuse target comparisons and existing mutation contracts; first purchases need no absent-plan comparison.
- `apps/dashboard/src/components/billing/planBenefits.ts`: mock presentation uses the current plan catalog rather than independently maintained prices.
- `apps/dashboard/src/providers/SelectedOrganizationProvider.tsx`: wait for current organization membership readiness before restoring selection.
- `apps/dashboard/src/providers/QueryProvider.tsx`: cached and placeholder data require fresh reads before confirmation.

Preserve explicit subscription confirmation because completing card setup is not consent to a second subscription request. Restore navigation only; never infer trial eligibility from a connected card. Independent review identified stale membership, placeholder data and late-response risks; the implementation guards all three.

## Evidence and remaining limits

Dashboard tests: 153 files, 1,682 tests passed. Dashboard build passed.
Browser mock checks cover selection, card-setup return, explicit confirmation and incomplete setup.
Real Stripe setup/return and eligibility outcomes have not been exercised.
The resume mechanism introduces a new navigation contract; full-revert defect proof has not been run for the existing UI wording changes.

Review follow-up: membership lookup failure now exposes a retry rather than an indefinite skeleton. A lifecycle generation rejects late mutation responses even after switching away and back to the same organization. The membership regression test failed against the prior PR revision and passes with the recovery branch. Coverage includes interrupted checkout, unavailable storage, explicit exit, and late success/error responses.

Checkout resume preserves explicit Billing tabs and coupon links and ignores internal route navigation. The backend return has no transaction marker; a matching tab-local intent on the bare full-page Billing landing restores only confirmation, not payment authorization. Plan-setup mocks share the card flag for wallet and payment-method reads.

Return eligibility compares the saved document identifier to the current document; router history keys are not evidence of a checkout return. Browser Back within the same document cannot resume its newly saved intent. A new tab with an opener may inherit storage and restore confirmation, still without submitting a subscription.

显式 tab/code 导航清理当前用户和组织的待恢复套餐选择，无需等待 Owner 查询；因此后续内部导航到 Billing 不会恢复已放弃的选择。此操作只清理本地导航意图，不修改账户或订阅。
