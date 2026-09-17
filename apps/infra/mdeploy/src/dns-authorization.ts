/*
 * The one precondition a GCP apply cannot recover from once it has started.
 *
 * Certificate Manager admits one DNS authorization per (project, domain, type),
 * and a certificate's `managed` block is immutable — so an authorization that
 * has to be replaced takes its certificate with it, and the delete that would
 * free either is refused by whatever still references it: the certificate by
 * the proxy above it, the authorization by the certificate issued against it.
 * Nothing in an apply breaks that cycle. The recovery is deleting the chain by
 * hand, with the stage's traffic dark in between, so the only thing worth doing
 * is finding out before the apply has changed anything.
 *
 * Two chains, and they fail the same way from opposite directions:
 *
 *   The API's authorization carries its host in its name
 *   (`certificate-name.ts`), so a project holding that host under another name
 *   is one whose replacement cannot be created.
 *
 *   The proxy's carries the stage's name and nothing else. Keying it on the
 *   domain as well would be the better shape and is not worth what it costs
 *   here: every stage that has one holds it under the fixed name, so the rename
 *   would make each of their next applies exactly the replacement that cannot
 *   be created. It stays, and a domain that no longer matches is refused here
 *   instead — which is the same protection without the migration.
 *
 * Asked of `gcloud` rather than of the engine, because the engine's view of the
 * resource is its own state file, and that is exactly what disagrees with the
 * project in the case this exists for. Read-only, and a read that cannot be
 * made is reported rather than treated as an answer: a project this cannot
 * reach is not a project known to be clean, but refusing every apply over a
 * missing CLI would make `gcloud` a dependency of deploying at all.
 */

import { instanceFor } from 'naming'
import { internalAuthorizationNameFor } from '../stack/providers/gcp/certificate-name.ts'
import type { RunCommand } from './upgrade-runners.ts'

export class DnsAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DnsAuthorizationError'
  }
}

/** One authorization a project holds: what it is called, and what it proves. */
export type Authorization = { name: string; domain: string }

export type AuthorizationsHeld = { ok: true; held: Authorization[] } | { ok: false; reason: string }

export type LookupAuthorizations = (input: { project: string }) => AuthorizationsHeld

/**
 * Every authorization the project holds, in every location.
 *
 * `--location=-` rather than the stage's region: the two chains do not share
 * one. The API's is regional and the proxy's is global, and a lookup pinned to
 * either would answer "nothing holds it" for the other — which this check reads
 * as converging.
 *
 * `value(name,domain)` is tab-separated, and `name` is a resource path on some
 * gcloud releases and an id alone on others, so the last segment is taken
 * either way.
 */
export const authorizationsThroughGcloud =
  (run: RunCommand): LookupAuthorizations =>
  ({ project }) => {
    let listed
    try {
      listed = run('gcloud', [
        'certificate-manager',
        'dns-authorizations',
        'list',
        `--project=${project}`,
        '--location=-',
        '--format=value(name,domain)',
      ])
    } catch (error) {
      // The runner throws when the CLI is not on PATH, which is precisely the
      // case the caller treats as "unread" rather than as "clean".
      return { ok: false, reason: (error as Error).message }
    }
    if (!listed.ok) return { ok: false, reason: listed.stderr.trim() || `gcloud exited ${listed.status}` }
    return {
      ok: true,
      held: listed.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name = '', domain = ''] = line.split(/\s+/)
          return { name: name.slice(name.lastIndexOf('/') + 1), domain }
        }),
    }
  }

const RECOVERY =
  'Delete that chain by hand first — forwarding rule, target proxy, certificate, authorization — and run this ' +
  'again; what it serves is unreachable in between.'

/**
 * Refuse an apply this project cannot converge, before it changes anything.
 *
 * Silent in every case that converges, which is most of them: the tuple is
 * free, or what holds it is what this apply would create.
 */
export const assertAuthorizationsConverge = ({
  app,
  stage,
  project,
  apiHost,
  proxyDomain,
  lookup,
  log,
}: {
  app: string
  stage: string
  project: string
  apiHost: string
  proxyDomain: string | null
  lookup: LookupAuthorizations
  log: (line: string) => void
}): void => {
  const answer = lookup({ project })
  if (!answer.ok) {
    log(`# could not read the DNS authorizations in ${project}: ${answer.reason}`)
    return
  }

  const expected = internalAuthorizationNameFor({ app, stage, host: apiHost })
  const onApiHost = answer.held.filter((authorization) => authorization.domain === apiHost)
  if (onApiHost.length > 0 && !onApiHost.some((authorization) => authorization.name === expected)) {
    throw new DnsAuthorizationError(
      `${project} proves ${apiHost} through ${onApiHost.map((held) => held.name).join(', ')}, and this apply ` +
        `creates ${expected}. Certificate Manager admits one authorization per (project, domain, type), so the ` +
        'create is refused as a duplicate and the delete that would free the original is refused in turn by the ' +
        `certificate issued against it and by the regional proxy above that. ${RECOVERY}`,
    )
  }

  // The name is the stage's, so the question is the other way round: not who
  // holds this domain, but what the resource under this name already proves.
  const proxyAuthorization = instanceFor({ app, stage, artifact: 'proxy' })
  const proxy = answer.held.find((authorization) => authorization.name === proxyAuthorization)
  if (proxyDomain && proxy && proxy.domain !== proxyDomain) {
    throw new DnsAuthorizationError(
      `${project} holds ${proxyAuthorization}, which proves ${proxy.domain}, and this apply needs it to prove ` +
        `${proxyDomain}. An authorization's domain is immutable and its name is this stage's own, so the ` +
        'replacement cannot be created while the original holds the name, and the original cannot be deleted ' +
        `while its certificate — and the proxy above that — still reference it. ${RECOVERY}`,
    )
  }
}
