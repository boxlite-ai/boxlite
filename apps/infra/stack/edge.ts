// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

import type { ApiResources } from './api.js'
import type { ClickHouseResources } from './clickhouse.js'
import type { FoundationResources } from './foundation.js'
import { IMAGES, PORTS, envOr, httpHealth } from './settings.js'

type SelfHostedClickHouseResources = Extract<ClickHouseResources, { mode: 'self-hosted' }>

interface ClickStackGatewayInputs {
  clickHouse: SelfHostedClickHouseResources
  writerReady: any
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
  pgAdminPassword: random.RandomPassword
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
    pgAdminPassword,
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

  const gateway = new sst.aws.Service('ClickStackGateway', {
    cluster,
    wait: true,
    image: proxyImage,
    loadBalancer: {
      domain: clickStackGateway.domain,
      rules: [{ listen: '443/https', forward: `${PORTS.PROXY}/http` }],
      health: { [`${PORTS.PROXY}/http`]: httpHealth('/ready') },
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
    dependsOn: [clickStackGateway.clickHouse.ready, clickStackGateway.writerReady],
  })

  new command.local.Command(
    'ClickStackGatewayPublicReady',
    {
      dir: $cli.paths.root,
      create: 'node scripts/clickstack-gateway-smoke.mjs',
      update: 'node scripts/clickstack-gateway-smoke.mjs',
      environment: {
        CLICKSTACK_GATEWAY_URL: `https://${clickStackGateway.domain.name}/clickstack`,
        CLICKSTACK_OIDC_ISSUER: issuer.toString(),
        CLICKSTACK_OIDC_AUDIENCE: clickStackGateway.oidcAudience,
      },
      triggers: [
        gateway.nodes.taskDefinition.arn,
        clickStackGateway.domain.name,
        issuer.toString(),
        clickStackGateway.oidcAudience,
        'v1',
      ],
    },
    { dependsOn: [gateway] },
  )
}

// ─── 8. ADMIN UIs ────────────────────────────────────────────────────────
// pgAdmin security gate. pgAdmin is a Postgres admin console one hop from RDS
// and its listener is plain HTTP, so it must remain VPC-internal regardless of
// its login settings. Reach it through a private path such as SSM forwarding.
if (envOr('PGADMIN_PUBLIC', 'false') === 'true') {
  throw new Error(
    'PGADMIN_PUBLIC is not supported: pgAdmin serves plain HTTP, so public exposure ' +
      'would disclose credentials and session cookies. Reach it via VPN / bastion / ' +
      '`aws ssm start-session` instead.',
  )
}
const pgAdminServerMode = envOr('PGADMIN_CONFIG_SERVER_MODE', 'True')
const pgAdminMasterPassword = envOr('PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED', 'True')
new sst.aws.Service('PgAdmin', {
  cluster,
  image: IMAGES.pgadmin,
  loadBalancer: {
    // Reachable only from inside the VPC (VPN / bastion / SSM port-forward).
    public: false,
    rules: [{ listen: '80/http', forward: `${PORTS.PGADMIN}/http` }],
    health: { [`${PORTS.PGADMIN}/http`]: httpHealth('/', { successCodes: '200-399' }) },
  },
  environment: {
    PGADMIN_DEFAULT_EMAIL: envOr('PGADMIN_DEFAULT_EMAIL', 'admin@boxlite.dev'),
    PGADMIN_DEFAULT_PASSWORD: envOr('PGADMIN_DEFAULT_PASSWORD', pgAdminPassword.result),
    // Server mode enables the login screen (desktop mode skips auth
    // entirely); master password gates saved server credentials.
    PGADMIN_CONFIG_SERVER_MODE: pgAdminServerMode,
    PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED: pgAdminMasterPassword,
  },
  transform: {
    loadBalancer: (lbArgs: any) => { lbArgs.loadBalancerType = 'application' },
  },
})

// MailDev is an unauthenticated mail catcher with no first-class web auth, so it
// is VPC-internal only — reach it via VPN / bastion / `aws ssm start-session`.
// Anything it captures (password resets, magic links, invites) would otherwise be
// world-readable. MAILDEV_PUBLIC is rejected (fail loud) rather than silently
// honored: unlike pgAdmin there is no auth gate that would make public exposure safe.
if (envOr('MAILDEV_PUBLIC', 'false') === 'true') {
  throw new Error(
    'MAILDEV_PUBLIC is not supported: MailDev has no built-in auth, so it cannot be ' +
      'safely exposed to the internet. Reach it via VPN / bastion / `aws ssm start-session`.',
  )
}
new sst.aws.Service('MailDev', {
  cluster,
  image: IMAGES.maildev,
  loadBalancer: { public: false, rules: [{ listen: '80/http', forward: `${PORTS.MAILDEV_UI}/http` }] },
  transform: {
    loadBalancer: (lbArgs: any) => { lbArgs.loadBalancerType = 'application' },
  },
})

// ─── 9. CDN ROUTES ───────────────────────────────────────────────────────
// Router (declared in section 4) fronts the Api with HTTPS.
router.route('/', api.url)
}
