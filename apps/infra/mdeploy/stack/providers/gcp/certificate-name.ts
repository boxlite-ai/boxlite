/*
 * What a managed certificate is called, on either of the two paths that hold one.
 *
 * A certificate's domains are immutable on both Certificate Manager and the
 * load balancer's own `ManagedSslCertificate`, so changing a stage's domain
 * replaces the certificate rather than updating it. Both providers delete
 * before they create, and at that moment the thing pointing at the certificate
 * — a `CertificateMapEntry` on one path, a `TargetHttpsProxy` on the other —
 * still references it, so GCP refuses the delete with `RESOURCE_STILL_IN_USE`
 * and the stage is wedged: a certificate that cannot be removed and a
 * replacement that cannot be created under the same name.
 *
 * Keying the name to the domains is half the fix — it lets both certificates
 * exist at once — and `deleteBeforeReplace: false` at each call site is the
 * other half, which puts the delete after the reference has moved.
 *
 * Eight hex characters, because the whole name still has to fit the length
 * budget `naming` already keeps, and this only has to separate one stage's
 * successive domains from each other.
 */

import { createHash } from 'node:crypto'

export const certificateNameFor = ({ domain, base }: { domain: string; base: string }): string =>
  `${base}-${createHash('sha256').update(domain).digest('hex').slice(0, 8)}`
