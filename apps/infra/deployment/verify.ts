// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { runAwsJson } from '../shared/exec.js'

const PROXY_SERVICE_NAME = 'Proxy'
const PROXY_CONTAINER_PORT = 4000
const PROXY_LISTENER_PORT = 443

function exactlyOne(values: any, label: any) {
  if (!Array.isArray(values) || values.length !== 1) {
    throw new Error(`${label}: expected exactly one, found ${values?.length ?? 0}`)
  }
  return values[0]
}

function activeListenerTargetGroups(listener: any) {
  const targetGroupArns = new Set()

  for (const action of listener.DefaultActions ?? []) {
    if (action.Type !== 'forward') continue

    const configuredGroups = action.ForwardConfig?.TargetGroups ?? []
    for (const group of configuredGroups) {
      if ((group.Weight ?? 1) > 0 && group.TargetGroupArn) {
        targetGroupArns.add(group.TargetGroupArn)
      }
    }

    if (configuredGroups.length === 0 && action.TargetGroupArn) {
      targetGroupArns.add(action.TargetGroupArn)
    }
  }

  return [...targetGroupArns]
}

export function verifyProxyDeployment({ app, stage, region, awsJson }: any) {
  if (!app?.trim()) throw new Error('Proxy verification requires an app name')
  if (!stage?.trim()) throw new Error('Proxy verification requires an SST stage')
  if (!region?.trim()) throw new Error('Proxy verification requires an AWS region')

  const queryAws = awsJson ?? ((args: any) => runAwsJson(args, { region }))
  const taggedClusters = queryAws([
    'resourcegroupstaggingapi',
    'get-resources',
    '--resource-type-filters',
    'ecs:cluster',
    '--tag-filters',
    `Key=sst:app,Values=${app}`,
    `Key=sst:stage,Values=${stage}`,
  ])
  const clusterArn = exactlyOne(
    taggedClusters.ResourceTagMappingList?.map((resource: any) => resource.ResourceARN),
    `ECS cluster tagged sst:app=${app}, sst:stage=${stage}`,
  )

  const describedServices = queryAws([
    'ecs',
    'describe-services',
    '--cluster',
    clusterArn,
    '--services',
    PROXY_SERVICE_NAME,
  ])
  if (describedServices.failures?.length) {
    throw new Error(`Proxy ECS service lookup failed: ${JSON.stringify(describedServices.failures)}`)
  }
  const service = exactlyOne(describedServices.services, 'Proxy ECS service')
  if (service.status !== 'ACTIVE') {
    throw new Error(`Proxy ECS service is ${service.status ?? 'missing'}, expected ACTIVE`)
  }
  if (!Number.isInteger(service.desiredCount) || service.desiredCount < 1) {
    throw new Error(`Proxy ECS service desired count is ${service.desiredCount ?? 'missing'}, expected at least 1`)
  }
  if (!Number.isInteger(service.runningCount) || service.runningCount < 0) {
    throw new Error(
      `Proxy ECS service running task count is ${service.runningCount ?? 'missing'}, expected a non-negative integer`,
    )
  }
  if (service.runningCount < service.desiredCount) {
    throw new Error(`Proxy ECS service has ${service.runningCount} running tasks; expected ${service.desiredCount}`)
  }

  const serviceLoadBalancer = exactlyOne(service.loadBalancers, 'Proxy ECS load-balancer attachment')
  if (
    serviceLoadBalancer.containerName !== PROXY_SERVICE_NAME ||
    serviceLoadBalancer.containerPort !== PROXY_CONTAINER_PORT
  ) {
    throw new Error(
      `Proxy ECS load-balancer attachment points to ${serviceLoadBalancer.containerName}:` +
        `${serviceLoadBalancer.containerPort}, expected ${PROXY_SERVICE_NAME}:${PROXY_CONTAINER_PORT}`,
    )
  }
  const targetGroupArn = serviceLoadBalancer.targetGroupArn
  if (!targetGroupArn) throw new Error('Proxy ECS load-balancer attachment has no target group ARN')

  const taggedLoadBalancers = queryAws([
    'resourcegroupstaggingapi',
    'get-resources',
    '--resource-type-filters',
    'elasticloadbalancing:loadbalancer',
    '--tag-filters',
    `Key=sst:app,Values=${app}`,
    `Key=sst:stage,Values=${stage}`,
  ])
  const taggedNetworkLoadBalancerArns = (taggedLoadBalancers.ResourceTagMappingList ?? [])
    .map((resource: any) => resource.ResourceARN)
    .filter((resourceArn: any) => resourceArn.includes(':loadbalancer/net/'))
  const tlsListeners = taggedNetworkLoadBalancerArns.flatMap((loadBalancerArn: any) => {
    const describedListeners = queryAws(['elbv2', 'describe-listeners', '--load-balancer-arn', loadBalancerArn])
    return (describedListeners.Listeners ?? [])
      .filter((candidate: any) => candidate.Port === PROXY_LISTENER_PORT && candidate.Protocol === 'TLS')
      .map((listener: any) => ({ listener, loadBalancerArn }))
  })
  const { listener, loadBalancerArn } = exactlyOne(tlsListeners, `SST-tagged Proxy TLS:${PROXY_LISTENER_PORT} listener`)
  const listenerTargetGroupArn = exactlyOne(
    activeListenerTargetGroups(listener),
    `Proxy TLS:${PROXY_LISTENER_PORT} active listener target group`,
  )
  if (listenerTargetGroupArn !== targetGroupArn) {
    throw new Error(
      `Proxy listener target group ${listenerTargetGroupArn} does not match the Proxy ECS target group ${targetGroupArn}`,
    )
  }

  const describedTargetGroups = queryAws(['elbv2', 'describe-target-groups', '--target-group-arns', targetGroupArn])
  const targetGroup = exactlyOne(describedTargetGroups.TargetGroups, 'Proxy target group')
  if (targetGroup.Port !== PROXY_CONTAINER_PORT || targetGroup.Protocol !== 'TCP' || targetGroup.TargetType !== 'ip') {
    throw new Error(
      `Proxy target group is ${targetGroup.Protocol}:${targetGroup.Port}/${targetGroup.TargetType}; ` +
        `expected TCP:${PROXY_CONTAINER_PORT}/ip`,
    )
  }
  if (targetGroup.HealthCheckProtocol !== 'HTTP' || targetGroup.HealthCheckPath !== '/health') {
    throw new Error(
      `Proxy target-group health check is ${targetGroup.HealthCheckProtocol ?? 'missing'}:` +
        `${targetGroup.HealthCheckPath ?? 'missing'}, expected HTTP:/health`,
    )
  }
  if (!(targetGroup.LoadBalancerArns ?? []).includes(loadBalancerArn)) {
    throw new Error(
      `Proxy target group ${targetGroupArn} is not attached to the SST-tagged load balancer ${loadBalancerArn}`,
    )
  }

  const describedTargetHealth = queryAws(['elbv2', 'describe-target-health', '--target-group-arn', targetGroupArn])
  const healthyTargetCount = (describedTargetHealth.TargetHealthDescriptions ?? []).filter(
    (target: any) => target.TargetHealth?.State === 'healthy',
  ).length
  if (healthyTargetCount < service.desiredCount) {
    throw new Error(
      `Proxy target group has ${healthyTargetCount} healthy target${healthyTargetCount === 1 ? '' : 's'}; ` +
        `expected at least ${service.desiredCount}`,
    )
  }

  return {
    clusterArn,
    serviceArn: service.serviceArn,
    listenerArn: listener.ListenerArn,
    targetGroupArn,
    desiredCount: service.desiredCount,
    healthyTargetCount,
  }
}

function parseAbsoluteHttpsUrl(value: any, label: any) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid absolute HTTPS URL`)
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`)
  if (url.username || url.password) throw new Error(`${label} must not include credentials`)
  if (url.search || url.hash) throw new Error(`${label} must not include a query string or fragment`)
  return url
}

async function fetchJson(fetchImpl: any, url: any, label: any, requestTimeoutMs: any) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)

  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response?.ok) {
      throw new Error(`${label} returned HTTP ${response?.status ?? 'unknown'}`)
    }
    try {
      return await response.json()
    } catch (error) {
      throw new Error(`${label} returned invalid JSON`, { cause: error })
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${requestTimeoutMs}ms`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function verifyPublicDeployment({
  proxyHealthUrl,
  proxyWildcardHealthUrl,
  apiConfigUrl,
  expectedOidcIssuer,
  expectedProxyTemplateUrl,
  expectedVersion,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 15_000,
}: any) {
  if (typeof fetchImpl !== 'function') throw new Error('Public deployment verification requires fetch')
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error(`Public deployment request timeout must be positive, received ${requestTimeoutMs}`)
  }

  const proxyHealthEndpoint = parseAbsoluteHttpsUrl(proxyHealthUrl, 'Proxy health URL')
  const proxyWildcardHealth = parseAbsoluteHttpsUrl(proxyWildcardHealthUrl, 'Proxy wildcard health URL')
  if (proxyWildcardHealth.hostname !== `deployment-probe.${proxyHealthEndpoint.hostname}`) {
    throw new Error(
      `Proxy wildcard health host ${proxyWildcardHealth.hostname} does not match ` +
        `deployment-probe.${proxyHealthEndpoint.hostname}`,
    )
  }
  parseAbsoluteHttpsUrl(apiConfigUrl, 'API config URL')
  parseAbsoluteHttpsUrl(expectedOidcIssuer, 'Expected OIDC issuer')
  const expectedProxyTemplate = parseAbsoluteHttpsUrl(expectedProxyTemplateUrl, 'Expected Proxy template URL')
  if (typeof expectedVersion !== 'string' || expectedVersion.trim() === '') {
    throw new Error('Expected API version is required')
  }

  const proxyHealth = await fetchJson(fetchImpl, proxyHealthUrl, 'Public Proxy health check', requestTimeoutMs)
  if (proxyHealth?.status !== 'ok') {
    throw new Error(`Public Proxy health check returned status ${JSON.stringify(proxyHealth?.status ?? null)}`)
  }

  const proxyWildcardHealthResponse = await fetchJson(
    fetchImpl,
    proxyWildcardHealthUrl,
    'Public Proxy wildcard health check',
    requestTimeoutMs,
  )
  if (proxyWildcardHealthResponse?.status !== 'ok') {
    throw new Error(
      `Public Proxy wildcard health check returned status ` +
        `${JSON.stringify(proxyWildcardHealthResponse?.status ?? null)}`,
    )
  }

  const apiConfig = await fetchJson(fetchImpl, apiConfigUrl, 'Public API config check', requestTimeoutMs)
  const actualOidcIssuer = apiConfig?.oidc?.issuer
  if (typeof actualOidcIssuer !== 'string') {
    throw new Error(`Public API OIDC issuer ${JSON.stringify(actualOidcIssuer ?? null)} is missing`)
  }
  parseAbsoluteHttpsUrl(actualOidcIssuer, 'Public API OIDC issuer')
  if (actualOidcIssuer !== expectedOidcIssuer) {
    throw new Error(`Public API OIDC issuer ${actualOidcIssuer} does not match expected ${expectedOidcIssuer}`)
  }

  const actualProxyTemplate = parseAbsoluteHttpsUrl(apiConfig?.proxyTemplateUrl, 'Public API Proxy template URL')
  if (actualProxyTemplate.host !== expectedProxyTemplate.host) {
    throw new Error(
      `Public API Proxy template host ${actualProxyTemplate.host} does not match ${expectedProxyTemplate.host}`,
    )
  }
  if (actualProxyTemplate.href !== expectedProxyTemplate.href) {
    throw new Error(
      `Public API Proxy template URL ${actualProxyTemplate.href} does not match expected ${expectedProxyTemplate.href}`,
    )
  }

  const actualVersion = apiConfig?.version
  if (actualVersion !== expectedVersion) {
    throw new Error(`Public API version ${actualVersion ?? 'missing'} does not match expected ${expectedVersion}`)
  }

  return {
    proxyHealthUrl,
    proxyWildcardHealthUrl,
    apiConfigUrl,
    oidcIssuer: actualOidcIssuer,
    proxyTemplateHost: actualProxyTemplate.host,
    version: actualVersion,
  }
}

function abortReason(signal: any) {
  return signal.reason instanceof Error ? signal.reason : new Error('Deployment verification interrupted')
}

function wait(delayMs: any, signal: any) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs))
  if (signal.aborted) return Promise.reject(abortReason(signal))

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function verifyWithRetry(options: any, retryOptions: any, defaultVerify: any) {
  const {
    attempts = 7,
    delayMs = 10_000,
    verify = defaultVerify,
    sleep = wait,
    onRetry = () => {},
    signal,
  } = retryOptions
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`Deployment verification retry attempts must be a positive integer, received ${attempts}`)
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`Deployment verification retry delay must be non-negative, received ${delayMs}`)
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw abortReason(signal)
    try {
      return await verify(options)
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal)
      if (attempt === attempts) throw error
      onRetry({ error, attempt, nextAttempt: attempt + 1, attempts, delayMs })
      await sleep(delayMs, signal)
    }
  }

  throw new Error('Deployment verification exhausted its retry loop')
}

export async function verifyProxyDeploymentWithRetry(options: any, retryOptions = {}) {
  return verifyWithRetry(options, retryOptions, verifyProxyDeployment)
}

export async function verifyPublicDeploymentWithRetry(options: any, retryOptions = {}) {
  return verifyWithRetry(options, retryOptions, verifyPublicDeployment)
}
