// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

import type { ApiResources } from './api.js'
import type { ClickHouseResources } from './clickhouse.js'
import type { FoundationResources } from './foundation.js'
import { PORTS, envOr, httpHealth } from './settings.js'

type ActiveClickHouseResources = Exclude<ClickHouseResources, { mode: 'disabled' }>

interface ClickStackGatewayInputs {
  clickHouse: ActiveClickHouseResources
  domain: { name: string; dns: ReturnType<typeof sst.cloudflare.dns> }
  oidcAudience: string
  oidcClientId: sst.Secret
  oidcClientSecret: sst.Secret
  oidcIssuer: string
  oidcRoleClaim: string
  oidcAllowedRoleValues: string
}

export interface EdgeInputs {
  foundation: FoundationResources
  api: ApiResources['api']
  router: sst.aws.Router
  proxyDomain: string
  proxyProtocol: string
  cloudflareDns: ReturnType<typeof sst.cloudflare.dns>
  proxyApiKey: random.RandomPassword
  oidcClientId: sst.Secret
  oidcIssuer: string
  publicOidcIssuer: string | undefined
  otelCollectorOtlpHttpUrl: $util.Output<string>
  stripTrailingSlash: (url: $util.Output<string>) => $util.Output<string>
  clickStackGateway?: ClickStackGatewayInputs
}

export function buildEdge(input: EdgeInputs): void {
  const {
    foundation: { cluster },
    api,
    router,
    proxyDomain,
    proxyProtocol,
    cloudflareDns,
    proxyApiKey,
    oidcClientId,
    oidcIssuer,
    publicOidcIssuer,
    otelCollectorOtlpHttpUrl,
    stripTrailingSlash,
    clickStackGateway,
  } = input

  const proxyImage = { context: '../..', dockerfile: 'apps/proxy/Dockerfile', cache: false }

// Proxy: routes `<port>-<boxid>.<proxyDomain>` to the box port.
// SST terminates TLS on the NLB listener and manages the proxy + wildcard
// Cloudflare records from the same env-driven domain exposed by the API.
// Protect the NLB topology so an immutable replacement fails instead of
// partially switching the listener to a target group that ECS has not
// attached. Routine task revisions continue to use ECS rolling deployments.

new sst.aws.Service('Proxy', {
  cluster,
  image: proxyImage,
  wait: true,
  loadBalancer: {
    domain: {
      name: proxyDomain,
      aliases: [`*.${proxyDomain}`],
      dns: cloudflareDns,
    },
    rules: [{ listen: '443/tls', forward: `${PORTS.PROXY}/tcp` }],
  },
  environment: {
    PROXY_PORT: String(PORTS.PROXY),
    PROXY_PROTOCOL: proxyProtocol,
    PROXY_API_KEY: envOr('PROXY_API_KEY', proxyApiKey.result),
    // api-client-go appends paths like "/config" directly → include /api suffix
    BOXLITE_API_URL: $interpolate`${stripTrailingSlash(api.url)}/api`,
    OIDC_CLIENT_ID: oidcClientId.value,
    OIDC_AUDIENCE: envOr('OIDC_AUDIENCE', 'boxlite'),
    OIDC_DOMAIN: oidcIssuer,
    ...(publicOidcIssuer && {
      OIDC_PUBLIC_DOMAIN: publicOidcIssuer,
    }),
    OTEL_LOGGING_ENABLED: envOr('OTEL_LOGGING_ENABLED', 'true'),
    OTEL_TRACING_ENABLED: envOr('OTEL_TRACING_ENABLED', 'true'),
    OTEL_EXPORTER_OTLP_ENDPOINT: envOr('OTEL_EXPORTER_OTLP_ENDPOINT', otelCollectorOtlpHttpUrl),
  },
  transform: {
    loadBalancer: (lbArgs: any, opts: any) => {
      lbArgs.loadBalancerType = 'network'
      opts.protect = true
    },
    listener: (_args: any, opts: any) => {
      opts.protect = true
    },
    target: (args: any, opts: any) => {
      args.healthCheck = {
        enabled: true,
        protocol: 'HTTP',
        path: '/health',
        port: 'traffic-port',
        matcher: '200-399',
        interval: 30,
        timeout: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 3,
      }
      opts.protect = true
    },
  },
})

if (clickStackGateway) {
  const issuer = new URL(clickStackGateway.oidcIssuer)
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new Error('CLICKSTACK_OIDC_ISSUER_BASE_URL must be a clean HTTPS URL')
  }

  new sst.aws.Service('ClickStackGateway', {
    cluster,
    wait: true,
    image: proxyImage,
    loadBalancer: {
      domain: clickStackGateway.domain,
      rules: [{ listen: '443/https', forward: `${PORTS.PROXY}/http` }],
      health: { [`${PORTS.PROXY}/http`]: httpHealth('/health') },
    },
    ssm: { CLICKSTACK_PASSWORD: clickStackGateway.clickHouse.readerSecretArn },
    environment: {
      PROXY_PORT: String(PORTS.PROXY),
      CLICKSTACK_UPSTREAM_URL: clickStackGateway.clickHouse.url,
      CLICKSTACK_USERNAME: 'otel_reader',
      CLICKSTACK_CREDENTIAL_VERSION: clickStackGateway.clickHouse.readerSecretVersionId,
      CLICKSTACK_OIDC_ISSUER: clickStackGateway.oidcIssuer,
      CLICKSTACK_OIDC_AUDIENCE: clickStackGateway.oidcAudience,
      CLICKSTACK_OIDC_ROLE_CLAIM: clickStackGateway.oidcRoleClaim,
      CLICKSTACK_OIDC_ALLOWED_ROLE_VALUES: clickStackGateway.oidcAllowedRoleValues,
    },
    transform: {
      loadBalancer: (lbArgs: any) => { lbArgs.loadBalancerType = 'application' },
      listener: (listenerArgs: any) => {
        const forwardActions = listenerArgs.defaultActions ?? []
        listenerArgs.defaultActions = [
          {
            type: 'authenticate-oidc',
            order: 1,
            authenticateOidc: {
              issuer: issuer.toString(),
              authorizationEndpoint: new URL('/authorize', issuer).toString(),
              tokenEndpoint: new URL('/oauth/token', issuer).toString(),
              userInfoEndpoint: new URL('/userinfo', issuer).toString(),
              clientId: clickStackGateway.oidcClientId.value,
              clientSecret: clickStackGateway.oidcClientSecret.value,
              scope: 'openid profile email boxlite-backoffice',
              authenticationRequestExtraParams: { audience: clickStackGateway.oidcAudience },
              sessionCookieName: 'BoxLiteClickStackSession',
              sessionTimeout: 3600,
              onUnauthenticatedRequest: 'authenticate',
            },
          },
          ...forwardActions.map((action: any, index: number) => ({ ...action, order: index + 2 })),
        ]
      },
    },
  }, {
    dependsOn: clickStackGateway.clickHouse.mode === 'self-hosted' ? [clickStackGateway.clickHouse.ready] : [],
  })
}
// ─── 9. CDN ROUTES ───────────────────────────────────────────────────────
// Router (declared in section 4) fronts the Api with HTTPS.
router.route('/', api.url)
}
