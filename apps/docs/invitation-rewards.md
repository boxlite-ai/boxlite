# Organization invitation codes

The organization stores three nullable fields: `referralCode` is its globally unique sharing code;
`inviterOrganizationId` is its original inviting organization ID; `referredCode` is the original code
snapshot for audit. Attribution uses the ID. The two attribution fields have no foreign keys and
are not cleared when the inviting organization is deleted. Registration writes them in the next change.

`GET /api/organizations/:organizationId/referral-code` requires an existing JWT or organization-scoped
API key and organization access. It returns only `{ organizationId, referralCode }` with
`Cache-Control: private, no-store`. The sharing URL is constructed by the Dashboard later.

The service locks the organization row, returns an existing code or generates 10 cryptographically
random characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. Only the named code-uniqueness conflict
is retried using savepoints, at most five times. Unavailable organizations return 403; lock timeouts
and collision exhaustion return 503. Reads never modify invitation attribution.

`AddOrganizationReferral1789500000000` adds the three columns and unique code constraint on top of
the main schema. Existing organizations retain NULL values. Its down migration refuses to erase
any issued code or attribution; retain the schema when rolling back an active application.

Set `REFERRAL_ARTIFACTS_DIR` to an absolute artifact directory, then use
`make test:apps:referral:unit`, `make typecheck:apps:referral` and `make generate:apps:referral`.
Database and registration coverage is added with the registration change.
