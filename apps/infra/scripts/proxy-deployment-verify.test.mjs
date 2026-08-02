// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  runAwsJson,
  verifyProxyDeployment,
  verifyProxyDeploymentWithRetry,
  verifyPublicDeployment,
  verifyPublicDeploymentWithRetry,
} from './proxy-deployment-verify.mjs'

const CLUSTER_ARN = 'arn:aws:ecs:ap-southeast-1:123456789012:cluster/boxlite-dev-cluster'
const SERVICE_ARN = `${CLUSTER_ARN.replace(':cluster/', ':service/')}/Proxy`
const TARGET_GROUP_ARN = 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/proxy/primary'
const LOAD_BALANCER_ARN = 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/net/proxy/lb'
const LISTENER_ARN = 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:listener/net/proxy/lb/listener'

test('runs the configured AWS CLI when PATH does not contain aws', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-infra-aws-cli-'))
  const awsCliPath = join(directory, 'aws-cli')
  const previousAwsCliPath = process.env.AWS_CLI_PATH
  const previousPath = process.env.PATH

  writeFileSync(awsCliPath, '#!/bin/sh\nprintf \'%s\\n\' \'{"Account":"123456789012"}\'\n')
  chmodSync(awsCliPath, 0o755)
  process.env.AWS_CLI_PATH = awsCliPath
  process.env.PATH = directory

  try {
    assert.deepEqual(runAwsJson(['sts', 'get-caller-identity'], 'ap-southeast-1'), {
      Account: '123456789012',
    })
  } finally {
    if (previousAwsCliPath === undefined) delete process.env.AWS_CLI_PATH
    else process.env.AWS_CLI_PATH = previousAwsCliPath
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  }
})

function awsCallKey(args) {
  const operation = args.slice(0, 2).join(' ')
  if (operation === 'resourcegroupstaggingapi get-resources') {
    const filterIndex = args.indexOf('--resource-type-filters')
    return `${operation} ${args[filterIndex + 1]}`
  }
  if (operation === 'elbv2 describe-listeners') {
    const loadBalancerIndex = args.indexOf('--load-balancer-arn')
    return `${operation} ${args[loadBalancerIndex + 1]}`
  }
  return operation
}

function createAwsFixture(overrides = {}) {
  const responses = {
    'resourcegroupstaggingapi get-resources ecs:cluster': {
      ResourceTagMappingList: [{ ResourceARN: CLUSTER_ARN }],
    },
    'resourcegroupstaggingapi get-resources elasticloadbalancing:loadbalancer': {
      ResourceTagMappingList: [{ ResourceARN: LOAD_BALANCER_ARN }],
    },
    'ecs describe-services': {
      failures: [],
      services: [
        {
          serviceArn: SERVICE_ARN,
          status: 'ACTIVE',
          desiredCount: 1,
          runningCount: 1,
          loadBalancers: [
            {
              targetGroupArn: TARGET_GROUP_ARN,
              containerName: 'Proxy',
              containerPort: 4000,
            },
          ],
        },
      ],
    },
    'elbv2 describe-target-groups': {
      TargetGroups: [
        {
          TargetGroupArn: TARGET_GROUP_ARN,
          LoadBalancerArns: [LOAD_BALANCER_ARN],
          Port: 4000,
          Protocol: 'TCP',
          TargetType: 'ip',
          HealthCheckProtocol: 'HTTP',
          HealthCheckPath: '/health',
        },
      ],
    },
    [`elbv2 describe-listeners ${LOAD_BALANCER_ARN}`]: {
      Listeners: [
        {
          ListenerArn: LISTENER_ARN,
          Port: 443,
          Protocol: 'TLS',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: TARGET_GROUP_ARN }],
        },
      ],
    },
    'elbv2 describe-target-health': {
      TargetHealthDescriptions: [{ Target: { Id: '10.0.1.23', Port: 4000 }, TargetHealth: { State: 'healthy' } }],
    },
    ...overrides,
  }
  const calls = []
  return {
    calls,
    awsJson(args) {
      calls.push(args)
      const key = awsCallKey(args)
      if (!(key in responses)) throw new Error(`unexpected AWS call: ${args.join(' ')}`)
      return responses[key]
    },
  }
}

test('verifies the listener, ECS attachment, and healthy Proxy targets', () => {
  const fixture = createAwsFixture()

  const result = verifyProxyDeployment({
    app: 'boxlite',
    stage: 'dev',
    region: 'ap-southeast-1',
    awsJson: fixture.awsJson,
  })

  assert.deepEqual(result, {
    clusterArn: CLUSTER_ARN,
    serviceArn: SERVICE_ARN,
    listenerArn: LISTENER_ARN,
    targetGroupArn: TARGET_GROUP_ARN,
    desiredCount: 1,
    healthyTargetCount: 1,
  })
  assert.equal(fixture.calls.length, 6)
})

test('rejects a Proxy service response without a running task count', () => {
  const fixture = createAwsFixture({
    'ecs describe-services': {
      failures: [],
      services: [
        {
          serviceArn: SERVICE_ARN,
          status: 'ACTIVE',
          desiredCount: 1,
          loadBalancers: [
            {
              targetGroupArn: TARGET_GROUP_ARN,
              containerName: 'Proxy',
              containerPort: 4000,
            },
          ],
        },
      ],
    },
  })

  assert.throws(
    () =>
      verifyProxyDeployment({
        app: 'boxlite',
        stage: 'dev',
        region: 'ap-southeast-1',
        awsJson: fixture.awsJson,
      }),
    /running task count is missing, expected a non-negative integer/,
  )
})

test('rejects a listener that forwards to a target group not attached to Proxy', () => {
  const fixture = createAwsFixture({
    [`elbv2 describe-listeners ${LOAD_BALANCER_ARN}`]: {
      Listeners: [
        {
          ListenerArn: LISTENER_ARN,
          Port: 443,
          Protocol: 'TLS',
          DefaultActions: [
            {
              Type: 'forward',
              TargetGroupArn: 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/proxy/detached',
            },
          ],
        },
      ],
    },
  })

  assert.throws(
    () =>
      verifyProxyDeployment({
        app: 'boxlite',
        stage: 'dev',
        region: 'ap-southeast-1',
        awsJson: fixture.awsJson,
      }),
    /does not match the Proxy ECS target group/,
  )
})

test('rejects an internally healthy legacy attachment when the SST NLB forwards elsewhere', () => {
  const legacyTargetGroupArn = 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/proxy/legacy'
  const legacyLoadBalancerArn = 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/net/proxy/legacy'
  const fixture = createAwsFixture({
    'ecs describe-services': {
      failures: [],
      services: [
        {
          serviceArn: SERVICE_ARN,
          status: 'ACTIVE',
          desiredCount: 1,
          runningCount: 1,
          loadBalancers: [
            {
              targetGroupArn: legacyTargetGroupArn,
              containerName: 'Proxy',
              containerPort: 4000,
            },
          ],
        },
      ],
    },
    'elbv2 describe-target-groups': {
      TargetGroups: [
        {
          TargetGroupArn: legacyTargetGroupArn,
          LoadBalancerArns: [legacyLoadBalancerArn],
          Port: 4000,
          Protocol: 'TCP',
          TargetType: 'ip',
          HealthCheckProtocol: 'HTTP',
          HealthCheckPath: '/health',
        },
      ],
    },
    [`elbv2 describe-listeners ${legacyLoadBalancerArn}`]: {
      Listeners: [
        {
          ListenerArn: `${legacyLoadBalancerArn}/listener`,
          Port: 443,
          Protocol: 'TLS',
          DefaultActions: [{ Type: 'forward', TargetGroupArn: legacyTargetGroupArn }],
        },
      ],
    },
  })

  assert.throws(
    () =>
      verifyProxyDeployment({
        app: 'boxlite',
        stage: 'dev',
        region: 'ap-southeast-1',
        awsJson: fixture.awsJson,
      }),
    /does not match the Proxy ECS target group/,
  )
})

test('rejects a target group that does not use the Proxy HTTP health check', () => {
  const fixture = createAwsFixture({
    'elbv2 describe-target-groups': {
      TargetGroups: [
        {
          TargetGroupArn: TARGET_GROUP_ARN,
          LoadBalancerArns: [LOAD_BALANCER_ARN],
          Port: 4000,
          Protocol: 'TCP',
          TargetType: 'ip',
          HealthCheckProtocol: 'TCP',
        },
      ],
    },
  })

  assert.throws(
    () =>
      verifyProxyDeployment({
        app: 'boxlite',
        stage: 'dev',
        region: 'ap-southeast-1',
        awsJson: fixture.awsJson,
      }),
    /health check is TCP:missing, expected HTTP:\/health/,
  )
})

test('rejects a target group without enough healthy targets for the service', () => {
  const fixture = createAwsFixture({
    'ecs describe-services': {
      failures: [],
      services: [
        {
          serviceArn: SERVICE_ARN,
          status: 'ACTIVE',
          desiredCount: 2,
          runningCount: 2,
          loadBalancers: [
            {
              targetGroupArn: TARGET_GROUP_ARN,
              containerName: 'Proxy',
              containerPort: 4000,
            },
          ],
        },
      ],
    },
  })

  assert.throws(
    () =>
      verifyProxyDeployment({
        app: 'boxlite',
        stage: 'dev',
        region: 'ap-southeast-1',
        awsJson: fixture.awsJson,
      }),
    /has 1 healthy target; expected at least 2/,
  )
})

test('retries a bounded number of times while AWS deployment state converges', async () => {
  let verificationAttempts = 0
  const retryDelays = []

  const result = await verifyProxyDeploymentWithRetry(
    { app: 'boxlite', stage: 'dev', region: 'ap-southeast-1' },
    {
      attempts: 3,
      delayMs: 25,
      verify() {
        verificationAttempts += 1
        if (verificationAttempts < 3) throw new Error('target is still registering')
        return { healthyTargetCount: 1 }
      },
      sleep(delayMs) {
        retryDelays.push(delayMs)
        return Promise.resolve()
      },
    },
  )

  assert.deepEqual(result, { healthyTargetCount: 1 })
  assert.equal(verificationAttempts, 3)
  assert.deepEqual(retryDelays, [25, 25])
})

test('returns the last verification error after the retry limit', async () => {
  let verificationAttempts = 0
  const expectedError = new Error('target never became healthy')

  await assert.rejects(
    verifyProxyDeploymentWithRetry(
      { app: 'boxlite', stage: 'dev', region: 'ap-southeast-1' },
      {
        attempts: 2,
        delayMs: 0,
        verify() {
          verificationAttempts += 1
          throw expectedError
        },
        sleep() {
          return Promise.resolve()
        },
      },
    ),
    expectedError,
  )
  assert.equal(verificationAttempts, 2)
})

test('aborts a pending verification retry delay', async () => {
  const controller = new AbortController()
  const interrupted = new Error('deployment verification interrupted')
  const startedAt = Date.now()
  const verification = verifyProxyDeploymentWithRetry(
    { app: 'boxlite', stage: 'dev', region: 'ap-southeast-1' },
    {
      attempts: 2,
      delayMs: 250,
      signal: controller.signal,
      verify() {
        throw new Error('target is still registering')
      },
    },
  )

  controller.abort(interrupted)
  await assert.rejects(verification, interrupted)
  assert.ok(Date.now() - startedAt < 200, 'abort must not wait for the retry delay')
})

test('the default retry window covers two 30-second target health checks', async () => {
  let verificationAttempts = 0
  const retryDelays = []
  const expectedError = new Error('target health is still converging')

  await assert.rejects(
    verifyProxyDeploymentWithRetry(
      { app: 'boxlite', stage: 'dev', region: 'ap-southeast-1' },
      {
        verify() {
          verificationAttempts += 1
          throw expectedError
        },
        sleep(delayMs) {
          retryDelays.push(delayMs)
          return Promise.resolve()
        },
      },
    ),
    expectedError,
  )

  assert.equal(verificationAttempts, 7)
  assert.deepEqual(retryDelays, [10_000, 10_000, 10_000, 10_000, 10_000, 10_000])
})

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

function publicDeploymentOptions(fetchImpl) {
  return {
    proxyHealthUrl: 'https://proxy.dev.boxlite.ai/health',
    proxyWildcardHealthUrl: 'https://deployment-probe.proxy.dev.boxlite.ai/health',
    apiConfigUrl: 'https://api.dev.boxlite.ai/api/config',
    expectedOidcIssuer: 'https://auth.dev.boxlite.ai/',
    expectedProxyTemplateUrl: 'https://proxy.dev.boxlite.ai',
    expectedVersion: '0.9.7',
    fetchImpl,
  }
}

test('verifies the public Proxy health and API deployment config with an injected fetch', async () => {
  const calls = []
  const result = await verifyPublicDeployment(
    publicDeploymentOptions(async (url) => {
      calls.push(url)
      if (url === 'https://proxy.dev.boxlite.ai/health') {
        return jsonResponse(200, { status: 'ok', version: '0.0.1' })
      }
      if (url === 'https://deployment-probe.proxy.dev.boxlite.ai/health') {
        return jsonResponse(200, { status: 'ok', version: '0.0.1' })
      }
      if (url === 'https://api.dev.boxlite.ai/api/config') {
        return jsonResponse(200, {
          version: '0.9.7',
          oidc: { issuer: 'https://auth.dev.boxlite.ai/' },
          proxyTemplateUrl: 'https://proxy.dev.boxlite.ai',
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    }),
  )

  assert.deepEqual(calls, [
    'https://proxy.dev.boxlite.ai/health',
    'https://deployment-probe.proxy.dev.boxlite.ai/health',
    'https://api.dev.boxlite.ai/api/config',
  ])
  assert.deepEqual(result, {
    proxyHealthUrl: 'https://proxy.dev.boxlite.ai/health',
    proxyWildcardHealthUrl: 'https://deployment-probe.proxy.dev.boxlite.ai/health',
    apiConfigUrl: 'https://api.dev.boxlite.ai/api/config',
    oidcIssuer: 'https://auth.dev.boxlite.ai/',
    proxyTemplateHost: 'proxy.dev.boxlite.ai',
    version: '0.9.7',
  })
})

test('rejects a deployment whose base Proxy works but wildcard DNS or TLS does not', async () => {
  await assert.rejects(
    verifyPublicDeployment(
      publicDeploymentOptions(async (url) => {
        if (url === 'https://proxy.dev.boxlite.ai/health') {
          return jsonResponse(200, { status: 'ok' })
        }
        if (url === 'https://deployment-probe.proxy.dev.boxlite.ai/health') {
          return jsonResponse(502, { status: 'unavailable' })
        }
        return jsonResponse(200, {
          version: '0.9.7',
          oidc: { issuer: 'https://auth.dev.boxlite.ai/' },
          proxyTemplateUrl: 'https://proxy.dev.boxlite.ai',
        })
      }),
    ),
    /Public Proxy wildcard health check returned HTTP 502/,
  )
})

test('rejects a public API config with a different issuer or the wrong Proxy host', async () => {
  await assert.rejects(
    verifyPublicDeployment(
      publicDeploymentOptions(async (url) =>
        url.includes('/health')
          ? jsonResponse(200, { status: 'ok' })
          : jsonResponse(200, {
              version: '0.9.7',
              oidc: { issuer: 'https://auth.dev.boxlite.ai' },
              proxyTemplateUrl: 'https://proxy.dev.boxlite.ai',
            }),
      ),
    ),
    /does not match expected https:\/\/auth\.dev\.boxlite\.ai\//,
  )

  await assert.rejects(
    verifyPublicDeployment(
      publicDeploymentOptions(async (url) =>
        url.includes('/health')
          ? jsonResponse(200, { status: 'ok' })
          : jsonResponse(200, {
              version: '0.9.7',
              oidc: { issuer: 'https://auth.dev.boxlite.ai/' },
              proxyTemplateUrl: 'https://detached.dev.boxlite.ai',
            }),
      ),
    ),
    /Proxy template host detached\.dev\.boxlite\.ai does not match proxy\.dev\.boxlite\.ai/,
  )

  await assert.rejects(
    verifyPublicDeployment(
      publicDeploymentOptions(async (url) =>
        url.includes('/health')
          ? jsonResponse(200, { status: 'ok' })
          : jsonResponse(200, {
              version: '0.9.7',
              oidc: { issuer: 'https://auth.dev.boxlite.ai/' },
              proxyTemplateUrl: 'https://proxy.dev.boxlite.ai/wrong-path',
            }),
      ),
    ),
    /Proxy template URL https:\/\/proxy\.dev\.boxlite\.ai\/wrong-path does not match expected/,
  )
})

test('rejects a public API config from a stale release', async () => {
  await assert.rejects(
    verifyPublicDeployment(
      publicDeploymentOptions(async (url) =>
        url.includes('/health')
          ? jsonResponse(200, { status: 'ok' })
          : jsonResponse(200, {
              version: '0.9.6',
              oidc: { issuer: 'https://auth.dev.boxlite.ai/' },
              proxyTemplateUrl: 'https://proxy.dev.boxlite.ai',
            }),
      ),
    ),
    /API version 0\.9\.6 does not match expected 0\.9\.7/,
  )
})

test('verifies a public API config that does not advertise an image list', async () => {
  // /api/config has no supportedImages field and never has, so comparing one
  // against it failed every apply that set BOXLITE_SYSTEM_IMAGES. The images
  // below are what that variable used to resolve to; passing them must not
  // reintroduce an assertion on a field the API does not implement.
  const verification = await verifyPublicDeployment({
    ...publicDeploymentOptions(async (url) =>
      url.includes('/health')
        ? jsonResponse(200, { status: 'ok' })
        : jsonResponse(200, {
            version: '0.9.7',
            oidc: { issuer: 'https://auth.dev.boxlite.ai/' },
            proxyTemplateUrl: 'https://proxy.dev.boxlite.ai',
          }),
    ),
    expectedSupportedImages: [{ name: 'sandbaseai-hermes', ref: 'sam2026go/hermes-agent:boxlite-noexpose-20260726' }],
  })

  assert.equal(verification.version, '0.9.7')
})

test('retries public deployment probes a bounded number of times', async () => {
  let proxyAttempts = 0
  const retryDelays = []

  const result = await verifyPublicDeploymentWithRetry(
    publicDeploymentOptions(async (url) => {
      if (url === 'https://proxy.dev.boxlite.ai/health') {
        proxyAttempts += 1
        return proxyAttempts < 3 ? jsonResponse(503, { status: 'starting' }) : jsonResponse(200, { status: 'ok' })
      }
      if (url === 'https://deployment-probe.proxy.dev.boxlite.ai/health') {
        return jsonResponse(200, { status: 'ok' })
      }
      return jsonResponse(200, {
        version: '0.9.7',
        oidc: { issuer: 'https://auth.dev.boxlite.ai/' },
        proxyTemplateUrl: 'https://proxy.dev.boxlite.ai',
      })
    }),
    {
      attempts: 3,
      delayMs: 25,
      sleep(delayMs) {
        retryDelays.push(delayMs)
        return Promise.resolve()
      },
    },
  )

  assert.equal(result.proxyTemplateHost, 'proxy.dev.boxlite.ai')
  assert.equal(proxyAttempts, 3)
  assert.deepEqual(retryDelays, [25, 25])
})
