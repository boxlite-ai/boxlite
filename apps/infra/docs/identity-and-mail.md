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

A social login has to reach the same BoxLite account as the password sign-up
that owns the address (POL-555). Linking happens before Auth0 issues a token,
so every token names the password account (`auth0|…`) and BoxLite never
provisions a second user or organization for the social identity.

```text
social login ─▶ Post-Login Action ─▶ GET /api/auth/link/start
                                        │ password account exists?
                                        ├─ yes: /authorize prompt=login
                                        └─ no:  /authorize screen_hint=signup
tenant login page ─▶ GET /api/auth/link/callback
                       code + PKCE → ID token → move local data → Management API link
                     ─▶ /continue ─▶ Action: setPrimaryUser → token sub = auth0|…
```

The second sign-in runs on the tenant's own Universal Login, so the password
account's whole login policy applies — its MFA included. An address the social
provider has not verified — GitHub can return one — is proven with the
email-verification Form first. The second sign-in must be a database account
holding that same verified address, in an ID token this tenant issued to the
dashboard client; anything else ends the login with no token.

This is Auth0's documented shape for linking during login: an Action redirects
to an external app that re-authenticates the target account, then validates
that app's answer and switches the primary user
([Link User Accounts](https://auth0.com/docs/manage-users/user-accounts/user-account-linking/link-user-accounts)).
Auth0 Forms can link without leaving the tenant, but no Forms action verifies
a password, so an email code would stand in for it and skip the account's MFA.

### The one setting

`OIDC_ACCOUNT_LINK_REDIRECT_SECRET` turns the link on by being set. It is the
HS256 key the Post-Login Action and the API sign every hop between them with —
Auth0's `encodeToken` and `validateToken` accept only a shared secret — and the
Action holds the same value as its `ACCOUNT_LINK_SECRET`:

| Token | Signed by | Checked by | Stops |
| --- | --- | --- | --- |
| session token, Action → `/start` | the Action | the API | a forged social id being linked into someone else's password account |
| state, `/start` → `/callback` | the API, encrypted under a key derived from the secret | the API | reading the PKCE verifier, or altering the transaction it carries |
| outcome, `/callback` → `/continue` | the API | the Action | a forged "linked" outcome naming an arbitrary primary account |

Generate it once per stage, at least 32 characters (RFC 7518 §3.2 wants
256 bits for HS256), and never reuse one stage's value in another.

Nothing else is configured. The second sign-in goes through the dashboard's
own client (`OIDC_CLIENT_ID`), redeemed with PKCE since that client holds no
secret. The tenant endpoints hang off the issuer the browser uses
(`PUBLIC_OIDC_DOMAIN`, else `OIDC_ISSUER_BASE_URL`); an issuer with a path is
refused at boot, since Auth0 always serves from the root of its domain. The
Action tells the API the database connection and the callback URL inside the
signed session token, from the values the configurator below deployed. The
link itself is a Management API call, so `OIDC_MANAGEMENT_API_ENABLED` must be
true; that client's `read:users` and `update:users` grants cover it.

### Configuring a stage

```bash
secret="$(openssl rand -base64 48)"
AUTH0_ACCOUNT_LINK_SECRET="$secret" npm run auth0:configure-login -- \
  --tenant <tenant> --client-id <spa> --connection <db> \
  --account-link-api-origin https://api.<stage domain> --apply
printf '%s' "$secret" | npm run mstage env set -- OIDC_ACCOUNT_LINK_REDIRECT_SECRET --stage <stage>
unset secret
```

On SST, set the same value with `npm run sst -- secret set` instead. Run the
configurator without `--apply` first to preview. Apply adds the API callback to
the SPA client's allowed callbacks, and upgrades an existing BoxLite-generated
Action in place, journaling what it replaced, so the printed rollback command
restores exactly that. Plain `http` is accepted only for `localhost`.

To rotate, repeat both writes with a new value and redeploy the API. Apply
rewrites the Action's key on every run, since Auth0 never returns a secret's
value to compare against; a rollback restores the Action's code and leaves its
key in place. A login
that started under the old value fails once, within the state's ten minutes.

### What the callback moves

When the social identity already had a BoxLite user — it signed in before this
flow existed — the callback moves that user's organization memberships, role
assignments, and API keys to the password account, in one transaction, and
only then links the identities at Auth0. The order matters: once linked, later
social logins reach the password account directly and never pass the callback
again, so a move left undone then would stay undone. A link that fails after
the move leaves the social login unlinked, so the next one runs the flow
again, and moving is idempotent. Boxes,
volumes, and usage belong to organizations and stay where they are. The
password account keeps its own default organization; the moved one becomes its
default only when the password account had none, which is the case for an
account the second sign-in just created. Organizations are never merged.

### Endpoints

`GET /api/auth/link/start` verifies the Action's session token, then redirects
to the authorize endpoint. `GET /api/auth/link/callback` decrypts its own
state, redeems the code, links, and returns the browser to `/continue` with the
outcome — failures included, so the Action can refuse the login on the page
the person is looking at.

Both answer 404 while the secret is unset, and 400 for a token that is
missing, expired, or signed with anything else. Those tokens are the tenant's,
not the user's, so the reason goes to the log rather than the response.

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
