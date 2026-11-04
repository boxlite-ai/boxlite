import assert from 'node:assert/strict'
import test from 'node:test'
import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import * as cloudflare from '@pulumi/cloudflare'
import { gcpApiProvider } from '../stack/providers/gcp/api.ts'

test('the deployed App worker has permanent CPU, shared credentials and source-only object grants', async () => {
  const created = new Map<string, Record<string, any>>()
  pulumi.runtime.setMocks({
    newResource(args) {
      created.set(args.name, args.inputs)
      return {
        id: args.name,
        state: {
          ...args.inputs,
          selfLink: args.name,
          address: '10.0.0.8',
          dnsResourceRecords: [{ name: '_verify.test.', type: 'CNAME', data: 'verify.test.' }],
        },
      }
    },
    call(args) {
      return args.inputs
    },
  })
  Object.assign(globalThis, {
    $app: { name: 'boxlite-app', stage: 'dev' },
    $util: pulumi,
    $resolve: pulumi.all,
    $interpolate: pulumi.interpolate,
    gcp,
    cloudflare,
  })
  const out = (value: string): any => pulumi.output(value)
  const storage = {
    name: out('source-bucket'),
    binding: {
      cloud: 'gcp',
      listGrant: 'roles/storage.legacyBucketReader',
      volumeCondition: { title: 'volumes', expression: 'false' },
      credentialVending: { serviceAccount: out('volume@test') },
    },
    ready: [],
  } as any
  const api = gcpApiProvider({
    project: 'cloud-test',
    region: 'us-east5',
    domain: 'dev.example.com',
    dashboardDomain: null,
    zoneId: 'zone',
    callers: [],
    network: out('network'),
    runnerAccount: out('runner@test'),
    dependencies: {
      host: {} as any,
      placement: { cloud: 'gcp', serviceAccount: out('api@test'), egressSubnetwork: out('subnet') } as any,
      storage,
      database: {
        binding: {
          cloud: 'gcp',
          passwordRef: out('projects/cloud-test/secrets/database/versions/1'),
          connectionName: out('cloud-test:us-east5:db'),
        },
      } as any,
      cache: {
        binding: {
          cloud: 'gcp',
          passwordRef: out('projects/cloud-test/secrets/redis/versions/1'),
          caRef: out('projects/cloud-test/secrets/redis-ca/versions/1'),
        },
      } as any,
      clickhouse: { active: false, mode: 'disabled' },
      waitFor: [],
    },
  })({
    image: 'registry/api:commit',
    port: 3000,
    domain: 'dev.example.com',
    environment: { CLOUD_APP_PROCESS_ROLE: 'api', CLOUD_APP_SOURCE_BUCKET: 'source-bucket', RUN_MIGRATIONS: 'true' },
    secrets: { NEON_API_KEY: out('projects/cloud-test/secrets/neon/versions/1') },
    capabilities: [{ kind: 'manage-app-source', storage }],
  })
  await new Promise<void>((resolve) =>
    pulumi.all(api.ready.map((resource: any) => resource.urn)).apply(() => resolve()),
  )
  const worker = created.get('CloudAppWorker')!
  const service = created.get('Api')!
  assert.ok(worker)
  assert.equal(worker.ingress, 'INGRESS_TRAFFIC_INTERNAL_ONLY')
  assert.deepEqual(worker.template.scaling, { minInstanceCount: 1, maxInstanceCount: 1 })
  const container = worker.template.containers[0]
  assert.equal(container.image, 'registry/api:commit')
  assert.equal(container.resources.cpuIdle, false)
  assert.deepEqual(container.resources, { ...service.template.containers[0].resources, cpuIdle: false })
  assert.deepEqual(worker.template.volumes, service.template.volumes)
  assert.deepEqual(worker.template.vpcAccess, service.template.vpcAccess)
  const env = Object.fromEntries(container.envs.map((item: any) => [item.name, item]))
  assert.equal(env.CLOUD_APP_PROCESS_ROLE.value, 'worker')
  assert.equal(env.RUN_MIGRATIONS.value, 'false')
  assert.equal(env.NEON_API_KEY.value, undefined)
  assert.deepEqual(env.NEON_API_KEY.valueSource.secretKeyRef, { secret: 'neon', version: '1' })
  const grant = created.get('ApiCapability0')!
  assert.equal(grant.role, 'roles/storage.objectAdmin')
  assert.equal(grant.bucket, 'source-bucket')
  assert.match(grant.condition.expression, /\/objects\/cloud-apps\//)
})
