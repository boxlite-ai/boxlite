## TL;DR

AWS provisions application SMTP through SES and uses a separate raw send-only credential for Auth0’s SES integration.

# AWS identity and mail

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

## OIDC setup

Create a single-page application and a custom API in the stage’s Auth0 tenant.
Configure callback/logout/web-origin URLs for the dashboard host and store the OIDC values for the selected app.

## Application mail

Declare `MAIL_DOMAIN` and use SES SMTP on port 465. Without a sender domain, invitations can exist without email delivery.

Provision a send-only IAM user for the verified sender identity and derive its regional SMTP password. Store the application credentials in the stage configuration before deploying the API.

The AWS stack publishes DKIM and DMARC records and waits for SES to verify the identity.
Check the regional SES sandbox status and sending quota. Request production access from SES to send to unverified recipients.

An SES identity is unique to its account/region/domain. Give separate stages their intended domains
or explicitly design shared ownership. Auth0's SES integration needs a separate raw send-only AWS
credential; the application's derived SMTP password cannot substitute for it.

Set `SMTP_USER` and `SMTP_PASSWORD` in the encrypted stage store using the secret stdin procedure. Redeploy the API after rotating these credentials.

## Auth0 SES provider

Auth0's SES provider needs the separate raw send-only credential scoped to the verified sender identity.
Run the email reconciler from `apps/infra`, then use the shared login-policy procedure below.
Preview is the default and performs no writes:

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
```

The email reconciler creates the SES provider only when none exists, and it
refuses to replace a different provider. The checked-in
`verify_email_by_code` and `reset_email_by_code` templates are the source of
truth: a missing template is created, and one that differs is updated. Preview
lists each template as `create`, `reuse` or `update`, and names the fields an
update would overwrite.

Its mode-`0600` receipt under `.sst/auth0-backups/` contains the SES region and
sender but never the access key. Before updating a template, it records the
tenant's previous values for the fields it writes.

Rollback works through the receipt:

- **Created templates:** disabled, since Auth0 cannot delete them.
- **Updated templates:** restored to the recorded values, unless edited after the run.
- **Provider:** deleted only when the run created it and its non-secret fingerprint is unchanged.

The verify email puts the code in its subject so it shows in notifications. The
reset email keeps the code out of the subject and first line, because a
lock-screen preview could expose a code that resets the password.

For an existing external sender, keep that provider and use the shared
[templates-only procedure](../identity-and-mail.md#auth0-email-first-login-policy).
Then follow the shared login-policy preview/apply, canaries and rollback instructions.
Verify application invitations and Auth0 verification/reset messages independently.

Sources: [mail provider](../../mdeploy/stack/providers/aws/mail.ts),
[bootstrap](../../bootstrap/bootstrap.ts), [API environment](../../mdeploy/src/api-environment.ts).
