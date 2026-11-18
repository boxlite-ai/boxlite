import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import * as cloudflare from '@pulumi/cloudflare'
import * as kubernetes from '@pulumi/kubernetes'
import * as command from '@pulumi/command'
import * as random from '@pulumi/random'
import { installGlobals } from '../pulumi/program.ts'
import { gcpEdgeProvider } from '../stack/providers/gcp/edge.ts'
import { publishClickStack } from '../stack/providers/gcp/clickstack.ts'

test('GCP backend constructors use scalar health references', { timeout: 30000 }, async (t) => {
  const resources = new Map<string, { type: string; inputs: any }>()
  await pulumi.runtime.setMocks(
    {
      newResource: ({ type, name, inputs }) => {
        resources.set(name, { type, inputs })
        const state = { ...inputs }
        if (type === 'gcp:secretmanager/secretVersion:SecretVersion')
          state.name = 'projects/test/secrets/proxy-key/versions/1'
        if (type === 'gcp:certificatemanager/dnsAuthorization:DnsAuthorization')
          state.dnsResourceRecords = [{ name: '_acme.example.test', type: 'CNAME', data: 'validation.example.test' }]
        return { id: `${name}-id`, state }
      },
      call: ({ token, inputs }) => {
        if (token === 'gcp:compute/getNetworkEndpointGroup:getNetworkEndpointGroup')
          return {
            ...inputs,
            selfLink: 'projects/test/zones/us-east5-a/networkEndpointGroups/proxy',
            generatedId: '123',
          }
        throw new Error(`Unexpected provider lookup: ${token}`)
      },
    },
    'boxlite-app',
    'stage',
    false,
  )
  const globals = globalThis as Record<string, any>
  const keys = [
    '$app',
    '$util',
    '$interpolate',
    '$output',
    '$jsonStringify',
    '$resolve',
    'gcp',
    'random',
    'cloudflare',
    'command',
    'kubernetes',
  ]
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globals, key))
  installGlobals({
    modules: { pulumi, gcp, cloudflare, kubernetes, command, random },
    app: 'boxlite-app',
    stage: 'stage',
  })
  try {
    await pulumi.runtime.runInPulumiStack(async () => {
      const edge = gcpEdgeProvider({
        project: 'test',
        network: $util.output('network'),
        runnerServiceAccount: $util.output('runner@example.test'),
        zoneId: 'test-zone',
        dependsOn: [],
        host: {
          cloud: 'gcp',
          runtime: 'gke',
          region: 'us-east5',
          zones: $util.output(['us-east5-a']),
          nodeServiceAccount: $util.output('node@example.test'),
          ready: [],
          provider: new kubernetes.Provider('TestKubernetes', { kubeconfig: '{}' }),
        },
        placement: {
          cloud: 'gcp',
          exposure: 'private',
          subnetwork: $util.output('subnet'),
          egressSubnetwork: $util.output('egress'),
          serviceAccount: $util.output('proxy@example.test'),
        },
      })({
        image: 'proxy:test',
        domain: 'proxy.stage.example.test',
        userDomain: null,
        protocol: 'https',
        apiUrl: 'https://api.stage.example.test',
        environment: { PROXY_API_KEY: 'synthetic-test-value' },
        secrets: {},
      })
      publishClickStack({
        project: 'test',
        region: 'us-east5',
        zone: 'us-east5-a',
        network: 'network',
        subnetwork: 'subnet',
        instance: { selfLink: 'instance', instanceId: 'instance-id', name: 'clickhouse' },
        hostAccount: 'host@example.test',
        port: 8123,
        consumerProject: 'test',
        consumerAccount: null,
        readerSecretId: 'reader',
        dependsOn: [],
      })
      return { ready: pulumi.all(edge.ready.map((resource) => resource.urn)), metric: edge.metricTarget }
    })
    // ClickStack returns void; draining all RPCs also waits for that publication's registrations.
    await pulumi.runtime.disconnect()
  } finally {
    keys.forEach((key, index) =>
      previous[index] ? Object.defineProperty(globals, key, previous[index]!) : delete globals[key],
    )
  }
  if (process.env.SHAPE_RECEIPTS)
    writeFileSync(
      join(process.env.SHAPE_RECEIPTS, 'backends.json'),
      JSON.stringify(Object.fromEntries([...resources].sort()), null, 2),
    )
  for (const [backend, health, type] of [
    ['ProxyBackend', 'ProxyHealthCheck', 'gcp:compute/backendService:BackendService'],
    ['ClickStackBackend', 'ClickStackHealth', 'gcp:compute/regionBackendService:RegionBackendService'],
  ]) {
    await t.test(backend, () => {
      assert.ok(resources.has(health), `${health} must be constructed`)
      assert.equal(resources.get(backend)?.type, type)
      assert.equal(resources.get(backend)!.inputs.healthChecks, `${health}-id`)
    })
  }
  await t.test('other port array contracts remain intact', () => {
    assert.deepEqual(resources.get('ProxyService')!.inputs.spec.ports, [
      { name: 'proxy', protocol: 'TCP', port: 4000, targetPort: 'proxy' },
    ])
    assert.deepEqual(resources.get('ClickStackForwardingRule')!.inputs.ports, ['8123'])
    assert.deepEqual(resources.get('ClickStackFirewall')!.inputs.allows, [{ protocol: 'tcp', ports: ['8123'] }])
  })
})
