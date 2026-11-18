import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { denyPublicInternalRoutes } from '../stack/providers/aws/internal-route-policy.ts'

test('AWS public ALB policy blocks decoded internal paths without sampling credentials', () => {
  const resources: { name: string; args: any }[] = []
  const previous = (globalThis as any).aws
  const previousApp = (globalThis as any).$app
  class Resource {
    arn = 'policy-arn'
    constructor(name: string, args: any) {
      resources.push({ name, args })
    }
  }
  try {
    ;(globalThis as any).aws = { wafv2: { WebAcl: Resource, WebAclAssociation: Resource } }
    ;(globalThis as any).$app = { stage: 'dev' }
    denyPublicInternalRoutes('public-alb')
    const policy = resources[0].args
    assert.equal(policy.scope, 'REGIONAL')
    assert.deepEqual(policy.defaultAction, { allow: {} })
    const rule = policy.rules[0]
    assert.deepEqual(rule.action, { block: {} })
    const match = rule.statement.regexMatchStatement
    assert.ok(match)
    assert.deepEqual(match.fieldToMatch, { uriPath: {} })
    assert.deepEqual(match.textTransformations, [
      { priority: 0, type: 'URL_DECODE' },
      { priority: 1, type: 'LOWERCASE' },
    ])
    for (const [path, denied] of [
      ['/internal/v1/credentials/introspect', true],
      ['/api/INTERNAL/v1/credentials/introspect', true],
      ['/api/%69nternal/v1/credentials/introspect', true],
      ['/internal', true],
      ['/api/internal', true],
      ['/api/v1/boxes/internal/start', false],
      ['/api/internal-box', false],
    ] as const) {
      const normalized = decodeURIComponent(path).toLowerCase()
      const blocked = new RegExp(match.regexString).test(normalized)
      assert.equal(blocked, denied, path)
    }
    assert.equal(policy.name, 'boxlite-dev-internal-routes')
    assert.equal(rule.visibilityConfig.sampledRequestsEnabled, false)
    assert.deepEqual(resources[1].args, { resourceArn: 'public-alb', webAclArn: 'policy-arn' })
  } finally {
    ;(globalThis as any).aws = previous
    ;(globalThis as any).$app = previousApp
  }
})

test('ingress policies attach to public backends while GCP internal routing preserves the root endpoint', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const gcp = source('../stack/providers/gcp/api.ts')
  const external = gcp.slice(
    gcp.indexOf("new gcp.compute.BackendService('ApiBackend'"),
    gcp.indexOf("new gcp.compute.URLMap('ApiUrlMap'"),
  )
  assert.match(external, /securityPolicy: internalRoutePolicy.id/)
  const internal = gcp.slice(
    gcp.indexOf("new gcp.compute.RegionBackendService('ApiInternalBackend'"),
    gcp.indexOf("new gcp.compute.RegionUrlMap('ApiInternalUrlMap'"),
  )
  assert.doesNotMatch(internal, /securityPolicy/)
  const expression = gcp.match(
    /expression: "(request.path.urlDecode\(\).lower\(\)\.matches\('[^']+'\))"/,
  )?.[1]
  assert.ok(expression)
  const argument = expression.match(/\('([^']+)'\)/)![1]
  for (const [path, denied] of [
    ['/internal/v1/credentials/introspect', true],
    ['/api/%69NTERNAL/v1/credentials/introspect', true],
    ['/internal', true],
    ['/api/internal', true],
    ['/api/v1/boxes/internal/start', false],
    ['/api/internal-box', false],
  ] as const) {
    const normalized = decodeURIComponent(path).toLowerCase()
    assert.equal(new RegExp(argument).test(normalized), denied, path)
  }
  assert.match(gcp, /fullPathMatch: '\/internal\/v1\/credentials\/introspect'/)
  assert.match(gcp, /ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER'/)
  assert.match(source('../stack/providers/aws/api.ts'), /denyPublicInternalRoutes\(service.nodes.loadBalancer.arn\)/)
  assert.match(source('../../stack/api.ts'), /denyPublicInternalRoutes\(api.nodes.loadBalancer.arn\)/)
})
