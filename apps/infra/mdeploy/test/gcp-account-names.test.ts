import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { NameError, SERVICE_ACCOUNT_LIMIT } from 'naming'
import type { WorkloadRole } from '../stack/network.ts'
import { gcpNetworkProvider } from '../stack/providers/gcp/network.ts'
import { recordServices } from './service-recording.ts'

const declared = JSON.parse(readFileSync(new URL('../../mstage.env.json', import.meta.url), 'utf8')) as {
  app: string
  appShort: string
}
const roles: Record<WorkloadRole, string> = {
  api: 'ApiServiceAccount',
  proxy: 'ProxyServiceAccount',
  'otel-collector': 'OtelServiceAccount',
  runner: 'RunnerServiceAccount',
  'registry-proxy': 'RegistryProxyServiceAccount',
}

const networkFor = (stage: string, appShort = declared.appShort) => {
  const placements: Record<string, string> = {}
  const resources = recordServices(declared.app, stage, () => {
    const network = gcpNetworkProvider({ project: 'boxlite-dev-project', region: 'us-east5', appShort })({
      internetEgress: true,
    })
    for (const role of Object.keys(roles) as WorkloadRole[]) {
      const placement = network.placementFor(role)
      assert.equal(placement.cloud, 'gcp')
      if (placement.cloud === 'gcp') placements[role] = String(placement.serviceAccount)
    }
  })
  return { resources, placements }
}

for (const stage of ['dev', 'prod', 'stage']) {
  test(`${stage} workload identities fit without changing role references`, () => {
    let built!: ReturnType<typeof networkFor>
    assert.doesNotThrow(() => {
      built = networkFor(stage)
    }, `${stage} network must construct valid account names`)
    const accounts = built.resources.filter((resource) => resource.kind === 'gcp.serviceaccount.Account')
    assert.deepEqual(accounts.map((account) => account.logical).sort(), Object.values(roles).sort())
    const ids = accounts.map((account) => account.args.accountId)
    assert.equal(new Set(ids).size, 5, 'each workload needs a distinct identity')
    for (const [role, logical] of Object.entries(roles)) {
      const account = accounts.find((resource) => resource.logical === logical)!
      const artifact =
        stage === 'stage'
          ? (({ 'otel-collector': 'otel', 'registry-proxy': 'registry' } as Record<string, string>)[role] ?? role)
          : role
      assert.equal(account.args.accountId, `${declared.appShort}-${stage}-${artifact}-run`)
      assert.ok(account.args.accountId.length <= SERVICE_ACCOUNT_LIMIT)
      assert.match(account.args.accountId, /^[a-z][-a-z0-9]{4,28}[a-z0-9]$/)
      assert.equal(account.args.displayName, `BoxLite ${role} (${stage})`)
      assert.equal(built.placements[role], `${logical}:email`)
    }
    const internal = built.resources.find((resource) => resource.logical === 'InternalFirewall')!
    assert.deepEqual(internal.args.sourceServiceAccounts.map(String), [
      'ApiServiceAccount:email',
      'ProxyServiceAccount:email',
      'OtelServiceAccount:email',
    ])
    assert.deepEqual(internal.args.targetServiceAccounts.map(String), internal.args.sourceServiceAccounts.map(String))
    if (process.env.ACCOUNT_RECEIPTS)
      writeFileSync(join(process.env.ACCOUNT_RECEIPTS, `${stage}.json`), JSON.stringify(built, null, 2))
  })
}

test('stage aliases retain the shared length guard', () => {
  assert.throws(() => networkFor('stage', 'application-abbreviation-too-long'), NameError)
})

test('other long environment names retain their existing refusal', () => {
  assert.throws(() => networkFor('preview'), /is 33 characters and the limit is 30/)
})
