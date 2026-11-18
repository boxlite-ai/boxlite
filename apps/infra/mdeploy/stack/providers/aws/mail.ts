import type { MailProvider } from '../../mail.ts'
import { awsDnsName } from './certificate.ts'
import { instanceFor } from 'naming'

/** SES owns the sender identity; SMTP credentials arrive through workload secret references. */
export const awsMailProvider =
  ({ region, zoneId }: { region: string; zoneId: string }): MailProvider =>
  (request) => {
    if (!request.senderDomain) return { sending: false }
    const configuration = new aws.sesv2.ConfigurationSet('MailConfig', {
      configurationSetName: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'mail' }),
    })
    const identity = new aws.sesv2.EmailIdentity('MailIdentity', {
      emailIdentity: request.senderDomain,
      configurationSetName: configuration.configurationSetName,
    })
    const records = [0, 1, 2].map((index) => {
      const token = identity.dkimSigningAttributes.tokens.apply((tokens: string[]) => tokens[index]!)
      return awsDnsName(
        `MailDkim${index}`,
        $interpolate`${token}._domainkey.${request.senderDomain}`,
        zoneId,
        $interpolate`${token}.dkim.amazonses.com`,
      )
    })
    const dmarc = new cloudflare.Record('MailDmarc', {
      zoneId,
      name: `_dmarc.${request.senderDomain}`,
      type: 'TXT',
      content: 'v=DMARC1; p=none;',
      ttl: 60,
    })
    const verified = new aws.ses.DomainIdentityVerification(
      'MailVerified',
      {
        domain: identity.emailIdentity,
      },
      { dependsOn: records },
    )
    return {
      sending: true,
      verified: true,
      host: `email-smtp.${region}.amazonaws.com`,
      port: '465',
      senderAddress: `no-reply@${request.senderDomain}`,
      ready: [verified, dmarc],
    }
  }
