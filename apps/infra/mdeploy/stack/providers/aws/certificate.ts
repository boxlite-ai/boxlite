import type { UserDomain } from '../../hosts.ts'

type CertificateDomain = { domain: string; zoneId: string }

/** ACM owns renewal; Cloudflare owns the validation records and public names. */
export const awsCertificate = (name: string, domains: CertificateDomain[], options: Record<string, unknown> = {}) => {
  if (!domains.length) throw new Error('An AWS certificate needs at least one domain')
  const certificate = new aws.acm.Certificate(
    name,
    {
      domainName: domains[0]!.domain,
      subjectAlternativeNames: domains.slice(1).map(({ domain }) => domain),
      validationMethod: 'DNS',
      tags: { 'boxlite:certificate-owner': 'platform', 'boxlite:stage': $app.stage },
    },
    options,
  )
  const validations = [...new Map(domains.map((domain) => [domain.domain.replace(/^\*\./, ''), domain])).values()]
  const records = validations.map(({ domain, zoneId }, index) => {
    const validation = certificate.domainValidationOptions.apply((entries: any[]) => {
      const value = entries.find((entry) => entry.domainName === domain)
      if (!value) throw new Error(`No ACM validation record for ${domain}`)
      return value
    })
    return new cloudflare.Record(`${name}Validation${index}`, {
      zoneId,
      type: 'CNAME',
      ttl: 60,
      proxied: false,
      name: validation.apply((entry: any) => entry.resourceRecordName.replace(/\.$/, '')),
      content: validation.apply((entry: any) => entry.resourceRecordValue.replace(/\.$/, '')),
    })
  })
  return new aws.acm.CertificateValidation(
    `${name}Ready`,
    {
      certificateArn: certificate.arn,
      validationRecordFqdns: records.map((record) => record.name),
    },
    { ...options, dependsOn: records },
  )
}

export const awsDnsName = (name: string, domain: $util.Input<string>, zoneId: string, target: $util.Input<string>) =>
  new cloudflare.Record(name, { zoneId, name: domain, type: 'CNAME', content: target, ttl: 60, proxied: false })

/** Platform names share the immutable default certificate; customer attachments remain separate. */
export const proxyCertificateDomains = (
  domain: string,
  zoneId: string,
  userDomain: UserDomain | null,
): CertificateDomain[] => [
  { domain, zoneId },
  { domain: `*.${domain}`, zoneId },
  ...(userDomain
    ? [
        { domain: userDomain.domain, zoneId: userDomain.dnsZoneId },
        { domain: `*.${userDomain.domain}`, zoneId: userDomain.dnsZoneId },
      ]
    : []),
]
