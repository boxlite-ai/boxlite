import assert from 'node:assert/strict'
import test from 'node:test'
import { apiEnvironmentFrom } from '../src/api-environment.ts'
import { gcpApiProvider } from '../stack/providers/gcp/api.ts'

class Value {
  constructor(readonly __output: any) {}
  apply(fn: (value: any) => any): Value {
    return value(fn(this.__output))
  }
}
const value = (input: any): Value => (input instanceof Value ? input : new Value(input))
const unwrap = (input: any): any =>
  input instanceof Value
    ? unwrap(input.__output)
    : Array.isArray(input)
      ? input.map(unwrap)
      : input && typeof input === 'object'
        ? Object.fromEntries(Object.entries(input).map(([key, item]) => [key, unwrap(item)]))
        : input

function capture(configured: boolean) {
  const records: { type: string; name: string; args: any }[] = []
  const namespace = (path: string): any =>
    new Proxy(function () {}, {
      get: (_target, key) => namespace(path + '.' + String(key)),
      construct: (_target, [name, args]) => {
        records.push({ type: path, name, args })
        return new Proxy(
          {},
          {
            get: (_object, key) =>
              key === 'dnsResourceRecords'
                ? [{ name: '_authorization.example.test', type: 'CNAME', data: 'example.test' }]
                : value(
                    key === 'name'
                      ? (args.name ?? name)
                      : key === 'address'
                        ? '192.0.2.1'
                        : `resource-${name}-${String(key)}`,
                  ),
          },
        )
      },
    })
  Object.assign(globalThis, {
    $app: { name: 'boxlite', stage: 'ci-test' },
    $util: { output: value, secret: value },
    $resolve: (items: any[]) => value(items.map(unwrap)),
    gcp: namespace('gcp'),
    cloudflare: namespace('cloudflare'),
  })
  const secrets = ['CI_GITHUB_APP_PRIVATE_KEY', 'CI_GITHUB_WEBHOOK_SECRET', 'CI_SECRET_ENCRYPTION_KEY']
  const ci = configured
    ? {
        CI_GITHUB_APP_CLIENT_ID: 'test-client',
        CI_GITHUB_APP_SLUG: 'test-app',
        ...Object.fromEntries(
          secrets.map((key, i) => [
            key,
            JSON.stringify({ address: `projects/test-project/secrets/ci-${i}/versions/7` }),
          ]),
        ),
      }
    : {}
  const channels = apiEnvironmentFrom({
    environment: {
      STACK_DOMAIN: 'example.test',
      OIDC_ISSUER_BASE_URL: 'https://auth.example.test',
      ...ci,
    },
    declaration: {
      groups: { deploy: [], api: Object.keys(ci), secret: configured ? secrets : [] },
      where: '/test/mstage.config.json',
    },
    region: 'us-east5',
    stage: 'ci-test',
    home: 'gcp',
  })
  gcpApiProvider({
    zone: 'us-east1-c',
    dependencies: {
      placement: {
        cloud: 'gcp',
        serviceAccount: value('api@test-project.iam.gserviceaccount.com'),
        subnetwork: value('subnet'),
        egressSubnetwork: value('subnet'),
      },
      storage: {
        name: value('bucket'),
        binding: {
          cloud: 'gcp',
          credentialVending: {
            serviceAccount: value('vending@test-project.iam.gserviceaccount.com'),
          },
          volumeCondition: { expression: 'true' },
        },
      },
      database: {
        binding: {
          cloud: 'gcp',
          passwordRef: value('projects/test-project/secrets/db/versions/1'),
          connectionName: value('test-project:us-east5:db'),
        },
      },
      cache: {
        binding: {
          cloud: 'gcp',
          passwordRef: value('projects/test-project/secrets/cache/versions/1'),
          caRef: value('projects/test-project/secrets/cache-ca/versions/1'),
        },
      },
      clickhouse: { active: false },
      waitFor: [],
    } as any,
    project: 'test-project',
    region: 'us-east5',
    domain: 'example.test',
    dashboardDomain: null,
    callers: [],
    zoneId: 'zone',
    network: value('network') as any,
    runnerAccount: value('runner@example.test') as any,
  })({ ...channels, image: 'registry.example.test/api:fixture', port: 3000, capabilities: [] } as any)
  const service = records.find((r) => r.type === 'gcp.cloudrunv2.Service' && r.name === 'Api')
  assert.ok(service)
  return { service: unwrap(service.args), records }
}

test('the Cloud Run API retains background CPU and adds a service-level minimum only with CI', () => {
  const on = capture(true).service
  assert.deepEqual(on.scaling, { minInstanceCount: 1 })
  assert.equal(on.template.containers[0].resources.cpuIdle, false)
  assert.equal(on.ingress, 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER')
  const off = capture(false).service
  assert.equal(off.scaling, undefined)
  assert.equal(off.template.containers[0].resources.cpuIdle, false)
})

test('CI refs reach actual Cloud Run envs and per-secret grants, without plaintext payloads', () => {
  const { service, records } = capture(true)
  for (const [i, name] of [
    'CI_GITHUB_APP_PRIVATE_KEY',
    'CI_GITHUB_WEBHOOK_SECRET',
    'CI_SECRET_ENCRYPTION_KEY',
  ].entries()) {
    const variable = service.template.containers[0].envs.find((e: any) => e.name === name)
    assert.deepEqual(variable, { name, valueSource: { secretKeyRef: { secret: `ci-${i}`, version: '7' } } })
    const grant = records.find((r) => r.name === 'ApiSecretAccess-' + name)
    assert.ok(grant)
    assert.equal(unwrap(grant.args.secretId), `ci-${i}`)
    assert.equal(grant.args.role, 'roles/secretmanager.secretAccessor')
  }
})
