## TL;DR

Configure identity and outbound mail separately from infrastructure deployment.

# Identity and mail operations

[Infrastructure index](../README.md) · [Deployment](deployment.md) · [Branding assets](../auth0/branding/ASSETS.md)

## OIDC application setup

Run infra commands from `apps/infra`. The API validates issuer/JWKS and audience; the dashboard
needs the SPA client ID and callback/logout/web-origin URLs for its actual public host.
`DASHBOARD_DOMAIN` overrides the dashboard host without moving `api.<STACK_DOMAIN>`.

For a new AWS/Auth0 setup, `bootstrap --provision-auth0` creates the SPA and custom API.
This option is not idempotent: repeating it creates duplicates. The GCP bootstrap path does not
provision Auth0; create/configure the equivalent identities in the tenant, then store the values
through [mstage](configuration.md). Other compatible OIDC providers need equivalent manual setup.
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

The policy needs mail to leave the tenant, not a particular vendor: any enabled
provider that is not Auth0's own built-in sender satisfies it. SES is the one
backend this repo provisions itself, so it is the one `auth0:configure-email`
can create; a tenant already sending through Resend, Mailgun or an SMTP relay
keeps that provider and reconciles only the templates with `--templates-only`
(below). A GCP-homed stage has no SES identity at all — it sends through the
relay named by `MAIL_RELAY_HOST` and verifies nothing
([GCP mail provider](../mdeploy/stack/providers/gcp/mail.ts)).

On the AWS path, use the stack's verified SES identity described in
[Outbound mail](#outbound-mail). The Api's stored `SMTP_PASSWORD` is
SigV4-derived and cannot be used as the raw AWS secret required by Auth0's SES
provider. Create a separate send-only IAM access key for Auth0, scoped to that
identity, then run the two reconcilers from `apps/infra`. Preview is the
default and performs no writes:

```bash
# Request the Management API scopes used by preview, apply, and rollback.
npm run auth0:login-policy-login

# Preview the tenant-wide SES provider and checked-in code templates.
npm run auth0:configure-email -- \
  --tenant <tenant.auth0.com> \
  --from <verified-sender@example.com> \
  --region <ses-aws-region>

# Apply prompts for the SES access key ID and secret access key without echoing
# either value. For non-interactive use, set AUTH0_EMAIL_SES_ACCESS_KEY_ID and
# AUTH0_EMAIL_SES_SECRET_ACCESS_KEY only for this process.
npm run auth0:configure-email -- \
  --tenant <tenant.auth0.com> \
  --from <verified-sender@example.com> \
  --region <ses-aws-region> \
  --apply

npm run auth0:configure-login -- \
  --tenant <tenant.auth0.com> \
  --client-id <boxlite-spa-client-id> \
  --connection <database-connection-name>

# Inspect the exact tenant/client/connection/resource plan, then apply it:
npm run auth0:configure-login -- \
  --tenant <tenant.auth0.com> \
  --client-id <boxlite-spa-client-id> \
  --connection <database-connection-name> \
  --apply
```

The email reconciler creates the SES provider only when none exists and creates
the `verify_email_by_code` and `reset_email_by_code` templates only when they
are absent. It refuses to replace a different provider or customized template.
Its mode-`0600` receipt under `.sst/auth0-backups/` contains the SES region and
sender but never the access key. Rollback disables templates created by the run
and deletes the provider only when the run created it and its non-secret
fingerprint is unchanged.

For a tenant whose provider is already configured and is not SES, reconcile the
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

## Outbound mail

| Stage home | Application mail backend | Setup |
| --- | --- | --- |
| GCP | External SMTP relay on port 465 | Set `MAIL_DOMAIN`, `MAIL_RELAY_HOST`, `SMTP_USER` and `SMTP_PASSWORD`; verify the sender with the relay provider |
| AWS | SES SMTP on port 465 | Declare `MAIL_DOMAIN`, deploy DNS/SES identity, provision SMTP credential, then verify sending |
| Either, mail disabled | No sender domain | Invitations may be created without email delivery |

GCP's mail provider creates no sender-verification resources and explicitly reports the relay as
unverified. Configuring the BoxLite relay does not configure Auth0's email provider.
Use mstage secret stdin for SMTP credentials and redeploy the API after changing its configuration.

On AWS, `npm run bootstrap -- --stage <stage> --provision-ses` creates a send-only IAM user and
stores `SMTP_USER` plus its SigV4-derived `SMTP_PASSWORD`. Rerunning rotates the credential.
The operator performs this privileged step; the ordinary deploy role cannot create the IAM user.

The AWS stack publishes the configured sender's DKIM/DMARC records. If the identity is not yet
verified on first bootstrap, deploy it and rerun the SES provisioning step. Bootstrap requests SES
production access only after verification, reports an existing review/case, and does not repeatedly
resubmit a denied case. Check the account's current regional SES sandbox and quota status.

An SES identity is unique to its account/region/domain. Give separate stages their intended domains
or explicitly design shared ownership. Auth0's SES integration needs a separate raw send-only AWS
credential; the application's derived SMTP password cannot substitute for it.

Verify application invitations and identity-provider verification/reset emails independently.
Sources: [GCP mail](../mdeploy/stack/providers/gcp/mail.ts), [AWS mail](../mdeploy/stack/providers/aws/mail.ts),
[bootstrap](../bootstrap/bootstrap.ts), and [API environment](../mdeploy/src/api-environment.ts).

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
