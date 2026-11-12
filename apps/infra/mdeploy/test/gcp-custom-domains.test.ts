import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseBase } from 'mstage/config'
import { valuesOfGroup } from 'mstage/select-group'
import { apiEnvironmentFrom } from '../src/api-environment.ts'
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

const apiEnvironmentFromStore = (settings: Record<string, string>) => {
  const path = new URL('../../mstage.env.json', import.meta.url)
  const config = parseBase(path.pathname, readFileSync(path, 'utf8'))
  const required = Object.fromEntries(
    config.envSelectGroup
      .api!.filter((key) => !config.envOptional.api!.includes(key))
      .map((key) => [key, 'synthetic-test-value']),
  )
  const values = valuesOfGroup({
    group: 'api',
    groups: config.envSelectGroup,
    optional: config.envOptional.api,
    values: { ...required, ...settings },
    where: path.pathname,
  })
  return apiEnvironmentFrom({
    environment: {
      STACK_DOMAIN: 'stage.example.test',
      OIDC_ISSUER_BASE_URL: 'https://auth.stage.example.test',
      ...values,
    },
    declaration: { groups: config.envSelectGroup, optional: config.envOptional, where: path.pathname },
    region: 'us-east5',
    stage: 'stage',
    home: 'gcp',
  })
}

test('stored custom-domain settings reach the GCP API', () => {
  const settings: Record<string, string> = {
    CUSTOM_DOMAIN_GCP_PROJECT: 'customer-project',
    CUSTOM_DOMAIN_GCP_CERTIFICATE_MAP: 'customer-map',
    CUSTOM_DOMAIN_TRAFFIC_HOST: 'proxy.stage.example.test',
  }
  const delivered = apiEnvironmentFromStore(settings)
  const resources = customDomainApi('stage', delivered.environment)
  const service = resources.find((resource) => resource.logical === 'Api')!
  const container = service.args.template.containers[0]
  const envs = container.envs.toJSON()
  for (const [name, value] of Object.entries(settings)) {
    assert.deepEqual(
      envs.find((entry: { name: string }) => entry.name === name),
      { name, value },
    )
    assert.equal(Object.hasOwn(delivered.secrets, name), false)
  }
  assert.equal(service.args.scaling, undefined)
  assert.equal(service.args.template.scaling, undefined)
  assert.equal(container.resources.cpuIdle, false)
  assert.deepEqual(container.ports, { name: 'http1', containerPort: 3000 })
  const role = resources.find((resource) => resource.logical === 'CustomDomainRuntimeRole')!
  const grant = resources.find((resource) => resource.logical === 'CustomDomainRuntimeGrant')!
  assert.equal(role.args.project, settings.CUSTOM_DOMAIN_GCP_PROJECT)
  assert.equal(role.args.roleId, 'boxlite_app_stage_custom_domains')
  assert.ok(role.args.permissions.includes('certificatemanager.certs.create'))
  assert.ok(role.args.permissions.includes('resourcemanager.projects.get'))
  assert.equal(role.args.permissions.includes('certificatemanager.certmaps.update'), false)
  assert.equal(grant.args.project, settings.CUSTOM_DOMAIN_GCP_PROJECT)
  assert.equal(String(grant.args.member), 'serviceAccount:api@example.com')
  assert.equal(String(grant.args.role), 'CustomDomainRuntimeRole')
})

test('an unconfigured stage needs no custom-domain IAM or always-on API', () => {
  const delivered = apiEnvironmentFromStore({})
  const resources = customDomainApi('stage', delivered.environment)
  const service = resources.find((resource) => resource.logical === 'Api')!
  const container = service.args.template.containers[0]
  assert.equal(
    container.envs.toJSON().some((entry: { name: string }) => entry.name.startsWith('CUSTOM_DOMAIN_')),
    false,
  )
  assert.equal(service.args.template.scaling, undefined)
  assert.equal(container.resources, undefined)
  assert.equal(
    resources.some((resource) => resource.logical.startsWith('CustomDomainRuntime')),
    false,
  )
})
