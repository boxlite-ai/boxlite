// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

export interface MailInputs {
  /** DNS adapter for the zone serving the sender domain — the DKIM and DMARC records land there. */
  dns: ReturnType<typeof sst.cloudflare.dns>
  /** Verified sender domain, from deployment/environment.ts resolveMailDomain. */
  senderDomain: string
  /** Regional SES SMTP host, from deployment/environment.ts sesSmtpEndpoint. */
  smtpHost: string
  /** SES SMTP username: the access key id of the send-only IAM user (see bootstrap `--provision-ses`). */
  smtpUser: sst.Secret
  /** SES SMTP password: that key's secret, run through SES's SigV4 derivation. */
  smtpPassword: sst.Secret
}

export interface MailResources {
  /** Exactly the SMTP_* pairs the Api reads (apps/api configuration.ts). */
  smtpEnvironment: Record<string, string | $util.Output<string>>
}

/*
 * Outbound mail for the control plane: one verified SES domain identity, its DKIM
 * and DMARC records, and the SMTP settings the Api sends through.
 *
 * SES is reached over its SMTP interface rather than the SESv2 SDK so the
 * application keeps one vendor-neutral contract — SMTP_HOST/PORT/USER/PASSWORD —
 * that a self-hosted deploy can point at any provider. Only this file knows the
 * backend is SES.
 *
 * The identity is account-and-region unique, so exactly one stage may create
 * MAIL_DOMAIN. A second stage sharing the same domain adopts it with
 * `sst.aws.Email.get('Mail', domain)` instead; give a stage its own subdomain
 * when its bounces should not touch the shared domain's reputation.
 */
export function buildMail(input: MailInputs): MailResources {
  const { senderDomain } = input

  // Creates the SES configuration set and domain identity, publishes the three
  // DKIM CNAMEs and the DMARC TXT through `dns`, then blocks the deploy on SES
  // observing the records. A domain whose zone this token cannot write fails
  // here rather than at the first send.
  new sst.aws.Email('Mail', {
    sender: senderDomain,
    dns: input.dns,
    transform: {
      // The deploy role's SES grant is scoped to `configuration-set/boxlite-<stage>-*`,
      // and SST would satisfy that on its own: sesv2 configuration sets are in its
      // namingRules, so an empty name becomes `boxlite-<stage>-MailConfig-<hash>`.
      // Naming it here says that out loud instead of leaving the grant resting on a
      // prefix applied elsewhere — and `boxlite-dev-mail` is what an operator reading
      // the SES console or a bounce metric sees.
      configurationSet: (args: any) => {
        args.configurationSetName = `${$app.name}-${$app.stage}-mail`
      },
    },
  })

  // Port 465 (TLS wrapper) over 587 (STARTTLS): the session is encrypted from the
  // first byte, so there is no cleartext handshake for a downgrade to strip, and
  // EC2 throttles outbound 25 — which the NAT instances these tasks egress
  // through would inherit.
  const { smtpHost } = input

  // No credential, no host. The Api treats a missing SMTP_HOST as "email disabled"
  // and logs it once at boot; a host with half a credential would instead build a
  // transport that authenticates against SES and is refused on every single send.
  // Both halves, because nodemailer sends unauthenticated unless it has both.
  // Keys stay static (synth-time) — only the value depends on the secrets.
  const hostWhenCredentialed = input.smtpUser.value.apply((user: string) =>
    input.smtpPassword.value.apply((password: string) => (user && password ? smtpHost : '')),
  )

  return {
    smtpEnvironment: {
      SMTP_HOST: hostWhenCredentialed,
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: input.smtpUser.value,
      SMTP_PASSWORD: input.smtpPassword.value,
      // Derived, not configurable: SES rejects a From address outside the verified
      // identity, so the two must not be able to drift apart.
      SMTP_EMAIL_FROM: `BoxLite <no-reply@${senderDomain}>`,
    },
  }
}
