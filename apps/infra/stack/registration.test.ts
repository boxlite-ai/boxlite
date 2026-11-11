// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'
import { all, interpolate, isSecret, output, secret, type Input, type Output } from '@pulumi/pulumi'

// Dynamic loading keeps tooling checks independent of SST's generated ambient declarations.
const deployModule = new URL('./deploy.ts', import.meta.url).href
// Await the Output promise so synthesis errors reject instead of leaving the fixture pending.
const resolved = <T>(value: Input<T>): Promise<T> =>
  (output(value) as Output<T> & { promise(): Promise<T> }).promise()

async function synthesize(
  environment: Record<string, string | undefined> = {},
  credential: string | null = 'stored-turnstile-secret',
) {
  const services = new Map<string, Record<string, any>>()
  const secrets = new Map<string, { value: Output<string>; fallback: string | undefined }>()
  const pending: Input<unknown>[] = []
  const globals = globalThis as unknown as Record<string, unknown>
  const previousEnvironment = process.env
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>()

  // Provider constructors record inputs only. Pulumi Outputs retain their real secret semantics.
  class Resource {
    id: Output<string>
    name: Output<string>
    arn: Output<string>
    constructor(name: string, args: Record<string, any> = {}) {
      this.id = output(`${name}-id`)
      this.name = output<string>(args.name ?? name)
      this.arn = output(`arn:aws:iam::123456789012:role/${name}`)
      if (args.userDataBase64) pending.push(args.userDataBase64)
    }
  }
  class Secret {
    value: Output<string>
    constructor(name: string, fallback?: string) {
      const value = name === 'TURNSTILE_SECRET_KEY' ? credential ?? undefined : `stored-${name}`
      const resolvedValue = value ?? fallback
      if (resolvedValue === undefined) throw new Error(`Missing SST secret: ${name}`)
      this.value = secret(resolvedValue)
      secrets.set(name, { value: this.value, fallback })
    }
  }
  class Service {
    url: Output<string>
    nodes: { taskRole: { arn: Output<string> } }
    constructor(name: string, args: Record<string, any>) {
      services.set(name, args)
      this.url = output(`https://${name.toLowerCase()}.example.com/`)
      this.nodes = { taskRole: { arn: output(`arn:aws:iam::123456789012:role/${name}`) } }
    }
  }
  class Vpc extends Resource {
    securityGroups = ['sg-vpc']
    privateSubnets = ['subnet-private']
    publicSubnets = ['subnet-public']
    nodes = {
      vpc: { id: 'vpc-id', cidrBlock: '10.0.0.0/16' },
      cloudmapNamespace: { id: 'namespace-id', name: 'internal' },
      privateRouteTables: output([{ id: 'route-private' }]),
    }
  }
  class Database extends Resource {
    host = output('database.internal')
    port = output(5432)
    username = output('boxlite')
    password = secret('database-password')
    database = output('boxlite')
  }
  class Redis extends Database { override port = output(6379) }
  class RandomPassword { result = secret('generated-password') }
  class Router { route() {} }
  const replacements = {
    $app: { name: 'boxlite', stage: 'dev' },
    $cli: { paths: { root: new URL('..', import.meta.url).pathname } },
    $util: { output, secret },
    $resolve: all,
    $interpolate: interpolate,
    $transform: () => {},
    random: { RandomPassword },
    command: { local: { Command: Resource } },
    aws: {
      getCallerIdentity: async () => ({ accountId: '123456789012' }),
      getCallerIdentityOutput: () => ({ accountId: output('123456789012') }),
      getRegionOutput: () => ({ name: output('ap-southeast-1') }),
      iam: { Role: Resource, RolePolicy: Resource, RolePolicyAttachment: Resource, InstanceProfile: Resource },
      ec2: { VpcEndpoint: Resource, SecurityGroup: Resource, Instance: Resource, getAmi: async () => ({ id: 'ami-test' }) },
    },
    sst: {
      Secret,
      cloudflare: { dns: () => ({}) },
      aws: { Service, Vpc, Postgres: Database, Redis, Bucket: Resource, Cluster: Resource, Router, Email: Resource },
    },
  }
  try {
    process.env = {
      AWS_REGION: 'ap-southeast-1',
      VERSION: '0.1.0',
      STACK_DOMAIN: 'dev.example.com',
      OIDC_ISSUER_BASE_URL: 'https://auth.example.com',
      IAM_PERMISSIONS_BOUNDARY_STAGE: 'dev',
      CLICKHOUSE_MODE: 'disabled',
      API_ARTIFACT_SOURCE: 'release',
      TURNSTILE_SITEKEY: 'public-widget-key',
      TURNSTILE_EXPECTED_HOSTNAMES: 'dev.example.com,preview.example.com',
      ...environment,
    }
    for (const [name, value] of Object.entries(replacements)) {
      previousGlobals.set(name, Object.getOwnPropertyDescriptor(globals, name))
      globals[name] = value
    }
    const { deployStack } = await import(deployModule)
    await deployStack()
    const api = services.get('Api')
    assert.ok(api, 'deployStack must construct the API service')
    return { environment: api.environment, secrets }
  } finally {
    try {
      await resolved(all(pending))
    } finally {
      process.env = previousEnvironment
      for (const [name, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globals, name, descriptor)
        else delete globals[name]
      }
    }
  }
}

test('SST registration synthesis delivers stage credentials and default verification settings to the API', async () => {
  const { environment, secrets } = await synthesize({ TURNSTILE_SECRET_KEY: 'untrusted-plaintext-env' })
  const stored = secrets.get('TURNSTILE_SECRET_KEY')
  assert.ok(stored)
  assert.equal(stored.fallback, undefined, 'the credential must not have a deployable fallback')
  assert.equal(environment.TURNSTILE_SECRET_KEY, stored.value)
  assert.equal(await isSecret(environment.TURNSTILE_SECRET_KEY), true)
  assert.equal(await resolved(environment.TURNSTILE_SECRET_KEY), 'stored-turnstile-secret')
  assert.equal(environment.TURNSTILE_SITEKEY, 'public-widget-key')
  assert.equal(environment.TURNSTILE_EXPECTED_HOSTNAMES, 'dev.example.com,preview.example.com')
  assert.equal(environment.TURNSTILE_TIMEOUT_MS, '5000')
})

test('SST registration synthesis preserves explicitly configured widget settings and timeout', async () => {
  const settings = {
    TURNSTILE_SITEKEY: 'another-widget',
    TURNSTILE_EXPECTED_HOSTNAMES: 'console.example.org',
    TURNSTILE_TIMEOUT_MS: '7500',
  }
  const { environment } = await synthesize(settings)
  for (const [key, value] of Object.entries(settings)) assert.equal(environment[key], value, key)
})

for (const key of ['TURNSTILE_SITEKEY', 'TURNSTILE_EXPECTED_HOSTNAMES']) {
  for (const value of [undefined, '']) {
    test(`SST registration synthesis ${key === 'TURNSTILE_SITEKEY' ? 'disables verification for' : 'rejects'} ${key} when ${value === undefined ? 'missing' : 'empty'}`, async () => {
      if (key === 'TURNSTILE_SITEKEY') {
        const { environment, secrets } = await synthesize({ [key]: value }, null)
        assert.equal(secrets.has('TURNSTILE_SECRET_KEY'), false)
        assert.equal(
          Object.keys(environment).some((name) => name.startsWith('TURNSTILE_')),
          false,
        )
      } else {
        await assert.rejects(synthesize({ [key]: value }), new RegExp(`${key} is required`))
      }
    })
  }
}

test('SST registration synthesis requires the stage secret even when a plaintext environment value exists', async () => {
  // The double checks the required-secret constructor contract; it does not query SST's secret store.
  await assert.rejects(
    synthesize({ TURNSTILE_SECRET_KEY: 'plaintext-env' }, null),
    /Missing SST secret: TURNSTILE_SECRET_KEY/,
  )
})
