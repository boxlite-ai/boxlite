## TL;DR

GCP uses an external SMTP relay for application mail and requires separate OIDC and Auth0 tenant configuration.

# GCP identity and mail

[Cloud guide](README.md) · [Infrastructure index](../../README.md)

## OIDC setup

GCP bootstrap does not create Auth0 resources. Create the SPA and custom API in the intended tenant,
configure its callbacks/logout/web origins for the actual dashboard host, then store issuer, audience
and `OIDC_CLIENT_ID` through [mstage](../configuration.md).
Other compatible OIDC providers need equivalent manual setup.

## Application mail

Set `MAIL_DOMAIN`, `MAIL_RELAY_HOST`, `SMTP_USER` and `SMTP_PASSWORD` for an external relay on port 465.
The GCP mail provider creates no sender-verification resources and reports the relay as unverified;
verify the sender with the relay provider. Use secret stdin for credentials and redeploy the API after changes.
Without a sender domain, invitations can be created without mail delivery.

## Auth0 email

Configure an enabled external sender in Auth0 separately. The BoxLite relay does not configure the tenant.
For an existing sender, use the shared [templates-only procedure](../identity-and-mail.md#auth0-email-first-login-policy)
and its exact provider sender address before applying the login policy.
Keep application invitations and Auth0 verification/reset tests separate.

Use the shared [login policy and canaries](../identity-and-mail.md#auth0-email-first-login-policy)
and [branding procedure](../identity-and-mail.md#universal-login-branding).

Sources: [mail provider](../../mdeploy/stack/providers/gcp/mail.ts),
[API environment](../../mdeploy/src/api-environment.ts).
