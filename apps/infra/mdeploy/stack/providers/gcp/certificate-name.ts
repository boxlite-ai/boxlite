/*
 * What a domain-keyed resource is called, on each of the paths that hold one.
 *
 * Five resources, on four call sites: the two load-balancer certificates the
 * control plane and the dashboard each get, the proxy's own wildcard
 * certificate, the regional path's Certificate Manager certificate, and the DNS
 * authorization that last one depends on. The authorization is here because it
 * is on the same chain — a fixed name there forces a delete-first that
 * propagates down to the certificate, whose delete the proxy refuses.
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
 * One name per certificate, so one name is what this is keyed on. Where a
 * certificate covers more than one domain they are derived from this one — the
 * proxy's wildcard is `*.<domain>` — so the key still changes whenever the
 * covered set does. Two names a caller could move independently do not belong
 * on one certificate at all: see the note above `certificateFor` in `api.ts`.
 *
 * The key is not always a domain, which is why it is not called one. The
 * regional certificate is keyed on the *authorization* it is issued against:
 * that authorization is immutable inside `managed`, so replacing it replaces
 * the certificate, and a name that moved only with the domain would leave the
 * replacement refused under a name the original still holds.
 *
 * Eight hex characters, because the whole name still has to fit the length
 * budget `naming` already keeps, and this only has to separate one stage's
 * successive domains from each other.
 *
 * When a fixed name may become a keyed one, and when it may not. Adopting the
 * key is itself a replacement under a name the original still holds, which is
 * the very state it exists to prevent — so it is free only while no stage holds
 * the old name, and a wedge for every stage that does. The control plane's
 * authorization was moved on those terms; the proxy's is not, because every
 * stage has one under `<app>-<stage>-proxy` (see `edge.ts`). Neither is left
 * unguarded either way: `src/dns-authorization.ts` asks the project what it
 * holds before an apply and refuses the case it cannot converge, which is also
 * what makes the proxy's move safe to take later, one stage at a time, once
 * that stage's chain has been rebuilt.
 */

import { createHash } from 'node:crypto'
import { instanceFor } from 'naming'

export const certificateNameFor = ({ key, base }: { key: string; base: string }): string =>
  `${base}-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`

/**
 * The internal DNS authorization's name, which its certificate is keyed on too.
 *
 * Here rather than at the one resource that creates it, because a second reader
 * needs the same answer without the engine: `src/dns-authorization.ts` asks the
 * project what it already holds for the host, and a name composed twice is a
 * check that passes against a resource nothing creates.
 */
export const internalAuthorizationNameFor = ({
  app,
  stage,
  host,
}: {
  app: string
  stage: string
  host: string
}): string => certificateNameFor({ key: host, base: instanceFor({ app, stage, artifact: 'api-internal-auth' }) })
