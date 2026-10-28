## TL;DR

Grant default Cloud organizations 16 vCPU / 32 GiB / 100 GiB per Box only while Commerce grants subscription entitlements. Keep PAYG at 4/8/10 and preserve administrator overrides.

## Scope

Issue: https://linear.app/polygala/issue/POL-1208/提高-cloud-box-规格medium-20gblarge-50gbcustom-16c32g100gb

Preserve administrator quota overrides and grant higher limits dynamically from subscription entitlements. This replaces the proposal to raise every organization's persisted defaults.

Eligible organizations can create Medium 2/4/20, Large 4/8/50 and Custom 16/32/100. No subscription, expired/canceled subscription, or suspended entitlements gets the historical limits. A cancellation scheduled for period end retains access until Commerce reports the period ended. Dunning grace retains access, hold does not. No new subscription tiers, migration, billing charge, existing-Box resize/stop, or concurrency-policy changes. A custom quota means any persisted tuple other than exactly 4/8/10; an explicit override equal to that tuple is indistinguishable from the historical default.

## Research and alternatives

- BoxLite at 435e77193: apps/api/src/organization/entities/organization.entity.ts:34-59 stores 4/8/10; apps/api/src/box/services/box.service.ts:220-241 validates the organization tuple before persistence. apps/api/src/box/services/per-box-limits.ts:10-48 also caps CPU at the guest kernel's 16. Keep that hard cap and existing validation path.
- Dashboard apps/dashboard/src/components/Box/CreateBoxDialog.tsx:37-58 reads returned organization quotas, and its applySizePreset clamps preset requests. Resolve quotas on organization responses and the shared BoxService.create boundary so Dashboard, legacy endpoints and REST/SDK share authority. Avoid a second frontend subscription policy.
- Commerce at 9c5af40: src/subscriptions/queries/read-subscription.ts:44-89 derives live subscription state, missing/expired means null, cancellation before expiry reports active plus cancelAtPeriodEnd, and dunning projects explicit entitlements. src/subscriptions/api/subscriptions.controller.ts:25-30 wraps the result in {plan}, or {}. Preserve this envelope and derive the additional capability in the subscriptions policy. The controller serves both durable and mock implementations. Inspection found a mock contract mismatch: src/mock/mock-billing.service.ts:267-286 reports stored canceled while its period is live. Normalize this producer to active plus cancelAtPeriodEnd, matching the durable producer, and update the existing mock lifecycle assertion. This is needed for the new entitlement grant to work consistently in both modes.
- Existing BoxLite CommerceBoxLimitService (apps/api/src/boxlite-rest/commerce-box-limit.service.ts:132-178) resolves concurrency via the public catalog and deliberately fails open on transient outages. Its catalog fallback also treats PAYG as the first catalog plan. Neither behavior is suitable for a subscription-only resource grant; keep concurrency unchanged and use the organization plan read directly.
- Stripe, "Provision access to your product", https://docs.stripe.com/billing/subscriptions/overview#provision-access-to-your-product (read 2026-10-27): provision from active entitlements. Adapt the mechanism to Commerce's existing lifecycle, not raw Stripe status, because Commerce also owns managed subscriptions and local mock mode.
- Stripe, "Get customers' active entitlements", https://docs.stripe.com/billing/entitlements?dashboard-or-api=api#get-customers-active-entitlements (read 2026-10-28): the billing system updates entitlements during the subscription lifecycle and applications provision from those results. Apply this boundary by treating Commerce's authenticated perBoxLimits as its effective decision. Reject repeating planId, status, or entitlements checks in BoxLite: those metadata fields can evolve independently of the resource grant. Commerce tests own lifecycle eligibility; BoxLite tests own grant validation and enforcement.
- OWASP Authorization Cheat Sheet, "Deny by Default" and "Validate the Permissions on Every Request", https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html#deny-by-default (read 2026-10-27): check at the server boundary, default to no additional grant. Apply this only to the new uplift; retain established administrator overrides.
- Reject the runner branch's b03ce513e migration: it permanently grants 16/32/100 to all default organizations and loses the ability to distinguish a baseline from an override. It is absent from current main and must not be combined with this implementation. No migration is necessary here.
- Reject copying subscription state into organization database columns or caching grants: either needs revocation/invalidation and introduces stale grants. Resolve current Commerce state on each creation and organization read, with a 2-second timeout. This adds a bounded Commerce read; a later performance change must preserve revocation semantics.

## How it works

Commerce adds plan.perBoxLimits = {maxCpuPerBox,maxMemoryPerBox,maxDiskPerBox} to its existing organization-plan response. Its subscription policy returns 16/32/100 for active subscriptions (unless explicitly suspended) and past_due with entitlements=active; otherwise 4/8/10. All live plans, including managed ones absent from the public catalog, qualify. No-plan stays exactly {}. No database changes or public catalog changes.

BoxLite adds one organization-owned resolver, exported from OrganizationModule. It copies the persisted tuple, preserves non-default tuples, and for default organizations reads Commerce with the existing configured billing URL and shared service token. Missing configuration, missing new field during rollout, failed lookup, or invalid response cannot grant an uplift and returns 4/8/10. Validate the URL, avoid redirects, use the 2-second timeout, encode the organization ID, validate the response envelope and positive safe-integer quota fields, and log failures without tokens or response bodies. Consume perBoxLimits without interpreting planId, status, or entitlements; Commerce alone computes subscription eligibility. Do not persist resolved quotas or mutate an entity that could later be saved.

Dashboard OrganizationsProvider holds organizations in React state (apps/dashboard/src/providers/OrganizationsProvider.tsx:33-46), not the React Query organization keys; invalidating a query would not update its selected organization. Refresh that existing provider when CreateBoxDialog opens, so same-session subscription upgrades/recovery and cancellation are reflected without duplicating billing policy in the UI.

All OrganizationController DTO responses use this resolver; BoxService.create independently resolves again immediately before its existing resource assertion. Thus a stale browser cannot bypass a canceled subscription. The existing CPU hardware cap remains. Existing Boxes can continue to run/restart: this is a creation entitlement, not retroactive resource reclamation.

Deployment: Commerce first enables the additive field; BoxLite first is conservative at 4/8/10 until Commerce upgrades. Rollback of either side restores historical creation limits without database rollback. Drop the unconditional quota migration when integrating the separate runner work.

The implementation adds no dependencies or database migration.

## Validation

Validation plan:

- Commerce controller tests: active, managed, cancellation scheduled, past_due grace, hold, canceled, no plan; check unchanged envelope/fields and new effective limits. Add assertions to real existing lifecycle E2E cases where services are available.
- BoxLite resolver tests with mocked HTTP: valid effective grants without subscription metadata or with independently changing metadata, missing/old/malformed responses, each invalid numeric field, network errors, config/URL errors, baseline/custom quotas, no entity mutation, repeated grant changes. Metadata must not override an authenticated valid grant; invalid grants must still fall back regardless of metadata.
- Shared BoxService tests through REST mapper: subscriber maximum reaches persistence, each dimension over effective limit is refused, PAYG medium/large requests fail before side effects, custom limits remain honored. Organization controller tests prove the displayed quota uses the same resolver.
- Dashboard existing preset/stepper tests plus subscribed 16/32/100 fixtures prove Medium 20, Large 50, Custom maximum and over-limit clamping. Verify opening the dialog refreshes the organization provider, including after subscription changes.
- First observe behavioral assertions fail on baseline code (test-only compatibility adapters if new symbols require them), then implement and rerun. Run each test through a standalone make test target. Commerce adds a small target delegating to its existing npm test suite.
- Run relevant repository formatting/build/lint/test/doc checks. Maximum-size guest execution requires a capable runner and is not established by local unit tests; report this limitation honestly.

Initial implementation validation, before simplifying the consumer boundary: baseline regressions failed before the implementation and passed afterward. Full API, Dashboard, and Commerce default suites passed, as did the Commerce PostgreSQL subscription lifecycle tests. API and Dashboard builds and Commerce build, formatting, migration validation, and README checks passed. BoxLite-wide formatting and lint checks still report existing failures in untouched files; the aggregate build cannot link the runner without its native static library. Maximum-size guest execution remains unverified. The boundary simplification requires a new red/green resolver run and the shared creation tests.
