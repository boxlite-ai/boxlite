import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import * as cloudflare from '@pulumi/cloudflare'
import * as kubernetes from '@pulumi/kubernetes'
import * as command from '@pulumi/command'
import * as random from '@pulumi/random'
import { installGlobals } from '../pulumi/program.ts'
import { gcpStackProviders } from '../stack/providers/gcp/index.ts'

process.env.MSTAGE_CONFIG ??= fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url))

test('custom-domain DNS and forwarding share the reserved proxy address', { timeout: 30000 }, async (t) => {
  const resources = new Map<string, { type: string; inputs: any }>()
  await pulumi.runtime.setMocks(
    {
      newResource: ({ type, name, inputs }) => {
        resources.set(name, { type, inputs })
        const state = { ...inputs }
        if (type === 'gcp:compute/globalAddress:GlobalAddress') state.address = '192.0.2.10'
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
      const providers = gcpStackProviders({
        stage: 'stage',
        project: 'test',
        region: 'us-east5',
        appShort: 'bl-app',
        domain: 'stage.example.test',
        zoneId: 'test-zone',
        artifactsBucket: 'artifacts',
        volumePrefix: 'boxlite-volume',
      })
      const edge = providers.edge({
        network: {
          binding: { cloud: 'gcp', network: $util.output('network') },
          placementFor: () => ({
            cloud: 'gcp',
            exposure: 'private',
            subnetwork: $util.output('subnet'),
            egressSubnetwork: $util.output('egress'),
            serviceAccount: $util.output('proxy@example.test'),
          }),
        } as any,
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
      })({
        image: 'proxy:test',
        domain: 'proxy.stage.example.test',
        userDomain: { domain: 'apps.example.test', dnsZoneId: 'apps-zone' },
        protocol: 'https',
        apiUrl: 'https://api.stage.example.test',
        environment: { PROXY_API_KEY: 'synthetic-test-value' },
        secrets: {},
      })
      return { ready: pulumi.all(edge.ready.map((resource) => resource.urn)), metric: edge.metricTarget }
    })
    await pulumi.runtime.disconnect()
  } finally {
    keys.forEach((key, index) =>
      previous[index] ? Object.defineProperty(globals, key, previous[index]!) : delete globals[key],
    )
  }
  await t.test('proxy forwarding and every A record use the existing reserved address', () => {
    assert.deepEqual(resources.get('ProxyAddress'), {
      type: 'gcp:compute/globalAddress:GlobalAddress',
      inputs: { name: 'boxlite-app-stage-proxy', project: 'test' },
    })
    assert.equal(resources.get('ProxyForwardingRule')!.inputs.ipAddress, '192.0.2.10')
    for (const name of ['ProxyRecord', 'ProxyWildcardRecord', 'ProxyAppWildcardRecord']) {
      assert.equal(resources.get(name)!.inputs.content, '192.0.2.10')
    }
  })
})
