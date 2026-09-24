## TL;DR

Configure identity and outbound mail separately from infrastructure deployment.

# Identity and mail operations

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
(`mdeploy/stack/providers/gcp/mail.ts`).

On the AWS path, use the stack's verified SES identity described in
[Outbound mail](#outbound-mail). The Api's stored `SMTP_PASSWORD` is
SigV4-derived and cannot be used as the raw AWS secret required by Auth0's SES
provider. Create a separate send-only IAM access key for Auth0, scoped to that
identity, then run the two reconcilers from this directory. Preview is the
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
Management API provider/template resources. The built-in service sends from
`no-reply@auth0user.net`, is limited to 10 messages per minute, and is not for
production.

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

**Adding a stage:** run `npm run bootstrap -- --stage <name>`, then add `<name>`
to the `options` of whichever Environment-selecting inputs should reach it —
`stage` in `.github/workflows/deploy-infra.yml` and `deploy-release.yml`, and
both `stage` and `source_stage` in `build-apps-api-image.yml` (a stage absent from
`source_stage` can never be promoted *from*). Those lists are allowlists, so a
typo cannot target a protected Environment, and they are deliberately
independent: see [.github/workflows/README.md](../../../.github/workflows/README.md)
for which path currently reaches which stage.

## Outbound mail

The stack verifies one Amazon SES domain identity (`MAIL_DOMAIN`, default
`mail.boxlite.ai`) and publishes its DKIM and DMARC records through the same
Cloudflare adapter the rest of the stack uses. The Api reaches SES over the SMTP
interface on port 465, so `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`
stay a vendor-neutral contract — only `stack/mail.ts` knows the backend is SES.
Two senders use that one identity: the Api's organization invitation, and Auth0's
verification and reset codes.

```text
bootstrap --stage <s> --provision-ses   IAM user boxlite-<s>-smtp, send-only on this identity
  └─ access key                → SMTP_USER + SMTP_PASSWORD (SigV4-derived) in the secret store
       └─ deploy               stack/mail.ts → SES identity + DKIM/DMARC → Api SMTP_* env
```

- **The credential is bootstrap's, not the deploy's.** The deploy role holds IAM
  on roles only, so it cannot create the user or its access key; `--provision-ses`
  does that with the operator's credentials. Rerunning rotates the key and revokes
  the previous one.
- **The sandbox exit rides along, once the domain is verified.** A new SES account
  sends 200 messages/day to verified recipients only, and `--provision-ses` asks
  AWS to lift that — but only when `sesv2 get-email-identity` reports the sender
  domain verified. On a first bootstrap it is not (the deploy creates the
  identity), so the request is deferred with a message saying to deploy and rerun.
  A request made with no identity behind it is the shape AWS denies, and there is
  only one submission to spend: it reads `sesv2 get-account` and does nothing once
  access is granted, nothing while a review is open, and reports the case id when a
  review has closed DENIED or FAILED rather than resubmitting — AWS answers a
  second submission with ConflictException, so a denial is worked through that
  support case. Account-and-region wide, so the first stage bootstrapped in a
  region covers the rest, and a failure here never fails the bootstrap.
- **No credential, no mail.** `SMTP_HOST` resolves to empty unless both
  `SMTP_USER` and `SMTP_PASSWORD` are set — nodemailer authenticates only with
  both, so half a credential would send unauthenticated and be refused on every
  message. The Api reports the empty host once at boot as email disabled;
  invitations are still created, just not delivered.
- **One stage per domain.** An SES identity is unique per account and region.
  A second stage needs its own subdomain, or adopts the existing identity with
  `sst.aws.Email.get`.
- Sending costs $0.10 per 1,000 messages, which is why it has no line in [Cost]().
