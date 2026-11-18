/** Public API and dashboard origin traffic must not reach unauthenticated internal routes. */
export function denyPublicInternalRoutes(albArn: $util.Input<string>): void {
  const acl = new aws.wafv2.WebAcl('ApiInternalRoutePolicy', {
    name: `boxlite-${$app.stage}-internal-routes`,
    scope: 'REGIONAL',
    defaultAction: { allow: {} },
    visibilityConfig: {
      cloudwatchMetricsEnabled: true,
      metricName: 'ApiInternalRoutes',
      sampledRequestsEnabled: false,
    },
    rules: [
      {
        name: 'DenyInternalRoutes',
        priority: 0,
        action: { block: {} },
        statement: {
          regexMatchStatement: {
            fieldToMatch: { uriPath: {} },
            regexString: '^(?:/api)?/internal(?:/|$)',
            textTransformations: [
              { priority: 0, type: 'URL_DECODE' },
              { priority: 1, type: 'LOWERCASE' },
            ],
          },
        },
        visibilityConfig: {
          cloudwatchMetricsEnabled: true,
          metricName: 'DenyInternalRoutes',
          sampledRequestsEnabled: false,
        },
      },
    ],
  })
  new aws.wafv2.WebAclAssociation('ApiInternalRoutePolicyAssociation', { resourceArn: albArn, webAclArn: acl.arn })
}
