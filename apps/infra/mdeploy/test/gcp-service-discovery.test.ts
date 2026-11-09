import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { gcpApiProvider } from '../stack/providers/gcp/api.ts'
import { gcpCollectorProvider } from '../stack/providers/gcp/collector.ts'
import { gcpRegistryProxyProvider } from '../stack/providers/gcp/registry-proxy.ts'
import { recordServices } from './service-recording.ts'

export const platformServices = (stage: string) =>
  recordServices('boxlite-app', stage, () => {
    const output = (globalThis as any).$util.output
    const placement: any = {
      cloud: 'gcp',
      serviceAccount: output('api@example.com'),
      subnetwork: 'sub',
      egressSubnetwork: 'egress',
    }
    gcpApiProvider({
      project: 'boxlite-dev-project',
      region: 'us-east5',
      domain: 'stage.boxlite.ai',
      dashboardDomain: null,
      callers: [],
      zoneId: 'zone',
      network: output('network'),
      runnerAccount: output('runner@example.com'),
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
    })({ image: 'api:sha', port: 3000, environment: {}, secrets: {}, capabilities: [] } as any)
    gcpCollectorProvider({
      project: 'boxlite-dev-project',
      region: 'us-east5',
      placement,
      clickhouse: { active: false },
      dependsOn: [],
    } as any)({ image: 'collector:sha', exporters: '[boxlite_exporter]', environment: {}, secrets: {} })
    gcpRegistryProxyProvider({
      project: 'boxlite-dev-project',
      region: 'us-east5',
      placement,
      registryCredentials: { active: false },
      dependsOn: [],
    })({ image: 'registry:sha', environment: {} })
  })

for (const stage of ['dev', 'prod', 'preview', 'stage']) {
  test(`platform Cloud Run discovery labels for ${stage}`, () => {
    const built = platformServices(stage)
    const services = built.filter((resource) => resource.kind === 'gcp.cloudrunv2.Service')
    assert.deepEqual(services.map((service) => service.logical).sort(), ['Api', 'OtelCollector', 'RegistryProxy'])
    if (process.env.DISCOVERY_RECEIPTS)
      writeFileSync(join(process.env.DISCOVERY_RECEIPTS, `platform-${stage}.json`), JSON.stringify(built, null, 2))
    for (const service of services) {
      if (stage === 'stage')
        assert.deepEqual(
          service.args.labels,
          { stage: 'stage' },
          `${service.logical} is missing its stage discovery label`,
        )
      else assert.equal(Object.hasOwn(service.args, 'labels'), false, `${stage}/${service.logical} gained labels`)
      assert.equal(Object.hasOwn(service.args.template, 'labels'), false, 'inventory labels belong to the Service')
    }
  })
}

for (const stage of ['dev', 'prod', 'stage']) {
  for (const [logical, port, protocol] of [
    ['Api', 3000, 'http1'],
    ['OtelCollector', 4318, 'http1'],
    ['RegistryProxy', 4100, 'h2c'],
  ] as const) {
    test(`${stage}/${logical} supplies one Cloud Run ports object`, () => {
      const resources = platformServices(stage)
      if (process.env.SHAPE_RECEIPTS)
        writeFileSync(join(process.env.SHAPE_RECEIPTS, `cloudrun-${stage}.json`), JSON.stringify(resources, null, 2))
      const service = resources.find(
        (resource) => resource.kind === 'gcp.cloudrunv2.Service' && resource.logical === logical,
      )
      assert.ok(service, `${logical} was not constructed`)
      assert.deepEqual(service.args.template.containers[0].ports, { name: protocol, containerPort: port })
    })
  }
}
