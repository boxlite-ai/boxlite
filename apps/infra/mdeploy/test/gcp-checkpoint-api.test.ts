import assert from 'node:assert/strict'
import test from 'node:test'
import { gcpApiProvider } from '../stack/providers/gcp/api.ts'
import type { ApiDependencies, ApiCapability } from '../stack/api.ts'

const out = <T>(value: T): any => ({ value, apply: (render: (value: T) => unknown) => out(render(value)) })

for (const checkpointAccess of [false, true]) {
  test(`GCP API grants checkpoint object access only with its capability (${checkpointAccess})`, (t) => {
    const resources: { kind: string; name: string; args: any }[] = []
    const constructor = (kind: string) =>
      class {
        id: any
        name: any
        address = out('192.0.2.1')
        dnsResourceRecords = [{ name: '_verify.example.invalid', type: 'CNAME', data: 'verify.example.invalid' }]
        constructor(name: string, args: any) {
          resources.push({ kind, name, args })
          this.id = out(`${kind}/${name}`)
          this.name = out(args.name || name)
        }
      }
    const target = globalThis as Record<string, unknown>
    const saved = new Map(['$app', '$util', '$resolve', 'gcp', 'cloudflare'].map((key) => [key, target[key]]))
    t.after(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete target[key]
        else target[key] = value
      }
    })
    target.$app = { name: 'boxlite', stage: 'dev' }
    target.$util = { output: (value: any) => (value?.apply ? value : out(value)) }
    target.$resolve = (values: any[]) => out(values.map((value) => value?.value ?? value))
    target.cloudflare = { Record: constructor('cloudflare.Record') }
    target.gcp = Object.fromEntries(
      Object.entries({
        storage: ['BucketIAMMember'],
        projects: ['IAMMember', 'IAMCustomRole'],
        secretmanager: ['SecretIamMember'],
        cloudrunv2: ['Service', 'ServiceIamMember'],
        certificatemanager: ['DnsAuthorization', 'Certificate'],
        dns: ['ManagedZone', 'RecordSet'],
        compute: [
          'RegionNetworkEndpointGroup',
          'BackendService',
          'URLMap',
          'ManagedSslCertificate',
          'TargetHttpsProxy',
          'GlobalAddress',
          'GlobalForwardingRule',
          'RegionBackendService',
          'RegionUrlMap',
          'RegionTargetHttpsProxy',
          'Address',
          'ForwardingRule',
          'Firewall',
        ],
      }).map(([namespace, names]) => [
        namespace,
        Object.fromEntries(names.map((name) => [name, constructor(`${namespace}.${name}`)])),
      ]),
    )
    ;(target.gcp as any).organizations = { getProjectOutput: () => ({ number: out('123456789012') }) }
    const storage: ApiDependencies['storage'] = {
      name: out('control-plane-storage'),
      binding: {
        cloud: 'gcp',
        bucketUrl: out('gs://control-plane-storage'),
        listGrant: 'roles/storage.legacyBucketReader',
        lifecycleGrant: 'volume-lifecycle',
        volumeCondition: { title: 'volumes', description: 'volume buckets', expression: 'volume-prefix' },
        credentialVending: { serviceAccount: out('volumes@example.invalid') },
      },
      checkpoints: {
        active: true,
        bucket: out('checkpoint-archives'),
        archivePrefix: out('gs://checkpoint-archives/checkpoints/'),
      },
      ready: [],
    }
    const dependencies = {
      storage,
      clickhouse: { active: false },
      waitFor: [],
      placement: {
        cloud: 'gcp',
        serviceAccount: out('api@example.invalid'),
        subnetwork: out('subnet'),
        egressSubnetwork: out('egress'),
      },
      database: {
        binding: {
          cloud: 'gcp',
          passwordRef: out('projects/test/secrets/db-password/versions/latest'),
          connectionName: out('test:region:database'),
        },
      },
      cache: {
        binding: {
          cloud: 'gcp',
          passwordRef: out('projects/test/secrets/cache-password/versions/latest'),
          caRef: out('projects/test/secrets/cache-ca/versions/latest'),
        },
      },
    } as unknown as ApiDependencies
    const capabilities: ApiCapability[] = [{ kind: 'list-own-bucket', storage }]
    if (checkpointAccess && storage.checkpoints.active) {
      capabilities.push({ kind: 'manage-checkpoint-archives', checkpoints: storage.checkpoints })
    }
    const api = gcpApiProvider({
      dependencies,
      project: 'test-project',
      region: 'us-west1',
      zone: 'us-west1-a',
      domain: 'example.invalid',
      dashboardDomain: null,
      callers: [],
      zoneId: 'test-zone',
      network: out('network'),
      runnerAccount: out('runner@example.invalid'),
    })({
      image: 'api:test',
      port: 3000,
      domain: 'example.invalid',
      environment: {},
      secrets: {},
      capabilities,
    })
    const grants = resources.filter((resource) => resource.kind === 'storage.BucketIAMMember')
    const control = grants.find(({ args }) => args.bucket.value === 'control-plane-storage')!
    assert.equal(control.args.role, 'roles/storage.legacyBucketReader')
    assert.equal(control.args.member.value, 'serviceAccount:api@example.invalid')
    const archives = grants.filter(({ args }) => args.bucket.value === 'checkpoint-archives')
    assert.equal(archives.length, checkpointAccess ? 1 : 0)
    if (checkpointAccess) {
      assert.equal(archives[0].args.role, 'roles/storage.objectUser')
      assert.equal(archives[0].args.member.value, 'serviceAccount:api@example.invalid')
      assert.ok(api.ready.some((resource: any) => resource.id.value === `storage.BucketIAMMember/${archives[0].name}`))
    }
    assert.equal(grants.length, checkpointAccess ? 2 : 1)
    assert.equal(
      resources.some(({ kind, args }) => kind === 'projects.IAMMember' && args.role === 'roles/storage.objectUser'),
      false,
    )
  })
}
