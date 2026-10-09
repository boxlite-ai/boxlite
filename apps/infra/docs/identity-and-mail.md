## TL;DR

Keep cloud-specific sender setup separate from the shared OIDC, Auth0 login-policy and branding procedures.

# Shared identity and branding

[Infrastructure index](../README.md)

## OIDC application setup

Run infra commands from `apps/infra`. The API validates issuer/JWKS and audience; the dashboard
needs the SPA client ID and callback/logout/web-origin URLs for its actual public host.
`DASHBOARD_DOMAIN` overrides the dashboard host without moving `api.<STACK_DOMAIN>`.

For a new OIDC setup, follow the selected cloud’s [GCP](gcp/identity-and-mail.md) or [AWS](aws/identity-and-mail.md) procedure.
Other compatible OIDC providers need equivalent manual setup.
Application invitation mail and the identity provider's verification/reset mail are separate systems.

## Auth0 email-first login policy

Run this only for a dedicated BoxLite Auth0 tenant. Identifier First is a
tenant-wide setting. The selected database connection gets this behavior:

```text
new account       email -> 6-digit email OTP -> create password -> token
returning account email -> password -> token
password reset    email -> email OTP -> create password
```

Existing unverified database users receive a hosted Auth0 verification Form on
their next browser login. Social and enterprise connections, other Auth0
applications, and non-`auth0` subjects are outside this policy.

This policy uses Auth0's email OTP verification for signup and password reset;
it does not add email OTP as a passwordless login method. Password remains the
returning-user authentication method. If the connection already has a separate
email OTP login method, the reconciler leaves that operator-owned setting
unchanged.

For an existing database connection, first open Auth0 Dashboard > Authentication
> Database > the selected connection > Attributes, select **Activate**, confirm
the development-environment impact acknowledgement, and save the default email
attribute. Auth0 requires this one-time New Attributes Configuration activation
before the Management API can configure email verification OTP. Preview fails
before any writes when the activation is absent.

Authenticate with the Management API scopes used by preview, apply and rollback:

```bash
npm run auth0:login-policy-login
```

The policy requires an enabled email provider other than Auth0's built-in sender. Configure tenant mail
through the [GCP identity/mail guide](gcp/identity-and-mail.md) or
[AWS identity/mail guide](aws/identity-and-mail.md) before applying the login policy.
The application's SMTP configuration does not configure Auth0's sender.

For a tenant whose provider is already configured, reconcile the
templates alone. `--templates-only` takes no `--region`, writes nothing to
`emails/provider`, and never asks for a credential; it refuses unless the
tenant already has the same enabled non-Auth0 provider the login policy
requires, and unless `--from` is that provider's own sender — a template's
`from` overrides the provider default, so a mismatch would send the codes as an
address the provider cannot:

```bash
# The sender to pass is the provider's own; read it back first.
auth0 api get 'emails/provider?fields=name,enabled,default_from_address&include_fields=true' \
  --tenant <tenant.auth0.com>

npm run auth0:configure-email -- \
  --tenant <tenant.auth0.com> \
  --from <provider-default-from-address> \
  --templates-only \
  --apply
```

Preview the login policy, inspect the tenant/client/connection/resource plan, then apply:

```bash
npm run auth0:configure-login -- \
  --tenant <tenant.auth0.com> \
  --client-id <boxlite-spa-client-id> \
  --connection <database-connection-name>

npm run auth0:configure-login -- \
  --tenant <tenant.auth0.com> \
  --client-id <boxlite-spa-client-id> \
  --connection <database-connection-name> \
  --apply
```

For a non-production canary tenant only, skip `auth0:configure-email` and add
`--allow-test-email-provider` to both `auth0:configure-login` commands. This
uses Auth0's built-in sender and default templates; they do not appear as
Management API provider/template resources. The built-in sender is intended for testing, not production; verify current tenant limits before a canary.

Login-policy apply refuses before its first write when the Auth0 CLI's session
for the tenant lacks a scope it writes with, naming the missing ones: apply
spans the connection, prompts, a Form, two Flows and an Action, and a session
short one scope stops partway with resources already created.

Login-policy apply writes a mode-`0600` rollback journal under
`.sst/auth0-backups/` without client secrets. If apply stops partway, use the
exact rollback command printed in the error. The reconciler preserves unrelated
connection options and post-login Actions; it unbinds the superseded
`boxlite-custom-claims` Action. Retain successful journals: their created-resource
receipts are the proof required to reuse the otherwise opaque Auth0 Vault connection.
If a same-named Form or Flow differs from the checked-in graph, apply fails before
writing instead of backing up arbitrary remote payloads.

Before deploying the BoxLite API JWT guard, run all five live canaries against
the Auth0 tenant:

1. New database signup: email OTP, then password creation.
2. Returning database login with password.
3. Password reset with email OTP.
4. Existing unverified database login: Form, invalid-code error, resend, then success.
5. Social login remains unchanged.

The deployment order is intentional: Auth0 apply -> live canaries -> BoxLite
API deploy. The API then rejects old unverified `auth0|...` access tokens across
HTTP, Socket.IO, and the WebSocket proxy. It does not revoke refresh tokens or
retroactively gate independently validating Commerce/Analytics services.

## Account linking at login

Google, GitHub and a password sign-up holding one address have to reach the
same BoxLite account (POL-555). The link happens inside Auth0: the Post-Login
Action folds a login into the account that already holds its address once the
person proves that account is theirs, and nobody is asked to set a password.
BoxLite never receives a password.

Moving BoxLite's own rows is the one step Auth0 cannot take. Before it links,
the Action asks the API with `POST /api/auth/link/adopt`, a server-to-server
call carrying an HS256 bearer token signed with `OIDC_ACCOUNT_LINK_SECRET`. The
token names the user being folded as `sub` and the account that stays as
`primary_user_id`, with the audience `boxlite-account-link-adopt`, and is
refused once it is older than a minute. `GET /api/auth/link/status`, signed the
same way for the audience `boxlite-account-link-status`, answers
`{"known": true}` when BoxLite already has the user named in `sub`. Without the
secret both endpoints answer 404; a key shorter than 32 characters stops the
API at boot. The key reaches the API on both deploy paths: SST declares
`OIDC_ACCOUNT_LINK_SECRET` as a secret that defaults to empty, and mdeploy
fetches it from the stage's optional API group.

### The Action's part

The Post-Login Action looks at every interactive BoxLite browser login, through
the database connection or a social one, whose user has a single sign-in; a
user already linked reaches its account directly. A login without an address
keeps its own identity. A token refresh keeps the identity it has until the
next browser login, which spares the Management API a lookup per refresh. The
Action looks up the other users holding the address with a verified email; an
unverified one is left alone, since a stranger may have signed the address up.
If the lookup fails before a link page shows, the login goes through unlinked
and the next one looks again: Auth0 allows a free or trial tenant's Management
API 2 requests a second
([Rate Limit Policy](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy)).
The flow:

1. An address the provider has not verified goes through the email Form's code
   first, as an unverified password account's does.
2. With no other account holding the address, the login goes on: it is the
   account.
3. When one of them holds a password, the link page shows the address and asks
   for that password, which the Action checks with the password-realm grant
   through the link client, forwarding the browser's address in
   `auth0-forwarded-for`.
4. When only social accounts hold it, the mailbox is the proof. Google on a
   Gmail address, and a password sign-up's first login, whose address Universal
   Login verified moments ago, have proven it already. Otherwise the link page
   asks to continue to a code, and the email Form mails one there.
5. Once proven, the Action asks the API to move the data of every user it
   folds, then links them through the Management API, and makes the account
   that stays the token's subject.

A password proves its own account; social accounts apart from it join in the
same login only when the mailbox is proven too, and otherwise at their own next
login. The account that stays is one that already joins several sign-ins;
otherwise the highest-ranked, password before Google before GitHub, where this
login counts only when BoxLite already knows its user. A login BoxLite has
never seen therefore joins an existing account and makes no organization of
its own. The design, POL-735, lists every case.

A wrong password shows the page again with the reason, as often as the person
tries; Auth0's brute-force protection still counts each attempt.
`mfa_required`, a blocked account, or an API or tenant error ends the login
with a message, and the next login starts over; moving the data again is
harmless.

The Action depends on three things outside its code:

- **The link Form**: a Password field with the id `password`, which the Action
  rather than the Form requires. The Action renders it with the vars `email`,
  `lead` and `error`.
- **The link client**: a confidential client allowed the password-realm grant,
  with Trust Token Endpoint IP Header on so Auth0 honours
  `auth0-forwarded-for`, and granted `read:users` (the lookup) and
  `update:users` (linking) on the Management API.
- **Three secrets**: `ACCOUNT_LINK_SECRET`, the same key as the API's
  `OIDC_ACCOUNT_LINK_SECRET`, and the link client's `ACCOUNT_LINK_CLIENT_ID`
  and `ACCOUNT_LINK_CLIENT_SECRET`.

The configurator provisions none of them yet. It hydrates the tenant domain
into the Action's code and leaves the API origin and the link Form's id empty,
so the link is off.

### What the link moves

When a folded user already had a BoxLite user — it signed in before — the API
moves that user's organization memberships, role assignments, and API keys to
the user of the account that stays, in one transaction. Moving is idempotent: a
second move finds nothing left to move. A moved key whose name the staying user
already uses in that organization gets the folded user's provider as a suffix,
such as `ci (google-oauth2)`, numbered when that name is taken too. Boxes,
volumes, and usage belong to organizations and stay where they are. The staying
user keeps its own default organization; the moved one becomes its default only
when it had none. Organizations are never merged. The dashboard reopens the
organization last chosen, else the default one; someone in more than one sees
them all under Organization Settings, where Switch opens another.

The API caches a validated key with its owner for
`API_KEY_VALIDATION_CACHE_TTL_SECONDS` (10 by default). Once the move commits,
it drops each moved key from that cache, so the key's next request reads its
new owner instead of waiting the cache out; a request already reading the
database during the move can still cache the old owner until it expires. If
Redis cannot be reached, the move still stands and the entries expire on their
own.

## Outbound mail

Use the [GCP SMTP procedure](gcp/identity-and-mail.md#application-mail) or
[AWS SES procedure](aws/identity-and-mail.md#application-mail) for the application sender.
When mail is disabled, invitations may be created without delivery. Verify application invitations
and identity-provider verification/reset messages independently.

## Universal Login branding

Deploy the dashboard assets first, then preview the reviewed stage target:

```bash
npm run auth0:universal-login -- preview --stage dev
npm run auth0:universal-login -- apply --stage dev
```

The command verifies live stack identity, media types and public CORS before writes. Its target
catalog is separate from the mstage declaration; update/review the intended tenant and origins before
using it for a new stage. It manages theme, tenant image and prompt text; widget geometry remains
Auth0-managed. [ASSETS.md](../auth0/branding/ASSETS.md) records hashes, licenses and update steps.
