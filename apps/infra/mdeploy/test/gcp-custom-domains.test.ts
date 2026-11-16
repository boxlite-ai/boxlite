import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { gcpStackProviders } from '../stack/providers/gcp/index.ts'
import { recordServices } from './service-recording.ts'

process.env.MSTAGE_CONFIG ??= fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url))

const customDomainApi = (stage: string, apiEnvironment: Record<string, string> = {}) =>
  recordServices('boxlite-app', stage, () => {
    const output = (globalThis as any).$util.output
    const placement: any = {
      cloud: 'gcp',
      serviceAccount: output('api@example.com'),
      subnetwork: 'sub',
      egressSubnetwork: 'egress',
    }
    const providers = gcpStackProviders({
      stage,
      project: 'boxlite-dev-project',
      region: 'us-east5',
      zone: 'us-east5-a',
      appShort: 'bl-app',
      domain: 'stage.boxlite.ai',
      zoneId: 'zone',
      artifactsBucket: 'artifacts',
      volumePrefix: 'boxlite-volume',
    })
    providers.api({
      network: {
        binding: { cloud: 'gcp', network: output('network') },
        placementFor: () => placement,
      } as any,
      dependencies: {
        placement,
        waitFor: [],
        clickhouse: { active: false },
        database: {
          binding: {
            cloud: 'gcp',
            connectionName: output('p:us-east5:db'),
            passwordRef: output('projects/p/secrets/db'),
          },
        },
        cache: {
          binding: {
            cloud: 'gcp',
            passwordRef: output('projects/p/secrets/cache'),
            caRef: output('projects/p/secrets/ca'),
          },
        },
        storage: {
          name: output('bucket'),
          binding: {
            cloud: 'gcp',
            volumeCondition: { title: 'volumes', expression: 'true' },
            credentialVending: { serviceAccount: output('storage@example.com') },
          },
        },
      } as any,
    })({ image: 'api:sha', port: 3000, environment: apiEnvironment, secrets: {}, capabilities: [] } as any)
  })

test('GCP supplies its certificate resources and IAM without stored custom-domain settings', () => {
  const resources = customDomainApi('stage', { PROXY_DOMAIN: 'proxy.stage.example.test' })
  const service = resources.find((resource) => resource.logical === 'Api')!
  const container = service.args.template.containers[0]
  const envs = container.envs.toJSON()
  assert.deepEqual(
    envs.find((entry: { name: string }) => entry.name === 'CUSTOM_DOMAIN_GCP_PROJECT'),
    {
      name: 'CUSTOM_DOMAIN_GCP_PROJECT',
      value: 'boxlite-dev-project',
    },
  )
  assert.deepEqual(
    envs.find((entry: { name: string }) => entry.name === 'CUSTOM_DOMAIN_GCP_CERTIFICATE_MAP'),
    {
      name: 'CUSTOM_DOMAIN_GCP_CERTIFICATE_MAP',
      value: 'boxlite-app-stage-proxy',
    },
  )
  assert.equal(service.args.scaling, undefined)
  assert.equal(service.args.template.scaling, undefined)
  assert.equal(container.resources.cpuIdle, false)
  assert.deepEqual(container.ports, { name: 'http1', containerPort: 3000 })
  const role = resources.find((resource) => resource.logical === 'CustomDomainRuntimeRole')!
  const grant = resources.find((resource) => resource.logical === 'CustomDomainRuntimeGrant')!
  assert.equal(role.args.project, 'boxlite-dev-project')
  assert.equal(role.args.roleId, 'boxlite_app_stage_custom_domains')
  assert.ok(role.args.permissions.includes('certificatemanager.certs.create'))
  assert.equal(role.args.permissions.includes('resourcemanager.projects.get'), false)
  assert.equal(role.args.permissions.includes('certificatemanager.operations.get'), false)
  assert.equal(role.args.permissions.includes('certificatemanager.certmaps.update'), false)
  assert.equal(grant.args.project, 'boxlite-dev-project')
  assert.equal(String(grant.args.member), 'serviceAccount:api@example.com')
  assert.equal(String(grant.args.role), 'CustomDomainRuntimeRole')
  assert.deepEqual(
    String(grant.args.condition.expression).split(' || '),
    ['boxlite-dev-project', '123456789012'].flatMap((project) =>
      [
        'certificates/byo-',
        'dnsAuthorizations/byo-',
        'certificateMaps/boxlite-app-stage-proxy/certificateMapEntries/byo-',
      ].map((path) => `resource.name.startsWith("projects/${project}/locations/global/${path}")`),
    ),
  )
  const queryRole = resources.find((resource) => resource.logical === 'CustomDomainQueryRole')!
  const queryGrant = resources.find((resource) => resource.logical === 'CustomDomainQueryGrant')!
  assert.deepEqual(queryRole.args.permissions, ['resourcemanager.projects.get', 'certificatemanager.operations.get'])
  assert.equal(queryGrant.args.project, 'boxlite-dev-project')
  assert.equal(String(queryGrant.args.member), 'serviceAccount:api@example.com')
  assert.equal(String(queryGrant.args.role), 'CustomDomainQueryRole')
  assert.equal(queryGrant.args.condition, undefined)
})
