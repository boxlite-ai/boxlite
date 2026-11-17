import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { denyPublicInternalRoutes } from '../stack/providers/aws/internal-route-policy.ts'

test('AWS public ALB policy blocks decoded internal paths without sampling credentials', () => {
  const resources: { name: string; args: any }[] = []
  const previous = (globalThis as any).aws
  class Resource {
    arn = 'policy-arn'
    constructor(name: string, args: any) {
      resources.push({ name, args })
    }
  }
  try {
    ;(globalThis as any).aws = { wafv2: { WebAcl: Resource, WebAclAssociation: Resource } }
    denyPublicInternalRoutes('public-alb')
    const policy = resources[0].args
    assert.equal(policy.scope, 'REGIONAL')
    assert.deepEqual(policy.defaultAction, { allow: {} })
    const rule = policy.rules[0]
    assert.deepEqual(rule.action, { block: {} })
    assert.deepEqual(rule.statement.byteMatchStatement, {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'CONTAINS',
      searchString: '/internal/',
      textTransformations: [
        { priority: 0, type: 'URL_DECODE' },
        { priority: 1, type: 'LOWERCASE' },
      ],
    })
    assert.equal(rule.visibilityConfig.sampledRequestsEnabled, false)
    assert.deepEqual(resources[1].args, { resourceArn: 'public-alb', webAclArn: 'policy-arn' })
  } finally {
    ;(globalThis as any).aws = previous
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
  assert.match(gcp, /request.path.urlDecode\(\).lower\(\).contains\('\/internal\/'\)/)
  assert.match(gcp, /fullPathMatch: '\/internal\/v1\/credentials\/introspect'/)
  assert.match(gcp, /ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER'/)
  assert.match(source('../stack/providers/aws/api.ts'), /denyPublicInternalRoutes\(service.nodes.loadBalancer.arn\)/)
  assert.match(source('../../stack/api.ts'), /denyPublicInternalRoutes\(api.nodes.loadBalancer.arn\)/)
})
