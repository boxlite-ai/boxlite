/*
 * The refusal that stands between an apply and a chain it cannot converge.
 *
 * Every case here is about one tuple: Certificate Manager admits one DNS
 * authorization per (project, domain, type), so what the project already holds
 * decides whether this apply can finish. The two chains are asked opposite
 * questions — the API's name carries its host, the proxy's carries the stage —
 * and a refusal that looked for the wrong thing would be worth nothing, which
 * is what the last two tests are for.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { instanceFor } from 'naming'
import {
  assertAuthorizationsConverge,
  authorizationsThroughGcloud,
  DnsAuthorizationError,
  type AuthorizationsHeld,
} from '../src/dns-authorization.ts'
import { spawnWith } from '../src/upgrade-runners.ts'
import { certificateNameFor, internalAuthorizationNameFor } from '../stack/providers/gcp/certificate-name.ts'

const STAGE = { app: 'boxlite-app', stage: 'dev', project: 'boxlite-dev-project' }
const API_HOST = 'api.dev.boxlite.ai'
const PROXY_DOMAIN = 'proxy.dev.boxlite.ai'
const API_NAME = internalAuthorizationNameFor({ app: STAGE.app, stage: STAGE.stage, host: API_HOST })
const PROXY_NAME = instanceFor({ app: STAGE.app, stage: STAGE.stage, artifact: 'proxy' })

const sourceOf = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../stack/providers/gcp/${file}.ts`, import.meta.url)), 'utf8')

const check = (held: AuthorizationsHeld) => {
  const logged: string[] = []
  const refuse = () =>
    assertAuthorizationsConverge({
      ...STAGE,
      apiHost: API_HOST,
      proxyDomain: PROXY_DOMAIN,
      lookup: () => held,
      log: (line) => logged.push(line),
    })
  return { refuse, logged }
}

const holding = (...held: { name: string; domain: string }[]): AuthorizationsHeld => ({ ok: true, held })

test('a project holding what this apply creates is left alone', () => {
  const { refuse, logged } = check(
    holding({ name: API_NAME, domain: API_HOST }, { name: PROXY_NAME, domain: PROXY_DOMAIN }),
  )
  refuse()
  assert.deepEqual(logged, [], 'a stage that converges has nothing to say')
})

test('a project holding neither is left alone, because both tuples are free', () => {
  const { refuse } = check(holding())
  refuse()
})

test('an API host proved under an earlier name is refused before anything is applied', () => {
  // The pre-rename shape: one fixed name, no key. Both cannot exist at once,
  // and the delete that would free this one is refused from two directions.
  const { refuse } = check(holding({ name: 'boxlite-app-dev-api-internal', domain: API_HOST }))
  assert.throws(refuse, (error: Error) => {
    assert.ok(error instanceof DnsAuthorizationError)
    assert.match(error.message, /boxlite-app-dev-api-internal\b/, 'the refusal must name what is held')
    assert.match(error.message, new RegExp(API_NAME), 'and what this apply would create')
    assert.match(error.message, /forwarding rule, target proxy, certificate, authorization/, 'and the order out')
    return true
  })
})

test('the proxy authorization is asked what it proves, not what it is called', () => {
  // Its name is the stage's and never moves, so a stage whose PROXY_DOMAIN
  // changed holds a resource under exactly the name the replacement needs.
  const { refuse } = check(holding({ name: PROXY_NAME, domain: 'proxy.old.boxlite.ai' }))
  assert.throws(refuse, (error: Error) => {
    assert.ok(error instanceof DnsAuthorizationError)
    assert.match(error.message, /proves proxy\.old\.boxlite\.ai/)
    assert.match(error.message, new RegExp(`needs it to prove ${PROXY_DOMAIN.replace(/\./g, '\\.')}`))
    return true
  })
})

test('a stage with no proxy domain is not asked about a proxy authorization', () => {
  // `--local-env` and a stage that serves no proxy both reach here without one,
  // and an absent setting is not a mismatch.
  const logged: string[] = []
  assertAuthorizationsConverge({
    ...STAGE,
    apiHost: API_HOST,
    proxyDomain: null,
    lookup: () => holding({ name: PROXY_NAME, domain: 'proxy.old.boxlite.ai' }),
    log: (line) => logged.push(line),
  })
  assert.deepEqual(logged, [])
})

test('a CLI that is not there is reported, not treated as an answer', () => {
  // The real path, through the runner every other caller uses: `spawnWith`
  // throws on ENOENT rather than returning a result, and a lookup that let that
  // escape would fail the apply over a missing CLI — the opposite of what the
  // comment above it promises. Run with a PATH that holds no gcloud.
  const lookup = authorizationsThroughGcloud(spawnWith({ PATH: join(process.cwd(), 'no-such-directory') }))
  const answer = lookup({ project: STAGE.project })
  assert.equal(answer.ok, false)
  assert.match((answer as { reason: string }).reason, /gcloud/)

  const logged: string[] = []
  assertAuthorizationsConverge({
    ...STAGE,
    apiHost: API_HOST,
    proxyDomain: PROXY_DOMAIN,
    lookup,
    log: (line) => logged.push(line),
  })
  assert.equal(logged.length, 1, 'an unread project is said out loud and not refused')
  assert.match(logged[0], /could not read the DNS authorizations/)
})

test('the names looked for are the names the providers create', () => {
  // Composed twice, this check passes against resources nothing creates. The
  // API provider takes its name from the same function; the proxy's is the
  // module's own base, which is asserted against its source.
  assert.equal(
    API_NAME,
    certificateNameFor({ key: API_HOST, base: instanceFor({ ...STAGE, artifact: 'api-internal-auth' }) }),
  )
  assert.match(sourceOf('api'), /const internalAuthorizationName = internalAuthorizationNameFor\(/)
  assert.doesNotMatch(sourceOf('api'), /artifact: 'api-internal-auth'/, 'that name must live in one place only')

  const edge = sourceOf('edge')
  assert.match(edge, /const name = instanceFor\(\{ app: \$app\.name, stage: \$app\.stage, artifact: 'proxy' \}\)/)
  assert.match(edge, /new gcp\.certificatemanager\.DnsAuthorization\('ProxyDnsAuthorization', \{\n\s+name,/)
})

test('the lookup asks every location, and reads a path or an id', () => {
  // The API's authorization is regional and the proxy's is global. A lookup
  // pinned to either answers "nothing holds it" for the other, which this check
  // reads as converging.
  const asked: string[][] = []
  const lookup = authorizationsThroughGcloud((file, args) => {
    asked.push([file, ...args])
    return {
      ok: true,
      status: 0,
      stdout: `projects/p/locations/us-east5/dnsAuthorizations/${API_NAME}\t${API_HOST}\n${PROXY_NAME}\t${PROXY_DOMAIN}\n`,
      stderr: '',
    }
  })
  assert.deepEqual(lookup({ project: STAGE.project }), {
    ok: true,
    held: [
      { name: API_NAME, domain: API_HOST },
      { name: PROXY_NAME, domain: PROXY_DOMAIN },
    ],
  })
  assert.deepEqual(asked, [
    [
      'gcloud',
      'certificate-manager',
      'dns-authorizations',
      'list',
      `--project=${STAGE.project}`,
      '--location=-',
      '--format=value(name,domain)',
    ],
  ])
})
