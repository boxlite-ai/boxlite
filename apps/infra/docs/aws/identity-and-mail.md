## TL;DR

AWS provisions application SMTP through SES and uses a separate raw send-only credential for Auth0’s SES integration.

# AWS identity and mail

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

## OIDC setup

For a new Auth0 setup, `npm run bootstrap -- --stage <stage> --provision-auth0` creates the SPA and custom API.
This operation is not idempotent: rerunning creates duplicates. Review the intended tenant and existing resources first.
Configure callback/logout/web-origin URLs for the dashboard host and store the OIDC values for the selected app.

## Application mail

Declare `MAIL_DOMAIN` and use SES SMTP on port 465. Without a sender domain, invitations can exist without email delivery.
`npm run bootstrap -- --stage <stage> --provision-ses` creates a send-only IAM user and
stores `SMTP_USER` plus its SigV4-derived `SMTP_PASSWORD`. Rerunning rotates the credential.
The operator performs this privileged step; the ordinary deploy role cannot create the IAM user.

The AWS stack publishes the configured sender's DKIM/DMARC records. If the identity is not yet
verified on first bootstrap, deploy it and rerun the SES provisioning step. Bootstrap requests SES
production access only after verification, reports an existing review/case, and does not repeatedly
resubmit a denied case. Check the account's current regional SES sandbox and quota status.

An SES identity is unique to its account/region/domain. Give separate stages their intended domains
or explicitly design shared ownership. Auth0's SES integration needs a separate raw send-only AWS
credential; the application's derived SMTP password cannot substitute for it.

Use secret stdin for SMTP values and redeploy the API after configuration changes.

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

The email reconciler creates the SES provider only when none exists and creates
the `verify_email_by_code` and `reset_email_by_code` templates only when they
are absent. It refuses to replace a different provider or customized template.
Its mode-`0600` receipt under `.sst/auth0-backups/` contains the SES region and
sender but never the access key. Rollback disables templates created by the run
and deletes the provider only when the run created it and its non-secret
fingerprint is unchanged.

For an existing external sender, keep that provider and use the shared
[templates-only procedure](../identity-and-mail.md#auth0-email-first-login-policy).
Then follow the shared login-policy preview/apply, canaries and rollback instructions.
Verify application invitations and Auth0 verification/reset messages independently.

Sources: [mail provider](../../mdeploy/stack/providers/aws/mail.ts),
[bootstrap](../../bootstrap/bootstrap.ts), [API environment](../../mdeploy/src/api-environment.ts).
