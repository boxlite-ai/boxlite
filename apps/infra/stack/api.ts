// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

import { apiImageReference } from '../artifacts/api.js'
import { resolveArtifactSource } from '../artifacts/source.js'
import type { FoundationResources } from './foundation.js'
import {
  CLICKHOUSE_DATABASE,
  CLICKHOUSE_READER_USERNAME,
  type ClickHouseResources,
} from './clickhouse.js'
import { PORTS, envOr, httpHealth, requireEnv, runnerEndpoint } from './settings.js'

export interface ApiInputs {
  foundation: FoundationResources
  region: string
  accountId: string
  releaseVersion: string
  stackDomain: string
  proxyDomain: string
  proxyProtocol: string
  proxyTemplateUrl: string
  serviceDomain: (name: string) => { name: string; dns: ReturnType<typeof sst.cloudflare.dns> }
  s3AccessRoleName: string
  s3AccessRoleArn: $util.Output<string>
  encryptionKey: random.RandomPassword
  encryptionSalt: random.RandomPassword
  proxyApiKey: random.RandomPassword
  adminApiKey: random.RandomPassword
  defaultRunnerApiKey: random.RandomPassword
  defaultRunnerName: string
  oidcClientId: sst.Secret
  oidcMgmtClientId: sst.Secret
  oidcMgmtClientSecret: sst.Secret
  posthogApiKey: sst.Secret
  svixAuthToken: sst.Secret
  usageExportToken: sst.Secret
  oidcIssuer: string
  publicOidcIssuer: string | undefined
  otelCollectorOtlpHttpUrl: $util.Output<string>
  clickHouseResources: ClickHouseResources
  clickHouseReadyDependency?: any
}

export function buildApi(input: ApiInputs) {
  const {
    foundation: { cluster, db, redis, storage },
    region: REGION,
    accountId,
    releaseVersion,
    stackDomain,
    proxyDomain,
    proxyProtocol,
    proxyTemplateUrl,
    serviceDomain,
    s3AccessRoleName,
    s3AccessRoleArn,
    encryptionKey,
    encryptionSalt,
    proxyApiKey,
    adminApiKey,
    defaultRunnerApiKey,
    defaultRunnerName,
    oidcClientId,
    oidcMgmtClientId,
    oidcMgmtClientSecret,
    posthogApiKey,
    svixAuthToken,
    usageExportToken,
    oidcIssuer,
    publicOidcIssuer,
    otelCollectorOtlpHttpUrl,
    clickHouseResources,
    clickHouseReadyDependency,
  } = input

const apiArtifact = resolveArtifactSource('api')
const api = new sst.aws.Service('Api', {
  cluster,
  wait: true,
  image:
    apiArtifact.kind === 'release' || apiArtifact.ref
      ? apiImageReference({
          app: $app.name,
          stage: $app.stage,
          accountId,
          region: REGION,
          version: apiArtifact.version,
          ref: apiArtifact.kind === 'release' ? undefined : apiArtifact.ref,
        })
      : { context: '../..', dockerfile: 'apps/api/Dockerfile' },
  loadBalancer: {
    domain: serviceDomain('api'),
    rules: [{ listen: '443/https', forward: `${PORTS.API}/http` }],
    // Probe the NestJS health route explicitly. The ALB default ('/') doesn't
    // match the API (globally mounted under /api), so a default probe would fail
    // healthy tasks; /api/health is the same endpoint register-runners.mjs polls.
    health: { [`${PORTS.API}/http`]: httpHealth('/api/health') },
  },
  // AWS ALB default idle_timeout is 60s; per AWS docs (HTTP 408 troubleshooting),
  // raise to match expected WebSocket session length so SDK exec attaches survive
  // multi-minute idle pauses. SST doesn't surface this directly — use transform
  // to set the underlying aws.lb.LoadBalancer's idleTimeout attribute.
  // Paired with Node `keepAliveTimeout` in apps/api/src/main.ts (AWS HTTP 502
  // guidance: target keep-alive must be >= LB idle).
  transform: {
    loadBalancer: (lbArgs: any) => {
      lbArgs.loadBalancerType = 'application'
      lbArgs.idleTimeout = 3600
    },
  },
  // storage is deliberately NOT linked: the link grant is s3:* on the
  // bucket, far beyond the API's verified need (list-only — see the
  // s3:ListBucket statement below). Box object reads/writes flow through
  // vended S3AccessRole credentials, never the task role.
  link: [db, redis],
  permissions: [
    {
      // VolumeManager boot probe is list-only on the storage bucket.
      actions: ['s3:ListBucket'],
      resources: [storage.arn],
    },
    {
      // Vend per-org box storage credentials (object-storage.service.ts).
      actions: ['sts:AssumeRole'],
      resources: [s3AccessRoleArn],
    },
    {
      // VolumeManager's exact bucket-lifecycle surface (volume.manager.ts
      // create/tag, delete-s3-bucket.ts empty/delete). Deliberately NOT
      // s3:* — that tail (PutBucketPolicy/PutBucketAcl/…) is what would
      // let a compromised API expose volume buckets publicly. A new S3
      // call in code needs a matching action added here.
      actions: [
        's3:CreateBucket',
        's3:PutBucketTagging',
        's3:ListBucket',
        's3:ListBucketVersions',
        's3:DeleteObject',
        's3:DeleteObjectVersion',
        's3:DeleteBucket',
      ],
      resources: ['arn:aws:s3:::boxlite-volume-*', 'arn:aws:s3:::boxlite-volume-*/*'],
    },
  ],
  scaling: { min: 1, max: 4 },
  ssm: {
    ...(clickHouseResources.mode !== 'disabled'
      ? { CLICKHOUSE_PASSWORD: clickHouseResources.readerSecretArn }
      : {}),
  },
  environment: {
    // Core
    NODE_ENV: 'production',
    PORT: String(PORTS.API),
    ENVIRONMENT: 'production',
    RUN_MIGRATIONS: 'true',
    VERSION: releaseVersion,
    DEFAULT_REGION_ENFORCE_QUOTAS: 'false',
    DEFAULT_TEMPLATE: envOr('DEFAULT_TEMPLATE', 'boxlite/base'),
    // Box base images: the three *_IMAGE refs below are the built-in curated set the API
    // gates box creation to (apps/api curated-images.constant.ts); the runner pulls them
    // straight from ghcr.io, and these three are public so no GHCR_TOKEN is required.
    // BOXLITE_SYSTEM_IMAGES appends more images
    // (comma-separated `name=ref`) without a code deploy — empty means built-ins only.
    // IMAGE_TAG and the SOURCE_REGISTRY_* block are inert upstream-port residue (no consumer
    // — see apps/api configuration.ts), kept only as reserved names for a future registry path.
    BOXLITE_SYSTEM_IMAGE_TAG: envOr('BOXLITE_SYSTEM_IMAGE_TAG', 'v0.1.0'),
    BOXLITE_SYSTEM_BASE_IMAGE: envOr(
      'BOXLITE_SYSTEM_BASE_IMAGE',
      'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0',
    ),
    BOXLITE_SYSTEM_PYTHON_IMAGE: envOr(
      'BOXLITE_SYSTEM_PYTHON_IMAGE',
      'ghcr.io/boxlite-ai/boxlite-agent-python:v0.1.0',
    ),
    BOXLITE_SYSTEM_NODE_IMAGE: envOr(
      'BOXLITE_SYSTEM_NODE_IMAGE',
      'ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0',
    ),
    BOXLITE_SYSTEM_IMAGES: envOr('BOXLITE_SYSTEM_IMAGES', ''),
    ...(process.env.BOXLITE_SYSTEM_SOURCE_REGISTRY_URL && {
      BOXLITE_SYSTEM_SOURCE_REGISTRY_NAME: envOr(
        'BOXLITE_SYSTEM_SOURCE_REGISTRY_NAME',
        'BoxLite System Source Registry',
      ),
      BOXLITE_SYSTEM_SOURCE_REGISTRY_URL: process.env.BOXLITE_SYSTEM_SOURCE_REGISTRY_URL,
      BOXLITE_SYSTEM_SOURCE_REGISTRY_USERNAME: envOr('BOXLITE_SYSTEM_SOURCE_REGISTRY_USERNAME', ''),
      BOXLITE_SYSTEM_SOURCE_REGISTRY_PASSWORD: envOr('BOXLITE_SYSTEM_SOURCE_REGISTRY_PASSWORD', ''),
      BOXLITE_SYSTEM_SOURCE_REGISTRY_PROJECT_ID: envOr('BOXLITE_SYSTEM_SOURCE_REGISTRY_PROJECT_ID', ''),
    }),

    // Database (SST-linked)
    DB_HOST: db.host,
    DB_PORT: db.port.apply(String),
    DB_USERNAME: db.username,
    DB_PASSWORD: db.password,
    DB_DATABASE: db.database,

    // Redis (SST-linked, TLS + auth)
    REDIS_HOST: redis.host,
    REDIS_PORT: redis.port.apply(String),
    REDIS_PASSWORD: redis.password,
    REDIS_TLS: 'true',

    // Encryption
    ENCRYPTION_KEY: envOr('ENCRYPTION_KEY', encryptionKey.result),
    ENCRYPTION_SALT: envOr('ENCRYPTION_SALT', encryptionSalt.result),

    // OIDC — external provider (Auth0/Okta/etc.)
    OIDC_CLIENT_ID: oidcClientId.value,
    OIDC_AUDIENCE: envOr('OIDC_AUDIENCE', 'boxlite'),
    OIDC_ISSUER_BASE_URL: oidcIssuer,
    ...(publicOidcIssuer && {
      PUBLIC_OIDC_DOMAIN: publicOidcIssuer,
    }),
    SKIP_USER_EMAIL_VERIFICATION: envOr('SKIP_USER_EMAIL_VERIFICATION', 'false'),
    // Auth0 Management API. Required unless email verification is explicitly
    // skipped; also enables account linking and MFA enrollment.
    ...(process.env.OIDC_MANAGEMENT_API_ENABLED === 'true' && {
      OIDC_MANAGEMENT_API_ENABLED: 'true',
      ...(process.env.OIDC_MANAGEMENT_API_BASE_URL && {
        OIDC_MANAGEMENT_API_BASE_URL: process.env.OIDC_MANAGEMENT_API_BASE_URL,
      }),
      ...(process.env.OIDC_MANAGEMENT_API_TOKEN_URL && {
        OIDC_MANAGEMENT_API_TOKEN_URL: process.env.OIDC_MANAGEMENT_API_TOKEN_URL,
      }),
      ...(process.env.OIDC_MANAGEMENT_API_CUSTOM_DOMAIN && {
        OIDC_MANAGEMENT_API_CUSTOM_DOMAIN: process.env.OIDC_MANAGEMENT_API_CUSTOM_DOMAIN,
      }),
      // Client id/secret come from the SST secret store now. If the feature
      // is enabled but a secret is unset, the value resolves to '' and the
      // Api errors at runtime — instead of the old deploy-time requireEnv
      // throw (Output values can't be guarded at config-build time).
      OIDC_MANAGEMENT_API_CLIENT_ID: oidcMgmtClientId.value,
      OIDC_MANAGEMENT_API_CLIENT_SECRET: oidcMgmtClientSecret.value,
      OIDC_MANAGEMENT_API_AUDIENCE: requireEnv(
        'OIDC_MANAGEMENT_API_AUDIENCE',
        'when OIDC_MANAGEMENT_API_ENABLED=true',
      ),
    }),
    // RP-initiated logout fallback. Safe to set unconditionally: the API
    // probes the IdP's discovery doc at startup and only exposes this URL
    // to the dashboard when the IdP itself lacks end_session_endpoint
    // (e.g. Dex). For Auth0/Okta the API hides this and the SPA uses the
    // IdP's real endpoint advertised in /.well-known/openid-configuration.
    OIDC_END_SESSION_ENDPOINT: envOr('OIDC_END_SESSION_ENDPOINT', `https://${stackDomain}/api/auth/end-session`),
    ...(process.env.OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST && {
      OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST: process.env.OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST,
    }),

    // S3 (API mints STS creds for per-box buckets). No S3_ACCESS_KEY /
    // S3_SECRET_KEY: the API uses the SDK default chain (task role) and
    // assumes S3_ROLE_NAME for box-scoped credentials. Static keys remain
    // supported only for S3-compatible deployments (MinIO).
    S3_ENDPOINT: $interpolate`https://s3.${aws.getRegionOutput().name}.amazonaws.com`,
    S3_STS_ENDPOINT: $interpolate`https://sts.${aws.getRegionOutput().name}.amazonaws.com`,
    S3_REGION: REGION,
    S3_DEFAULT_BUCKET: storage.name,
    S3_ACCOUNT_ID: aws.getCallerIdentityOutput().accountId,
    S3_ROLE_NAME: s3AccessRoleName,

    // Where box-migration archives are keyed. Unset means the API's own
    // default namespace inside each runner's bucket; set it to
    // s3://<bucket>/<prefix> when the archive has to live in a bucket the
    // runners do not share.
    ...(process.env.BOX_MIGRATION_ARCHIVE_PREFIX && {
      BOX_MIGRATION_ARCHIVE_PREFIX: process.env.BOX_MIGRATION_ARCHIVE_PREFIX,
    }),

    // Proxy
    PROXY_DOMAIN: proxyDomain,
    PROXY_PROTOCOL: proxyProtocol,
    PROXY_API_KEY: envOr('PROXY_API_KEY', proxyApiKey.result),
    PROXY_TEMPLATE_URL: proxyTemplateUrl,

    // Admin
    ADMIN_API_KEY: envOr('ADMIN_API_KEY', adminApiKey.result),

    // Observability read/write path. These stay server-side; never expose
    // ClickHouse credentials to the dashboard bundle.
    OTEL_ENABLED: envOr('OTEL_ENABLED', 'true'),
    OTEL_EXPORTER_OTLP_ENDPOINT: envOr('OTEL_EXPORTER_OTLP_ENDPOINT', otelCollectorOtlpHttpUrl),
    ...(process.env.OTEL_EXPORTER_OTLP_HEADERS && {
      OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
    }),
    ...(clickHouseResources.mode !== 'disabled'
      ? {
          CLICKHOUSE_URL: clickHouseResources.url,
          CLICKHOUSE_DATABASE,
          CLICKHOUSE_USERNAME: CLICKHOUSE_READER_USERNAME,
          CLICKHOUSE_CREDENTIAL_VERSION: clickHouseResources.readerSecretVersionId,
        }
      : {}),
    BOX_OTEL_ENDPOINT_URL: envOr(
      'BOX_OTEL_ENDPOINT_URL',
      envOr('OTEL_EXPORTER_OTLP_ENDPOINT', otelCollectorOtlpHttpUrl),
    ),

    // Dashboard — point its API client at the direct `api.<stackDomain>`
    // ALB hostname so long-lived /attach WS, build-log SSE, and file
    // uploads bypass CloudFront (CF imposes a 10-min hard WS cap and a
    // 60s origin-read timeout that breaks streaming). Static SPA assets
    // (index.html + /assets/*) still serve through the CF Router at the
    // root domain. The API pins CORS to DASHBOARD_URL (apps/api main.ts),
    // so this cross-origin dashboard→API path is explicitly allowed.
    DASHBOARD_URL: envOr('DASHBOARD_URL', `https://${stackDomain}`),
    APP_URL: envOr('APP_URL', ''),
    DASHBOARD_BASE_API_URL: envOr('DASHBOARD_BASE_API_URL', `https://api.${stackDomain}`),

    // Default runner — the API auto-seeds it at boot; v2 runners self-report
    DEFAULT_RUNNER_NAME: defaultRunnerName,
    DEFAULT_RUNNER_API_KEY: envOr('DEFAULT_RUNNER_API_KEY', defaultRunnerApiKey.result),
    DEFAULT_RUNNER_DOMAIN: runnerEndpoint('DEFAULT_RUNNER_DOMAIN', PORTS.RUNNER, ''),
    DEFAULT_RUNNER_API_URL: runnerEndpoint('DEFAULT_RUNNER_API_URL', PORTS.RUNNER, 'http://'),
    DEFAULT_RUNNER_PROXY_URL: runnerEndpoint('DEFAULT_RUNNER_PROXY_URL', PORTS.PROXY, 'http://'),

    // PostHog (enables the dashboard's "Create Box" feature flag). Token is a
    // secret (empty = off); host stays plain config.
    POSTHOG_API_KEY: posthogApiKey.value,
    POSTHOG_HOST: envOr('POSTHOG_HOST', 'https://us.posthog.com'),

    // Svix (webhook delivery; empty token = off → dashboard logs cosmetic errors)
    SVIX_AUTH_TOKEN: svixAuthToken.value,
    ...(process.env.SVIX_SERVER_URL && { SVIX_SERVER_URL: process.env.SVIX_SERVER_URL }),

    // Where the dashboard's billing client calls, surfaced to it through
    // GET /api/config. No default: this stack deploys no billing service,
    // so without an explicit override the dashboard's billing surface —
    // the page itself (apps/dashboard/src/pages/Billing.tsx) and every
    // billing query hook, including the shell's wallet prefetch — stays
    // gated off and shows its placeholder instead.
    ...(process.env.BILLING_API_URL && {
      BILLING_API_URL: process.env.BILLING_API_URL,

      // Where finalized usage periods are shipped, from the outbox in
      // apps/api/src/usage/services/usage-export-publisher.service.ts.
      // The same signal and the same service as BILLING_API_URL, but
      // deliberately not the same value: the publisher appends
      // /internal/usage-events, which Commerce serves off its bare origin
      // because that route authenticates a service rather than a user and
      // so sits outside its /api/billing prefix. Sending BILLING_API_URL's
      // value here would 404 every batch — which is why this derives the
      // origin from it rather than taking a second setting that could be
      // pointed somewhere else.
      USAGE_EXPORT_URL: envOr('USAGE_EXPORT_URL', new URL(process.env.BILLING_API_URL).origin),
      USAGE_EXPORT_TOKEN: usageExportToken.value,
      // Derived from the credential rather than set outright, because
      // configuration.ts refuses to boot when export is on without a
      // token: a stage pointed at a billing service but never given the
      // shared secret would crash-loop on deploy instead of simply not
      // exporting yet. Setting the secret is what turns delivery on.
      USAGE_EXPORT_ENABLED: usageExportToken.value.apply((token: string) => (token.trim() ? 'true' : 'false')),
      // The same destination and credential carry the five-minute full
      // snapshot used by Commerce to estimate still-open usage.
      USAGE_ALLOCATION_SNAPSHOT_ENABLED: usageExportToken.value.apply((token: string) =>
        (token.trim() ? 'true' : 'false'),
      ),
    }),
  },
}, {
  dependsOn: clickHouseReadyDependency ? [clickHouseReadyDependency] : [],
})

// Assumed by the Api task role to vend per-org box storage credentials
// (see section 3). The permission set mirrors the session policy's action
// set in object-storage.service.ts, so the intersection that boxes
// receive is exactly the per-org prefix scope.
const s3AccessRole = new aws.iam.Role('S3AccessRole', {
  name: s3AccessRoleName,
  assumeRolePolicy: api.nodes.taskRole.arn.apply((taskRoleArn: any) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { AWS: taskRoleArn }, Action: 'sts:AssumeRole' }],
    }),
  ),
})
new aws.iam.RolePolicy('S3AccessRolePolicy', {
  role: s3AccessRole.name,
  policy: storage.arn.apply((bucketArn: any) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: [`${bucketArn}/*`] },
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [bucketArn] },
      ],
    }),
  ),
})


  return { api }
}

export type ApiResources = ReturnType<typeof buildApi>
