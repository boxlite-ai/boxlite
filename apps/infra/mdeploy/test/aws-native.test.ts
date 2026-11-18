import assert from 'node:assert/strict'
import test from 'node:test'
import * as pulumi from '@pulumi/pulumi'
import * as awsSdk from '@pulumi/aws'
import * as cloudflareSdk from '@pulumi/cloudflare'
import { awsCertificate, proxyCertificateDomains } from '../stack/providers/aws/certificate.ts'
import { awsService } from '../stack/providers/aws/service.ts'
import { awsNetworkProvider } from '../stack/providers/aws/network.ts'
import { awsClusterProvider } from '../stack/providers/aws/cluster.ts'
import { awsStorageProvider } from '../stack/providers/aws/storage.ts'
import { awsRegistryCredentialStoreProvider } from '../stack/providers/aws/registry-credentials.ts'
import { awsRegistryProxyProvider } from '../stack/providers/aws/registry-proxy.ts'
import { awsCacheProvider } from '../stack/providers/aws/cache.ts'
import { awsApiProvider } from '../stack/providers/aws/api.ts'
import { awsRunnerProvider } from '../stack/providers/aws/runners.ts'
import { runnerFleetFrom } from '../src/stack-env.ts'
import { componentTargets } from '../src/components.ts'
import type { Network } from '../stack/network.ts'
import * as commandSdk from '@pulumi/command'

const resources: { type: string; name: string; inputs: Record<string, any>; id: string }[] = []
pulumi.runtime.setMocks(
  {
    newResource(args) {
      const id =
        args.type === 'aws:ebs/volume:Volume'
          ? 'vol-0123456789abcdef0'
          : args.name === 'Runner'
            ? 'i-0123456789abcdef0'
            : args.name
      resources.push({ type: args.type, name: args.name, inputs: args.inputs, id })
      const state = {
        ...args.inputs,
        bucket: args.inputs.bucket ?? args.name.toLowerCase(),
        name: args.inputs.name ?? args.name,
        arn: `arn:aws:fixture:us-east-1:123456789012:${args.name}`,
        dkimSigningAttributes: { tokens: ['fixture1', 'fixture2', 'fixture3'] },
        primaryNetworkInterfaceId: `eni-${args.name}`,
        domainValidationOptions: [args.inputs.domainName, ...(args.inputs.subjectAlternativeNames ?? [])]
          .filter(Boolean)
          .map((domainName) => ({
            domainName,
            resourceRecordName: `_validation.${domainName.replace(/^\*\./, '')}.`,
            resourceRecordValue: 'token.acm-validations.aws.',
            resourceRecordType: 'CNAME',
          })),
      }
      return { id, state }
    },
    call(args) {
      if (args.token.includes('getCallerIdentity')) return { accountId: '123456789012' }
      if (args.token.includes('getRegion')) return { name: 'us-east-1' }
      if (args.token.includes('getAvailabilityZones')) return { names: ['us-east-1a', 'us-east-1b'] }
      if (args.token.includes('getSubnet')) return { availabilityZone: 'us-east-1a' }
      if (args.token.includes('getAmi')) return { id: 'ami-fixture' }
      throw new Error(`Unexpected invoke ${args.token}`)
    },
  },
  'boxlite-app',
  'dev',
  false,
)
Object.assign(globalThis, {
  $app: { name: 'boxlite-app', stage: 'dev' },
  $util: pulumi,
  $resolve: pulumi.all,
  $interpolate: pulumi.interpolate,
  $jsonStringify: pulumi.jsonStringify,
  command: commandSdk,
  aws: awsSdk,
  cloudflare: cloudflareSdk,
})
const resolved = async (value: unknown) => (pulumi.output(value) as any).promise()

let network: Network

test('native networking retains two zones, CIDRs and working private NAT routes', async () => {
  network = awsNetworkProvider({ region: 'us-east-1' })({ internetEgress: true })
  await Promise.all([resolved(network.binding), ...network.ready.map((resource) => resolved(resource.urn))])
  const subnets = resources.filter((resource) => resource.type === 'aws:ec2/subnet:Subnet')
  assert.deepEqual(subnets.map((resource) => resource.inputs.cidrBlock).sort(), [
    '10.0.0.0/22',
    '10.0.12.0/22',
    '10.0.4.0/22',
    '10.0.8.0/22',
  ])
  const routes = resources.filter((resource) => resource.type === 'aws:ec2/routeTable:RouteTable')
  assert.equal(routes.length, 4)
  const privateRoutes = routes.filter((resource) => resource.name.includes('Private'))
  assert.equal(privateRoutes.length, 2)
  assert.ok(
    privateRoutes.every((resource) => resource.inputs.routes[0].networkInterfaceId.startsWith('eni-VpcNatInstance')),
  )
  assert.equal(resources.filter((resource) => resource.type === 'aws:ec2/instance:Instance').length, 2)
  for (const role of resources.filter((resource) => resource.type === 'aws:iam/role:Role'))
    assert.equal(role.inputs.permissionsBoundary, 'arn:aws:iam::123456789012:policy/boxlite-app-dev-runtime-boundary')
})

test('Fargate keeps secret values out of definitions and waits for bounded execution grants', async () => {
  const secret = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:fixture-AbCdEf'
  const deployed = awsService('FixtureApi', {
    host: { cloud: 'aws', cluster: { arn: pulumi.output('cluster') } },
    placement: {
      cloud: 'aws',
      exposure: 'private',
      subnets: pulumi.output(['private-a', 'private-b']),
      securityGroups: [pulumi.output('service-sg')],
    } as any,
    image: 'registry.example/api@sha256:fixture',
    port: 3000,
    environment: { ORDINARY: 'value' },
    secrets: { CREDENTIAL: pulumi.output(secret) } as any,
  })
  await resolved(deployed.service.urn)
  const task = resources.find((resource) => resource.name === 'FixtureApiTask')!
  const [container] = JSON.parse(task.inputs.containerDefinitions)
  assert.deepEqual(container.secrets, [{ name: 'CREDENTIAL', valueFrom: secret }])
  assert.deepEqual(container.environment, [{ name: 'ORDINARY', value: 'value' }])
  const grant = resources.find((resource) => resource.name === 'FixtureApiExecutionSecrets')!
  assert.deepEqual(JSON.parse(grant.inputs.policy).Statement[0].Resource, [secret])
  const service = resources.find((resource) => resource.name === 'FixtureApiService')!
  assert.equal(service.inputs.networkConfiguration.assignPublicIp, false)
  assert.deepEqual(service.inputs.networkConfiguration.subnets, ['private-a', 'private-b'])
})

test('the platform certificate covers proxy and application names with one validation per domain', async () => {
  const certificate = awsCertificate(
    'FixtureProxy',
    proxyCertificateDomains('proxy.example.com', 'proxy-zone', {
      domain: 'apps.example.net',
      dnsZoneId: 'application-zone',
    }),
  )
  await resolved(certificate.urn)
  const requested = resources.find((resource) => resource.name === 'FixtureProxy')!
  assert.deepEqual([requested.inputs.domainName, ...requested.inputs.subjectAlternativeNames].sort(), [
    '*.apps.example.net',
    '*.proxy.example.com',
    'apps.example.net',
    'proxy.example.com',
  ])
  assert.equal(resources.filter((resource) => /^FixtureProxyValidation\d+$/.test(resource.name)).length, 2)
})

test('native AWS connects checkpoint, credential and disk capabilities at real provider boundaries', async () => {
  const cluster = awsClusterProvider({ network })({ roles: ['api', 'registry-proxy'] })
  const host = cluster.hostFor('api') as any
  const placement = network.placementFor('api') as any
  const storage = awsStorageProvider({ accountId: '123456789012' })({
    volumePrefix: 'community-volume',
    versioning: true,
  })
  const credentials = awsRegistryCredentialStoreProvider({ accountId: '123456789012', region: 'us-east-1' })()
  const proxy = awsRegistryProxyProvider({
    host,
    placement: network.placementFor('registry-proxy') as any,
    runnerPlacement: network.placementFor('runner') as any,
    domain: 'example.test',
    zoneId: 'zone',
    registryCredentials: credentials,
    dependsOn: network.ready,
  })({ image: 'registry.example/proxy:fixture', environment: {} })
  assert.equal(proxy.active, true)
  const api = awsApiProvider({
    domain: 'example.test',
    dashboardDomain: null,
    zoneId: 'zone',
    dependencies: {
      host,
      placement,
      storage,
      database: { binding: { passwordRef: pulumi.output('database-secret'), clientGrant: pulumi.output('db-client') } },
      cache: { binding: { passwordRef: pulumi.output('cache-secret'), clientGrant: pulumi.output('cache-client') } },
      clickhouse: { active: false },
      waitFor: [],
    } as any,
  })({
    domain: 'example.test',
    image: 'registry.example/api:fixture',
    port: 3000,
    environment: { RUNNER_DISK_APP: 'untrusted-override' },
    secrets: {},
    capabilities: [
      { kind: 'write-registry-credentials', store: credentials },
      { kind: 'manage-checkpoint-archives', checkpoints: storage.checkpoints },
      { kind: 'resize-runner-disks' },
    ] as any,
  })
  await Promise.all(
    [...storage.ready, ...api.ready, ...(proxy.active ? proxy.ready : [])].map((resource) => resolved(resource.urn)),
  )
  assert.equal(storage.checkpoints.active, true)
  if (storage.checkpoints.active)
    assert.match(await resolved(storage.checkpoints.archivePrefix), /^s3:\/\/checkpoints\/checkpoints\/$/)
  const task = resources.find((resource) => resource.name === 'ApiTask')!
  const [container] = JSON.parse(task.inputs.containerDefinitions)
  const environment = Object.fromEntries(container.environment.map((item: any) => [item.name, item.value]))
  assert.deepEqual(
    [environment.RUNNER_DISK_CLOUD, environment.RUNNER_DISK_APP, environment.RUNNER_DISK_STAGE],
    ['aws', 'boxlite-app', 'dev'],
  )
  assert.deepEqual([environment.AWS_ACCOUNT_ID, environment.AWS_REGION], ['123456789012', 'us-east-1'])
  assert.equal(environment.S3_ENDPOINT, 'https://s3.us-east-1.amazonaws.com')
  assert.equal(environment.S3_STS_ENDPOINT, 'https://sts.us-east-1.amazonaws.com')
  assert.equal(environment.S3_ROLE_NAME, 'boxlite-app-dev-s3-access')
  assert.equal(environment.S3_ACCOUNT_ID, '123456789012')
  const proxyTask = resources.find((resource) => resource.name === 'RegistryProxyService')!
  assert.deepEqual(proxyTask.inputs.networkConfiguration.securityGroups, ['RegistryProxySecurityGroup'])
  assert.ok(!proxyTask.inputs.networkConfiguration.securityGroups.includes('db-client'))
  const ingress = resources.find((resource) => resource.name === 'RegistryProxyBalancerSecurityGroup')!
  assert.deepEqual(ingress.inputs.ingress[0].securityGroups, ['RunnerSecurityGroup'])
  assert.equal(ingress.inputs.ingress[0].cidrBlocks, undefined)
  const checkpointBucket = resources.find((resource) => resource.name === 'Checkpoints')!
  assert.equal(checkpointBucket.inputs.forceDestroy, undefined)
  const read = JSON.parse(resources.find((resource) => resource.name === 'RegistryProxySecretRead')!.inputs.policy)
  assert.ok(
    read.Statement.some(
      (statement: any) => statement.Effect === 'Deny' && statement.Action.includes('secretsmanager:PutSecretValue'),
    ),
  )
  const write = JSON.parse(resources.find((resource) => resource.name === 'ApiCapability0')!.inputs.policy)
  assert.ok(
    write.Statement.some(
      (statement: any) => statement.Effect === 'Deny' && statement.Action.includes('secretsmanager:GetSecretValue'),
    ),
  )
  const growth = JSON.parse(resources.find((resource) => resource.name === 'ApiCapability2')!.inputs.policy)
    .Statement[0]
  assert.equal(growth.Condition.StringEquals['ec2:ResourceTag/boxlite:stage'], 'dev')
  const prefix = 'urn:pulumi:dev::boxlite-app::'
  const exported = resources.map((resource) => ({ ...resource, urn: prefix + resource.type + '::' + resource.name }))
  const targets = componentTargets({
    home: 'aws',
    components: 'api',
    app: 'boxlite-app',
    stage: 'dev',
    resources: exported,
    environment: {},
  })
  assert.ok(targets.includes(prefix + 'aws:ecs/service:Service::ApiService'))
  assert.ok(targets.includes(prefix + 'aws:ecs/taskDefinition:TaskDefinition::ApiTask'))
})

test('AWS scoped Runner targets require the emitted host, disk and attachment inventory', async () => {
  const fleet = runnerFleetFrom({ environment: {}, app: 'boxlite-app', stage: 'dev' })
  const binary = {
    tarballUrl: 'https://example.test/runner.tar.gz',
    checksumUrl: 'https://example.test/runner.tar.gz.sha256',
    tarballName: 'runner.tar.gz',
    source: 'release',
    transport: 'https',
    identity: '0.11.0',
  } as const
  const runners = awsRunnerProvider({
    placement: network.placementFor('runner') as any,
    region: 'us-east-1',
    accountId: '123456789012',
    artifactsBucket: 'fixture-artifacts',
    adminApiKey: 'synthetic-admin',
    regionId: 'fixture-region',
    dependsOn: [],
  })({
    fleet: fleet.map((slot) => ({ slot, token: pulumi.output('synthetic-token') })),
    size: 'small',
    rootDiskGb: 100,
    nestedVirtualization: true,
    binary,
    apiUrl: pulumi.output('https://api.example.test'),
    otlpUrl: pulumi.output('http://collector.example.test:4318'),
    registryProxyHost: null,
    checkpointBucket: null,
    environment: {},
    secrets: {},
  })
  await Promise.all(runners.ready.map((resource) => resolved(resource.urn)))
  const prefix = 'urn:pulumi:dev::boxlite-app::'
  const exported = resources.map((resource) => ({ ...resource, urn: prefix + resource.type + '::' + resource.name }))
  const request = {
    home: 'aws',
    components: 'runner',
    app: 'boxlite-app',
    stage: 'dev',
    resources: exported,
    environment: {},
  } as const
  const targets = componentTargets(request)
  assert.ok(targets.includes(prefix + 'command:local:Command::CheckRunnerHealth'))
  assert.ok(targets.includes(prefix + 'command:local:Command::UpgradeRunnerBinary'))
  assert.equal(resources.find((resource) => resource.name === 'RunnerDataDisk')!.inputs.size, 200)
  assert.throws(() => componentTargets({ ...request, environment: { RUNNERS: '2' } }), /full --components/)
  assert.throws(
    () =>
      componentTargets({
        ...request,
        resources: exported.filter((resource) => resource.name !== 'RunnerDataAttachment'),
      }),
    /full --components/,
  )
  const disk = exported.find((resource) => resource.name === 'RunnerDataDisk')!
  disk.inputs.tags['boxlite:control-plane-runner-name'] = 'another-runner'
  assert.throws(() => componentTargets(request), /full --components/)
})

test('AWS Redis refuses AUTH without encrypted transit before creating resources', () => {
  const before = resources.length
  assert.throws(
    () =>
      awsCacheProvider({ network: network.binding as any })({
        size: 'small',
        clustered: false,
        encryptInTransit: false,
      }),
    /AWS Redis AUTH requires encryptInTransit=true/,
  )
  assert.equal(resources.length, before)
})

test('native Pulumi program composes every AWS service and preserves the deployed non-API images', async (t) => {
  const { awsProgram } = await import('../pulumi/aws-program.ts')
  const { fileURLToPath } = await import('node:url')
  const cwd = fileURLToPath(new URL('../../', import.meta.url))
  const previous = process.env.MSTAGE_CONFIG
  process.env.MSTAGE_CONFIG = fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url))
  t.after(() => {
    if (previous === undefined) delete process.env.MSTAGE_CONFIG
    else process.env.MSTAGE_CONFIG = previous
  })
  const environment = {
    BOXLITE_IMAGE_TAG: 'b'.repeat(40),
    STACK_DOMAIN: 'dev.example.test',
    PROXY_DOMAIN: 'box.dev.example.test',
    OIDC_ISSUER_BASE_URL: 'https://identity.example.test',
    CLOUDFLARE_ZONE_ID: 'fixture-zone',
    ADMIN_API_KEY: 'fixture-admin',
    ENCRYPTION_KEY: 'fixture-key',
    ENCRYPTION_SALT: 'fixture-salt',
    OIDC_CLIENT_ID: 'fixture-client',
    OTEL_COLLECTOR_API_KEY: 'fixture-collector',
    PROXY_API_KEY: 'fixture-proxy',
    MAIL_DOMAIN: 'mail.example.test',
  }
  const retainedImages = {
    proxy: 'images/proxy:old',
    'otel-collector': 'images/collector:old',
    'registry-proxy': 'images/registry:old',
  }
  const start = resources.length
  const program = awsProgram({
    cwd,
    app: 'boxlite-app',
    stage: 'dev',
    region: 'us-east-1',
    environment,
    retainedImages,
  })
  await pulumi.runtime.runInPulumiStack(async () => {
    const outputs = await program()
    await Promise.all(Object.values(outputs).map(resolved))
    return outputs
  })
  const graph = resources.slice(start)
  const taskImage = (name: string) =>
    JSON.parse(graph.find((r) => r.name === name + 'Task')!.inputs.containerDefinitions)[0].image
  assert.match(taskImage('Api'), /b{40}/)
  assert.equal(taskImage('Proxy'), retainedImages.proxy)
  assert.equal(taskImage('OtelCollector'), retainedImages['otel-collector'])
  assert.equal(taskImage('RegistryProxy'), retainedImages['registry-proxy'])
  assert.equal(graph.find((r) => r.name === 'DatabaseInstance')!.inputs.publiclyAccessible, false)
})
