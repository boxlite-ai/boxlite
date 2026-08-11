// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// Modified and rebranded for BoxLite

/// <reference path="./.sst/platform/config.d.ts" />

// ─────────────────────────────────────────────────────────────────────────────
// BoxLite control plane on AWS (AWS_REGION, default ap-southeast-1).
//
// Top of file: constants + helpers + the runner user-data builder.
// Inside `run()`, resources are created in deploy order:
//
//   1. secrets (auto-generated)     6. API
//   2. platform (VPC/DB/Redis/S3)   7. edge services (Proxy)
//   3. IAM                          8. admin UIs (PgAdmin/MailDev)
//   4. auth (external OIDC)         9. CDN (CloudFront)
//   5. observability               10. runner (EC2 + nested KVM)
// ─────────────────────────────────────────────────────────────────────────────

// The one stage that holds real user data. Both the `removal` policy and the
// RDS deletion-protection/final-snapshot guards key off this exact name, so it
// lives in one place rather than being spelled out at each use — a mismatch
// between the two silently leaves the real stack unprotected.
const PRODUCTION_STAGE = 'prod'

// Container ports each service listens on internally
const PORTS = {
  API: 3000,
  PROXY: 4000,
  RUNNER: 3003,
  JAEGER_UI: 16686,
  OTLP_HTTP: 4318,
  OTEL_HEALTH: 13133,
  MAILDEV_UI: 1080,
  PGADMIN: 80,
} as const

// Pinned third-party images
const IMAGES = {
  jaeger: 'jaegertracing/all-in-one:1.67.0',
  pgadmin: 'dpage/pgadmin4:9.2.0',
  maildev: 'maildev/maildev:2.2.1',
} as const

// Runner EC2 sizing
const RUNNER = {
  instanceType: 'c8i.2xlarge',
  rootDiskGB: 100,
  ubuntuOwnerId: '099720109477',
  ubuntuNamePattern: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
} as const

// ALB target-group health check defaults
const HEALTH_DEFAULTS = {
  interval: '30 seconds',
  timeout: '5 seconds',
  healthyThreshold: 2,
  unhealthyThreshold: 3,
} as const

// ── helpers ──────────────────────────────────────────────────────────────────

// Env var with fallback. Empty string also falls through.
const envOr = <T>(key: string, fallback: T) => process.env[key] || fallback

// HTTP health check with defaults + optional overrides.
const httpHealth = (path: string, overrides: Partial<{ successCodes: string }> = {}) => ({
  path,
  ...HEALTH_DEFAULTS,
  ...overrides,
})

// Required env var, with the reason it's needed (for vars that become mandatory
// only under a feature flag). Throws a clear error at deploy time instead of
// silently shipping the TS non-null assertion's `undefined` into the container.
const requireEnv = (key: string, why: string) => {
  const v = process.env[key]
  if (!v) throw new Error(`${key} is required ${why}`)
  return v
}

// Runner endpoint default — localhost. v2 runners self-report their address via
// healthcheck, so the DEFAULT_RUNNER_* override is rarely needed.
const runnerEndpoint = (override: string, port: number, scheme: string) => envOr(override, `${scheme}localhost:${port}`)

// ── app config ───────────────────────────────────────────────────────────────
export default $config({
  async app(input) {
    const { resolveAwsRegion } = await import('./scripts/deployment-environment.mjs')
    const { resolveCloudflareProviderRegistration } = await import(
      './scripts/cloudflare-provider-registration.mjs'
    )
    const REGION = resolveAwsRegion()
    const cloudflareProviderRegistration = resolveCloudflareProviderRegistration(process.env)

    return {
      name: 'boxlite',
      removal: input?.stage === PRODUCTION_STAGE ? 'retain' : 'remove',
      home: 'aws',
      providers: {
        aws: {
          version: '7.24.0',
          region: REGION,
          ...(process.env.AWS_PROFILE ? { profile: process.env.AWS_PROFILE } : {}),
        },
        ...cloudflareProviderRegistration,
        random: '4.16.6',
        // command provider: multi-runner post-deploy registration
        // (see RegisterExtraRunners in run()).
        command: '1.0.1',
      },
    }
  },

  async run() {
    const { readWorkspaceVersion, resolveAwsRegion, resolvePublicDeploymentConfig } =
      await import('./scripts/deployment-environment.mjs')
    const { optionalPublicOidcIssuer, requireOidcIssuer } = await import('./scripts/oidc-issuer.mjs')
    const {
      RUNNER_ROLE_TAG,
      RUNNER_ROLE_VALUE,
      RUNNER_STAGE_TAG,
      extraRunnerInstanceProfileName,
      resolveRunnerInventory,
    } = (
      await import('./scripts/runner-inventory.cjs')
    ).default
    const { parseRunnerStateBaseline } = (await import('./scripts/runner-state-baseline.cjs')).default
    const { requireIamPermissionsBoundaryStage } = await import('./scripts/sst-stage.mjs')
    const { apiImageReference } = await import('./scripts/api-artifact.mjs')
    const { resolveArtifactSource } = await import('./scripts/artifact-source.mjs')
    const { readDeployScope } = await import('./scripts/deployment-scope.mjs')
    const { resolveRunnerArtifact, runnerArtifactsBucketName } = await import('./scripts/runner-artifact.mjs')
    const {
      RUNTIME_SECRET_DEFINITIONS,
      parseRuntimeSecretGenerations,
      runtimeSecretGeneration,
      runtimeSecretGenerationMarker,
      runtimeSecretName,
      runtimeSecretNeedsGeneratedInitialVersion,
    } = await import('./scripts/runtime-secrets.mjs')
    const { RuntimeSecretEcsBindings } = await import('./scripts/runtime-secret-ecs-bindings.mjs')
    const REGION = resolveAwsRegion()
    const { accountId } = await aws.getCallerIdentity()
    const workspaceVersion = readWorkspaceVersion()
    const deploymentConfig = resolvePublicDeploymentConfig(process.env, workspaceVersion)
    const { stackDomain, proxyDomain, proxyProtocol, proxyTemplateUrl, releaseVersion } = deploymentConfig
    const runnerInventory = resolveRunnerInventory(process.env)
    const runnerStateBaseline = parseRunnerStateBaseline(process.env.BOXLITE_RUNNER_STATE_BASELINE)
    if (runnerStateBaseline.stage !== $app.stage) {
      throw new Error('Runner state baseline stage does not match the selected SST stage')
    }
    const defaultRunnerInstanceId = runnerStateBaseline.resources.Runner?.instanceId
    if (!defaultRunnerInstanceId) {
      throw new Error('Runner state baseline must include the protected default Runner')
    }
    const defaultRunnerSourceArn = `arn:aws:ec2:${REGION}:${accountId}:instance/${defaultRunnerInstanceId}`
    const oidcIssuer = requireOidcIssuer()
    const publicOidcIssuer = optionalPublicOidcIssuer()

    // Every role created by this stack must stay inside the boundary provisioned
    // with the GitHub deployment role. The raw-resource transform also covers IAM
    // roles created internally by SST components, not only the roles declared here.
    requireIamPermissionsBoundaryStage($app.stage)
    const runtimePermissionsBoundaryArn = $interpolate`arn:aws:iam::${aws.getCallerIdentityOutput().accountId}:policy/${$app.name}-${$app.stage}-runtime-boundary`
    $transform(aws.iam.Role, (args) => {
      args.permissionsBoundary ??= runtimePermissionsBoundaryArn
    })

    // Strip trailing slash from service.url so path concat produces clean URLs
    // (api.url = "https://api.dev.boxlite.ai/" → apiBase = "https://api.dev.boxlite.ai").
    const stripTrailingSlash = (url: $util.Output<string>) => url.apply((u) => (u.endsWith('/') ? u.slice(0, -1) : u))

    const clickHouseWriterEndpoint =
      process.env.CLICKHOUSE_WRITER_ENDPOINT || process.env.CLICKHOUSE_ENDPOINT || process.env.CLICKHOUSE_OTEL_ENDPOINT
    const clickHouseReaderUrl = process.env.CLICKHOUSE_READER_URL || process.env.CLICKHOUSE_URL
    const clickHouseReaderHost = process.env.CLICKHOUSE_READER_HOST || process.env.CLICKHOUSE_HOST
    const clickHouseExporterEnabled = process.env.CLICKHOUSE_EXPORTER_ENABLED === 'true'
    const ghcrUsername = process.env.GHCR_USERNAME?.trim() || ''
    const runtimeSecretGenerations = parseRuntimeSecretGenerations(
      process.env.BOXLITE_RUNTIME_SECRET_GENERATIONS,
    )
    const runtimeSecretGenerationMarkerFor = (component: string) =>
      runtimeSecretGenerationMarker(
        runtimeSecretGenerations,
        RUNTIME_SECRET_DEFINITIONS.filter(({ consumers }) =>
          consumers.some((consumer) => consumer.component === component),
        ).map(({ id }) => id),
      )
    if (clickHouseExporterEnabled && !clickHouseWriterEndpoint) {
      throw new Error(
        'CLICKHOUSE_WRITER_ENDPOINT or CLICKHOUSE_ENDPOINT is required when CLICKHOUSE_EXPORTER_ENABLED=true',
      )
    }
    const collectorExporters = clickHouseExporterEnabled ? '[boxlite_exporter,clickhouse]' : '[boxlite_exporter]'
    // Traces additionally fan out to Jaeger; metrics/logs stay off it (Jaeger
    // ingests traces only).
    const collectorTraceExporters = clickHouseExporterEnabled
      ? '[boxlite_exporter,clickhouse,otlphttp/jaeger]'
      : '[boxlite_exporter,otlphttp/jaeger]'

    // HTTPS everywhere: the Router CloudFront Function deletes customOriginConfig
    // for http origins and CF then falls back to match-viewer (→ tries HTTPS on a
    // port-80-only ALB → 502). We side-step that by giving Api and Dex ALBs
    // HTTPS listeners with a wildcard ACM cert, so Router routes to https://
    // origins and the non-buggy branch runs.
    const cloudflareDns = sst.cloudflare.dns()
    const serviceDomain = (name: string) => ({
      name: `${name}.${stackDomain}`,
      dns: cloudflareDns,
    })

    // ─── 1. SECRETS ──────────────────────────────────────────────────────────
    // Auto-generated — override any one by setting the matching env var.
    const randomKey = (name: string, length = 32) => new random.RandomPassword(name, { length, special: false })

    const encryptionKey = randomKey('EncryptionKey', 64)
    const encryptionSalt = randomKey('EncryptionSalt', 32)
    const proxyApiKey = randomKey('ProxyApiKey')
    const adminApiKey = randomKey('AdminApiKey')
    const defaultRunnerApiKey = randomKey('DefaultRunnerApiKey')
    const defaultRunnerConfig = runnerInventory[0]
    const defaultRunnerName = defaultRunnerConfig.controlPlaneRunnerName
    const pgAdminPassword = randomKey('PgAdminPassword', 24)

    // Bootstrap owns the stable stage-named containers. During the expand deploy,
    // the legacy configuration handoff still resolves these expressions to exactly
    // the values today's task definitions and default Runner use; generated values
    // come from the retained RandomPassword resources. ignoreChanges then lets
    // later bootstrap/operator rotations remain authoritative rather than being
    // reverted by a routine software deploy.
    // Secrets Manager rejects an empty SecretString, so disabled optional paths
    // use explicit harmless values instead of an ambiguous whitespace sentinel.
    const runtimeSecretInitialValues: Record<string, $util.Input<string>> = {
      encryptionKey: envOr('ENCRYPTION_KEY', encryptionKey.result),
      encryptionSalt: envOr('ENCRYPTION_SALT', encryptionSalt.result),
      adminApiKey: envOr('ADMIN_API_KEY', adminApiKey.result),
      proxyApiKey: envOr('PROXY_API_KEY', proxyApiKey.result),
      defaultRunnerApiKey: envOr('DEFAULT_RUNNER_API_KEY', defaultRunnerApiKey.result),
      pgAdminDefaultPassword: envOr('PGADMIN_DEFAULT_PASSWORD', pgAdminPassword.result),
      ghcrPullToken: process.env.GHCR_TOKEN?.trim() || 'unused',
      clickHouseWriterPassword:
        process.env.CLICKHOUSE_WRITER_PASSWORD?.trim() || process.env.CLICKHOUSE_PASSWORD?.trim() || 'unused',
      clickHouseReaderPassword:
        process.env.CLICKHOUSE_READER_PASSWORD?.trim() || process.env.CLICKHOUSE_PASSWORD?.trim() || 'unused',
      otelExporterOtlpHeaders:
        process.env.OTEL_EXPORTER_OTLP_HEADERS?.trim() || 'x-boxlite-unconfigured=true',
      otelCollectorApiKey: envOr(
        'BOXLITE_API_KEY',
        envOr('OTEL_COLLECTOR_API_KEY', envOr('ADMIN_API_KEY', adminApiKey.result)),
      ),
    }
    const runtimeSecrets = Object.fromEntries(
      await Promise.all(
        RUNTIME_SECRET_DEFINITIONS.map(async ({ id }) => [
          id,
          await aws.secretsmanager.getSecret({ name: runtimeSecretName($app.stage, id) }),
        ]),
      ),
    )
    const requireExplicitRuntimeSecret = (id: string, why: string) => {
      if (runtimeSecretNeedsGeneratedInitialVersion(runtimeSecrets[id]?.tags)) {
        throw new Error(`${id} must be set explicitly ${why}`)
      }
    }
    if (clickHouseExporterEnabled) {
      requireExplicitRuntimeSecret('clickHouseWriterPassword', 'when CLICKHOUSE_EXPORTER_ENABLED=true')
    }
    if (clickHouseReaderUrl || clickHouseReaderHost) {
      requireExplicitRuntimeSecret(
        'clickHouseReaderPassword',
        'when a ClickHouse reader URL or host is configured',
      )
    }
    if (ghcrUsername) {
      requireExplicitRuntimeSecret('ghcrPullToken', 'when GHCR_USERNAME is configured')
    }
    const runtimeSecretInitialVersions = Object.fromEntries(
      RUNTIME_SECRET_DEFINITIONS.flatMap(({ id }) => {
        if (!runtimeSecretNeedsGeneratedInitialVersion(runtimeSecrets[id].tags)) return []
        const resourceName = `RuntimeSecret${id[0].toUpperCase()}${id.slice(1)}InitialValue`
        const version = new aws.secretsmanager.SecretVersion(
          resourceName,
          {
            secretId: runtimeSecrets[id].id,
            secretString: $util.secret(runtimeSecretInitialValues[id]),
          },
          { ignoreChanges: ['secretString'], retainOnDelete: true },
        )
        return [[id, version]]
      }),
    )
    const runtimeSecretArn = (id: string) => {
      const secret = runtimeSecrets[id]
      const initialVersion = runtimeSecretInitialVersions[id]
      if (!secret) throw new Error(`unknown runtime secret id '${id}'`)
      if (!initialVersion) return secret.arn
      // Consumers must never race an unset bootstrap-created container. Including
      // the version id in this Output makes the ARN carry the dependency without
      // exposing the version contents or adding a separate edge at every caller.
      return $resolve([secret.arn, initialVersion.versionId]).apply(([arn]) => arn)
    }
    // Keep ECS valueFrom ARNs known during preview. Ordering belongs on each
    // task definition; hiding it in the ARN makes SST's whole container unknown
    // and causes its apply-created listeners and targets to appear deleted.
    const runtimeSecretEcsBindings = new RuntimeSecretEcsBindings({
      definitions: RUNTIME_SECRET_DEFINITIONS,
      initialVersions: runtimeSecretInitialVersions,
      secrets: runtimeSecrets,
    })
    // App secrets — set via `npm run sst -- secret set <NAME> --stage <stage>`;
    // stored encrypted in SST state and shared per-stage by anyone with deploy
    // access. OIDC_CLIENT_ID is
    // required and has no deployable fallback: a placeholder would let the stack
    // become healthy while every interactive login fails. Optional secrets carry
    // an empty-string fallback, where empty means that the feature is disabled.
    // NB: the Cloudflare provider creds can't live here (the provider initializes
    // in app() before run() exists); scripts/sst-with-cloudflare.mjs injects them
    // from SSM instead.
    const oidcClientId = new sst.Secret('OIDC_CLIENT_ID')
    const oidcMgmtClientId = new sst.Secret('OIDC_MANAGEMENT_API_CLIENT_ID')
    const oidcMgmtClientSecret = new sst.Secret('OIDC_MANAGEMENT_API_CLIENT_SECRET')
    const posthogApiKey = new sst.Secret('POSTHOG_API_KEY', '')
    const svixAuthToken = new sst.Secret('SVIX_AUTH_TOKEN', '')
    // The credential the usage exporter presents to Commerce's ingest route:
    // half of a shared secret whose other half is a Secrets Manager container
    // owned by boxlite-commerce's own stack, so both ends are set out of band
    // from one value rather than generated here.
    //
    // It is a secret of this stack rather than a read of that container
    // because the Api's *runtime* role could not read it if we tried. Its
    // execution role carries the boxlite-<stage>-runtime-boundary, which
    // admits only secret:boxlite-<stage>-* — deliberately, so one stage's
    // tasks cannot reach another's secrets. ECS says so plainly when asked:
    // it refuses to place the task with "no permissions boundary allows the
    // secretsmanager:GetSecretValue action". (The deploy role is not the
    // constraint — the deploy role has a separate selected-stage lifecycle
    // grant for this SST-owned secret and carries no runtime boundary.)
    //
    // Empty means the exporter stays off; see USAGE_EXPORT_ENABLED below.
    const usageExportToken = new sst.Secret('USAGE_EXPORT_TOKEN', '')

    // ─── 2. PLATFORM ─────────────────────────────────────────────────────────
    // Network model + rationale (subnets / NAT / egress-only public IP, AWS citations): ./NETWORKING.md
    // NAT instance (fck-nat, ~10× cheaper than a managed NAT Gateway). The Fargate
    // services run in private subnets (see Cluster below) with no public IP, so they
    // reach ECR, Docker Hub, the OIDC issuer, external ClickHouse, and AWS APIs
    // through this NAT. EC2 runners stay in public subnets and egress via the
    // Internet Gateway, not this NAT.
    const vpc = new sst.aws.Vpc('Vpc', {
      nat: 'ec2',
      // Name the VPC-created NAT resources (SST defaults: generic "Vpc NAT
      // Instance", unnamed EIP + SG). Name tags only — SST's own tags
      // (e.g. sst:is-nat) and the SG ingress/egress are left untouched.
      transform: {
        // resourceName is SST's logical id ("VpcNatInstance1"/"…2"); its trailing
        // digit is the per-AZ index. Resolve the instance's real AZ from its
        // subnet so the tag reads e.g. boxlite-dev-nat-1-ap-southeast-1a.
        natInstance: (args, _opts, resourceName) => {
          const idx = resourceName.match(/\d+$/)?.[0] ?? ''
          const az = aws.ec2.getSubnetOutput({ id: args.subnetId }).availabilityZone
          args.tags = { ...args.tags, Name: $interpolate`${$app.name}-${$app.stage}-nat-${idx}-${az}` }
        },
        // EIP i pairs with NAT instance i; it has no subnet of its own, so the
        // index alone is enough to keep the names aligned (…-nat-eip-1/2).
        elasticIp: (args, _opts, resourceName) => {
          const idx = resourceName.match(/\d+$/)?.[0] ?? ''
          args.tags = { ...args.tags, Name: `${$app.name}-${$app.stage}-nat-eip-${idx}` }
        },
        // One security group is shared by both NAT instances → a single name.
        natSecurityGroup: (args) => {
          args.tags = { ...args.tags, Name: `${$app.name}-${$app.stage}-nat-sg` }
        },
      },
    })
    // Durable state survives accidental teardown the way the runner does (§10).
    // `removal: 'retain'` (above) already keeps prod resources on `sst remove`, but it
    // does NOT stop a targeted destroy, a replace-on-immutable-change, or an AWS-console
    // delete — so prod also gets RDS deletion-protection + a final snapshot.
    // S3 versioning is on in every stage: cheap, and the only guard against an
    // object-level overwrite/delete (which `removal` never covers). Redis is a
    // transient cache, so it needs neither.
    const isProd = $app.stage === PRODUCTION_STAGE
    // Unique-but-stable suffix for the DB final snapshot: a fixed name would collide
    // with the snapshot a prior teardown of the same stage already created (RDS requires
    // unique final-snapshot ids). RandomId is stable across deploys (no drift) and is
    // regenerated on a full recreate, so each incarnation gets a distinct snapshot name.
    const dbFinalSnapshotId = isProd ? new random.RandomId('DbFinalSnapshotSuffix', { byteLength: 4 }) : undefined
    const db = new sst.aws.Postgres('Database', {
      vpc,
      instance: 't4g.micro',
      storage: '20 GB',
      transform: {
        instance: (args) => {
          args.deletionProtection = isProd
          args.skipFinalSnapshot = !isProd
          if (dbFinalSnapshotId) {
            args.finalSnapshotIdentifier = $interpolate`${$app.name}-${$app.stage}-db-final-${dbFinalSnapshotId.hex}`
          }
        },
      },
    })
    const redis = new sst.aws.Redis('Cache', { vpc, cluster: false }) // NestJS uses SELECT (multi-DB)
    const storage = new sst.aws.Bucket('Storage', { versioning: true })
    // Services run in PRIVATE subnets. SST's Vpc component otherwise defaults Fargate
    // tasks to public subnets with public IPs; passing the cluster a plain vpc object
    // (SST's documented escape hatch) overrides that: containerSubnets = private (no
    // public IP, egress via the NAT above), loadBalancerSubnets = public (ALBs stay
    // internet-facing, fronted by Cloudflare).
    const cluster = new sst.aws.Cluster('Cluster', {
      forceUpgrade: 'v2',
      vpc: {
        id: vpc.id,
        securityGroups: vpc.securityGroups,
        containerSubnets: vpc.privateSubnets,
        loadBalancerSubnets: vpc.publicSubnets,
        cloudmapNamespaceId: vpc.nodes.cloudmapNamespace.id,
        cloudmapNamespaceName: vpc.nodes.cloudmapNamespace.name,
      },
    })

    // Keep S3 traffic off the NAT: a Gateway VPC endpoint sends the private subnets'
    // S3 calls (box-volume objects + ECR layer blobs, which are stored in S3) straight
    // to S3 over the AWS backbone. It's free, and now that every service is private it
    // removes the single largest by-volume consumer of fck-nat egress.
    new aws.ec2.VpcEndpoint('S3Gateway', {
      vpcId: vpc.nodes.vpc.id,
      serviceName: `com.amazonaws.${REGION}.s3`,
      vpcEndpointType: 'Gateway',
      routeTableIds: vpc.nodes.privateRouteTables.apply((tables) => tables.map((t) => t.id)),
    })

    // ─── 3. IAM ──────────────────────────────────────────────────────────────
    // Box-storage credential vending. The Api's ECS task role assumes the
    // S3AccessRole declared after the Api service with a per-organization
    // inline session policy (apps/api object-storage.service.ts); effective
    // access is the intersection of the two. No IAM user / static keys: ECS
    // already delivers auto-rotated task-role credentials to the container.
    //
    // The role name is declared up front (deterministic, stage-scoped) so it
    // can go into the Api env and IAM grant as a plain string. The role
    // itself can only be created after the Api service, because its trust
    // policy names the task role — which exists once the Api does. Declaring
    // the name first breaks that resource cycle.
    const s3AccessRoleName = `${$app.name}-${$app.stage}-s3-access`
    const s3AccessRoleArn = $interpolate`arn:aws:iam::${aws.getCallerIdentityOutput().accountId}:role/${s3AccessRoleName}`

    // ─── 4. AUTH ─────────────────────────────────────────────────────────────
    // OIDC is delegated to an external provider (Auth0/Okta/etc.) via
    // OIDC_ISSUER_BASE_URL. No in-cluster Dex — removes one ALB + ACM cert +
    // service and the ephemeral-sqlite key-rotation problem.
    //
    // Router still exists for dashboard HTTPS + routing /* to Api.
    // NOTE: SST Router's placeholder origin is created with
    // `OriginProtocolPolicy: "http-only"`, which wins over the per-request
    // customOriginConfig set by its CloudFront Function for HTTPS origins
    // (CF rejects the TLS handshake → 502). Flip it to `https-only` so CF
    // respects the CF-Function's HTTPS override.
    const router = new sst.aws.Router('ApiCdn', {
      domain: { name: stackDomain, dns: cloudflareDns },
      transform: {
        cdn: (cdnArgs) => {
          cdnArgs.origins = $util.output(cdnArgs.origins).apply((origins) =>
            (origins ?? []).map((o: any) => ({
              ...o,
              customOriginConfig: o.customOriginConfig
                ? { ...o.customOriginConfig, originProtocolPolicy: 'https-only', originReadTimeout: 60 }
                : o.customOriginConfig,
            })),
          )
        },
      },
    })

    // ─── 5. OBSERVABILITY INGEST ─────────────────────────────────────────────
    // Created before Api so API, runner, host, and box can all emit OTLP to the
    // same Collector. ClickHouse is external/managed only; no in-cluster
    // ClickHouseSpike fallback is part of the target architecture.
    // Jaeger is VPC-internal only: the trace UI exposes every span (URLs,
    // headers, IDs, SQL, error bodies) with no auth over plain HTTP, and its
    // OTLP ingest is equally unauthenticated — reach the UI via VPN / bastion /
    // `aws ssm start-session`. JAEGER_PUBLIC is rejected (fail loud) like
    // MAILDEV_PUBLIC: no auth gate or TLS story makes public exposure safe.
    if (envOr('JAEGER_PUBLIC', 'false') === 'true') {
      throw new Error(
        'JAEGER_PUBLIC is not supported: Jaeger has no auth and its UI is plain HTTP, so ' +
          'it cannot be safely exposed to the internet. Reach it via VPN / bastion / ' +
          '`aws ssm start-session`.',
      )
    }
    const jaeger = new sst.aws.Service('Jaeger', {
      cluster,
      image: IMAGES.jaeger,
      loadBalancer: {
        public: false,
        rules: [
          { listen: '80/http', forward: `${PORTS.JAEGER_UI}/http` },
          // OTLP HTTP ingest, fed by the OtelCollector's otlphttp/jaeger exporter.
          { listen: `${PORTS.OTLP_HTTP}/http`, forward: `${PORTS.OTLP_HTTP}/http` },
        ],
        health: {
          // The OTLP receiver returns a client-error status for a bare
          // health-check GET, which still proves the receiver is listening.
          [`${PORTS.OTLP_HTTP}/http`]: httpHealth('/', { successCodes: '200-499' }),
        },
      },
      environment: { COLLECTOR_OTLP_ENABLED: 'true' },
      transform: {
        loadBalancer: (args) => {
          args.loadBalancerType = 'application'
        },
      },
    })
    const jaegerOtlpHttpEndpoint = stripTrailingSlash(jaeger.url).apply((url) => `${url}:${PORTS.OTLP_HTTP}`)

    const otelCollector = new sst.aws.Service('OtelCollector', {
      cluster,
      image: { context: '../..', dockerfile: 'apps/otel-collector/Dockerfile', cache: false },
      command: [
        '--config',
        '/otelcol/collector-config.yaml',
        '--set',
        `service::pipelines::traces::exporters=${collectorTraceExporters}`,
        '--set',
        `service::pipelines::metrics::exporters=${collectorExporters}`,
        '--set',
        `service::pipelines::logs::exporters=${collectorExporters}`,
      ],
      loadBalancer: {
        // Internal only: every OTLP emitter (API, runner, boxes) is in-VPC. A
        // public ingest endpoint would accept unauthenticated telemetry from
        // anywhere (injection / DoS / cost) and forward it to ClickHouse + the
        // API — there is no legitimate cross-internet producer. `.url` still
        // resolves (internal ALB DNS), so the OTLP endpoint wiring is unchanged.
        public: false,
        rules: [
          { listen: `${PORTS.OTLP_HTTP}/http`, forward: `${PORTS.OTLP_HTTP}/http` },
          { listen: '80/http', forward: `${PORTS.OTEL_HEALTH}/http` },
        ],
        health: {
          // The OTLP HTTP receiver returns a client-error status for a bare
          // health-check GET, which still proves the receiver is listening.
          [`${PORTS.OTLP_HTTP}/http`]: httpHealth('/', { successCodes: '200-499' }),
          [`${PORTS.OTEL_HEALTH}/http`]: httpHealth('/health/status'),
        },
      },
      environment: {
        BOXLITE_RUNTIME_SECRET_GENERATION: runtimeSecretGenerationMarkerFor('OtelCollector'),
        CLICKHOUSE_ENDPOINT: clickHouseWriterEndpoint || 'https://clickhouse-disabled.invalid:443',
        CLICKHOUSE_DATABASE: envOr('CLICKHOUSE_WRITER_DATABASE', envOr('CLICKHOUSE_DATABASE', 'otel')),
        CLICKHOUSE_USERNAME: envOr('CLICKHOUSE_WRITER_USERNAME', envOr('CLICKHOUSE_USERNAME', 'default')),
        CLICKHOUSE_CREATE_SCHEMA: envOr('CLICKHOUSE_CREATE_SCHEMA', 'false'),
        CLICKHOUSE_COMPRESS: envOr('CLICKHOUSE_COMPRESS', 'none'),
        BOXLITE_API_URL: envOr('BOXLITE_API_URL', `https://api.${stackDomain}/api`),
        JAEGER_OTLP_HTTP_ENDPOINT: jaegerOtlpHttpEndpoint,
      },
      ssm: {
        CLICKHOUSE_PASSWORD: runtimeSecretEcsBindings.arn('clickHouseWriterPassword'),
        BOXLITE_API_KEY: runtimeSecretEcsBindings.arn('otelCollectorApiKey'),
      },
      transform: {
        loadBalancer: (args) => {
          // SST derives this immutable field from the whole Service, so the
          // legacy task secrets tainted it in state. Preserve only that exact
          // historical shape while cutting every container dependency.
          args.loadBalancerType = $util.secret('application')
        },
        taskDefinition: (_args, opts) => {
          opts.dependsOn = runtimeSecretEcsBindings.initialVersionsFor('OtelCollector')
        },
      },
    })
    const otelCollectorOtlpHttpUrl = stripTrailingSlash(otelCollector.url).apply((url) => `${url}:${PORTS.OTLP_HTTP}`)

    // ─── 6. API (NestJS control plane) ───────────────────────────────────────
    // Where the Api image comes from. `release` deploys the image published for a version, so a
    // release promotes the exact artifact that was tested rather than rebuilding one that merely
    // shares its commit. `build` deploys the image its own CI job built for the selected commit —
    // the Runner has always worked that way, and doing it here too means a build deploy installs
    // bytes that were built once and can be pointed at again, rather than bytes this particular
    // deploy happened to compile.
    //
    // A build with no Api ref means nothing published an Api image for this checkout, so SST
    // builds apps/api/Dockerfile the way it always did. That is a plain local `npm run deploy`,
    // and also `npm run runner:build-artifact`, which stages a Runner and sets only the Runner's
    // ref. deploy-infra.yml publishes both and sets the global one.
    //
    // SST hands an image string straight to the task definition (normalizeImage, sst/platform
    // fargate component), so the modes differ only in this expression.
    //
    // The stage bootstrap template (ci/github-deploy-role.yaml) owns the immutable repository:
    // an image has to be published before a fresh stack can consume one, so the consumer cannot
    // also be responsible for creating its input.
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
        loadBalancer: (lbArgs) => {
          // Preserve the legacy secret bit without retaining dependencies on
          // the task's generated credentials or downstream Services.
          lbArgs.loadBalancerType = $util.secret('application')
          lbArgs.idleTimeout = 3600
        },
        taskDefinition: (_args, opts) => {
          opts.dependsOn = runtimeSecretEcsBindings.initialVersionsFor('Api')
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
      environment: {
        BOXLITE_RUNTIME_SECRET_GENERATION: runtimeSecretGenerationMarkerFor('Api'),
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

        // OIDC — external provider (Auth0/Okta/etc.)
        OIDC_CLIENT_ID: oidcClientId.value,
        OIDC_AUDIENCE: envOr('OIDC_AUDIENCE', 'boxlite'),
        OIDC_ISSUER_BASE_URL: oidcIssuer,
        ...(publicOidcIssuer && {
          PUBLIC_OIDC_DOMAIN: publicOidcIssuer,
        }),
        // Optional: Auth0 Management API (enables account linking etc.)
        ...(process.env.OIDC_MANAGEMENT_API_ENABLED === 'true' && {
          OIDC_MANAGEMENT_API_ENABLED: 'true',
          ...(process.env.OIDC_MANAGEMENT_API_BASE_URL && {
            OIDC_MANAGEMENT_API_BASE_URL: process.env.OIDC_MANAGEMENT_API_BASE_URL,
          }),
          ...(process.env.OIDC_MANAGEMENT_API_TOKEN_URL && {
            OIDC_MANAGEMENT_API_TOKEN_URL: process.env.OIDC_MANAGEMENT_API_TOKEN_URL,
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

        // Proxy
        PROXY_DOMAIN: proxyDomain,
        PROXY_PROTOCOL: proxyProtocol,
        PROXY_TEMPLATE_URL: proxyTemplateUrl,

        // Observability read/write path. These stay server-side; never expose
        // ClickHouse credentials to the dashboard bundle.
        OTEL_ENABLED: envOr('OTEL_ENABLED', 'true'),
        OTEL_EXPORTER_OTLP_ENDPOINT: envOr('OTEL_EXPORTER_OTLP_ENDPOINT', otelCollectorOtlpHttpUrl),
        ...(clickHouseReaderUrl
          ? {
              CLICKHOUSE_URL: clickHouseReaderUrl,
              CLICKHOUSE_DATABASE: envOr('CLICKHOUSE_READER_DATABASE', envOr('CLICKHOUSE_DATABASE', 'otel')),
              CLICKHOUSE_USERNAME: envOr('CLICKHOUSE_READER_USERNAME', envOr('CLICKHOUSE_USERNAME', 'default')),
            }
          : clickHouseReaderHost
            ? {
                CLICKHOUSE_HOST: clickHouseReaderHost,
                CLICKHOUSE_PORT: envOr('CLICKHOUSE_READER_PORT', envOr('CLICKHOUSE_PORT', '443')),
                CLICKHOUSE_DATABASE: envOr('CLICKHOUSE_READER_DATABASE', envOr('CLICKHOUSE_DATABASE', 'otel')),
                CLICKHOUSE_USERNAME: envOr('CLICKHOUSE_READER_USERNAME', envOr('CLICKHOUSE_USERNAME', 'default')),
                CLICKHOUSE_PROTOCOL: envOr('CLICKHOUSE_READER_PROTOCOL', envOr('CLICKHOUSE_PROTOCOL', 'https')),
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
          USAGE_EXPORT_ENABLED: usageExportToken.value.apply((token) => (token.trim() ? 'true' : 'false')),
        }),
      },
      ssm: {
        ENCRYPTION_KEY: runtimeSecretEcsBindings.arn('encryptionKey'),
        ENCRYPTION_SALT: runtimeSecretEcsBindings.arn('encryptionSalt'),
        ADMIN_API_KEY: runtimeSecretEcsBindings.arn('adminApiKey'),
        PROXY_API_KEY: runtimeSecretEcsBindings.arn('proxyApiKey'),
        DEFAULT_RUNNER_API_KEY: runtimeSecretEcsBindings.arn('defaultRunnerApiKey'),
        CLICKHOUSE_PASSWORD: runtimeSecretEcsBindings.arn('clickHouseReaderPassword'),
        OTEL_EXPORTER_OTLP_HEADERS: runtimeSecretEcsBindings.arn('otelExporterOtlpHeaders'),
        OTEL_COLLECTOR_API_KEY: runtimeSecretEcsBindings.arn('otelCollectorApiKey'),
      },
    })

    // Assumed by the Api task role to vend per-org box storage credentials
    // (see section 3). The permission set mirrors the session policy's action
    // set in object-storage.service.ts, so the intersection that boxes
    // receive is exactly the per-org prefix scope.
    const s3AccessRole = new aws.iam.Role('S3AccessRole', {
      name: s3AccessRoleName,
      assumeRolePolicy: api.nodes.taskRole.arn.apply((taskRoleArn) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { AWS: taskRoleArn }, Action: 'sts:AssumeRole' }],
        }),
      ),
    })
    new aws.iam.RolePolicy('S3AccessRolePolicy', {
      role: s3AccessRole.name,
      policy: storage.arn.apply((bucketArn) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: [`${bucketArn}/*`] },
            { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [bucketArn] },
          ],
        }),
      ),
    })

    // ─── 7. EDGE SERVICES ────────────────────────────────────────────────────
    // Proxy: routes `<port>-<boxid>.<proxyDomain>` to the box port.
    // SST terminates TLS on the NLB listener and manages the proxy + wildcard
    // Cloudflare records from the same env-driven domain exposed by the API.
    // Protect the NLB topology so an immutable replacement fails instead of
    // partially switching the listener to a target group that ECS has not
    // attached. Routine task revisions continue to use ECS rolling deployments.

    new sst.aws.Service('Proxy', {
      cluster,
      image: { context: '../..', dockerfile: 'apps/proxy/Dockerfile', cache: false },
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
        BOXLITE_RUNTIME_SECRET_GENERATION: runtimeSecretGenerationMarkerFor('Proxy'),
        PROXY_PORT: String(PORTS.PROXY),
        PROXY_PROTOCOL: proxyProtocol,
        // api-client-go appends paths like "/config" directly → include /api suffix
        BOXLITE_API_URL: $interpolate`${stripTrailingSlash(api.url)}/api`,
        OIDC_CLIENT_ID: oidcClientId.value,
        OIDC_AUDIENCE: envOr('OIDC_AUDIENCE', 'boxlite'),
        OIDC_DOMAIN: oidcIssuer,
        ...(publicOidcIssuer && {
          OIDC_PUBLIC_DOMAIN: publicOidcIssuer,
        }),
        OTEL_TRACING_ENABLED: envOr('OTEL_TRACING_ENABLED', 'true'),
        OTEL_EXPORTER_OTLP_ENDPOINT: envOr('OTEL_EXPORTER_OTLP_ENDPOINT', otelCollectorOtlpHttpUrl),
      },
      ssm: {
        PROXY_API_KEY: runtimeSecretEcsBindings.arn('proxyApiKey'),
        OTEL_EXPORTER_OTLP_HEADERS: runtimeSecretEcsBindings.arn('otelExporterOtlpHeaders'),
      },
      transform: {
        loadBalancer: (args, opts) => {
          // Proxy's NLB type was secret-tainted through Api and Collector.
          // Keep the historical bit but pin the actual type independently.
          args.loadBalancerType = $util.secret('network')
          opts.protect = true
        },
        taskDefinition: (_args, opts) => {
          opts.dependsOn = runtimeSecretEcsBindings.initialVersionsFor('Proxy')
        },
        listener: (_args, opts) => {
          opts.protect = true
        },
        target: (args, opts) => {
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

    // ─── 8. ADMIN UIs ────────────────────────────────────────────────────────
    // pgAdmin security gate. pgAdmin is a
    // Postgres admin console one hop from RDS. Knobs are overridable via env;
    // unset falls back to the secure default below (internal ALB + login
    // enabled). The two values are coupled, not independent: exposing it
    // publicly is only allowed with auth on, so a single misconfigured flag
    // can't recreate the public + no-auth hole.
    const pgAdminPublic = envOr('PGADMIN_PUBLIC', 'false') === 'true'
    const pgAdminServerMode = envOr('PGADMIN_CONFIG_SERVER_MODE', 'True')
    const pgAdminMasterPassword = envOr('PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED', 'True')
    if (pgAdminPublic && (pgAdminServerMode !== 'True' || pgAdminMasterPassword !== 'True')) {
      throw new Error(
        'PGADMIN_PUBLIC=true requires PGADMIN_CONFIG_SERVER_MODE=True and ' +
          'PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED=True — refusing to expose a ' +
          'Postgres admin console to the internet without login auth. Reach ' +
          'pgAdmin via VPN / bastion / `aws ssm start-session` instead.',
      )
    }
    new sst.aws.Service('PgAdmin', {
      cluster,
      image: IMAGES.pgadmin,
      loadBalancer: {
        // Internal ALB by default: reachable only from inside the VPC (VPN /
        // bastion / `aws ssm start-session` port-forward). PGADMIN_PUBLIC=true
        // exposes it publicly — gated above to require login auth.
        public: pgAdminPublic,
        rules: [{ listen: '80/http', forward: `${PORTS.PGADMIN}/http` }],
        health: { [`${PORTS.PGADMIN}/http`]: httpHealth('/', { successCodes: '200-399' }) },
      },
      environment: {
        BOXLITE_RUNTIME_SECRET_GENERATION: runtimeSecretGenerationMarkerFor('PgAdmin'),
        PGADMIN_DEFAULT_EMAIL: envOr('PGADMIN_DEFAULT_EMAIL', 'admin@boxlite.dev'),
        // Server mode enables the login screen (desktop mode skips auth
        // entirely); master password gates saved server credentials.
        PGADMIN_CONFIG_SERVER_MODE: pgAdminServerMode,
        PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED: pgAdminMasterPassword,
      },
      ssm: {
        PGADMIN_DEFAULT_PASSWORD: runtimeSecretEcsBindings.arn('pgAdminDefaultPassword'),
      },
      transform: {
        loadBalancer: (args) => {
          // Preserve only the legacy password-derived secret bit on the
          // immutable type; the rest of the load-balancer stays plain.
          args.loadBalancerType = $util.secret('application')
        },
        taskDefinition: (_args, opts) => {
          opts.dependsOn = runtimeSecretEcsBindings.initialVersionsFor('PgAdmin')
        },
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
        loadBalancer: (args) => {
          args.loadBalancerType = 'application'
        },
      },
    })

    // ─── 9. CDN ROUTES ───────────────────────────────────────────────────────
    // Router (declared in section 4) fronts the Api with HTTPS.
    router.route('/', api.url)

    // ─── 10. RUNNER (EC2 with nested KVM) ────────────────────────────────────
    // Boots an Ubuntu EC2 that runs the prebuilt runner binary under systemd, with nested KVM
    // enabled for box VMs.
    //
    // Where that binary comes from is the mirror of the Api's choice above. `release` — the
    // default, and all this stack could do before — installs the published GitHub Release asset
    // for a version. `build` installs a binary produced from the deployed commit and staged in
    // the bucket below, which is what makes an unreleased Runner change testable at all.
    //
    // Both install paths (user-data at first boot, SSM for a live host) take the same
    // URL + checksum pair, so the source only changes where the two URLs point and which
    // command fetches them — see scripts/runner-artifact.mjs.
    //
    // The stage bootstrap template owns this private bucket for the same ordering reason
    // it owns the API repository: CI stages the object before this stack can consume it. The name
    // is derived in one helper shared with the preflight and the staging command.
    const artifactsBucketName = runnerArtifactsBucketName({ app: $app.name, stage: $app.stage, accountId })
    const deploysRunner = readDeployScope().includes('runner')
    const runnerArtifactSource = resolveArtifactSource('runner')
    const runnerArtifact = resolveRunnerArtifact(runnerArtifactSource, {
      ...process.env,
      RUNNER_ARTIFACT_BUCKET: artifactsBucketName,
    })

    const ubuntuAmi = aws.ec2.getAmi({
      mostRecent: true,
      owners: [RUNNER.ubuntuOwnerId],
      filters: [
        { name: 'name', values: [RUNNER.ubuntuNamePattern] },
        { name: 'architecture', values: ['x86_64'] },
      ],
    })

    const runnerAssumeRolePolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    })
    const runnerVolumeS3PolicyDocument = JSON.stringify({
      Version: '2012-10-17',
      // Exactly Mountpoint for Amazon S3's documented permission set —
      // mount-s3 is the runner's only S3 consumer (volumes.go). Bucket
      // lifecycle (create/tag/delete) lives on the Api task role instead.
      Statement: [
        {
          Effect: 'Allow',
          Action: ['s3:ListBucket'],
          Resource: ['arn:aws:s3:::boxlite-volume-*'],
        },
        {
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
          Resource: ['arn:aws:s3:::boxlite-volume-*/*'],
        },
      ],
    })
    const runnerArtifactS3PolicyDocument = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['s3:GetObject'],
          Resource: `arn:aws:s3:::${artifactsBucketName}/runner/*`,
        },
      ],
    })

    // Keep the historical RunnerRole/RunnerProfile on the protected default
    // Runner. Its persistent host migration can then be rolled back while the
    // same profile still has access to the stable default key. Extra runners
    // move to the stage-bound role below so they can never read that key.
    const runnerRole = new aws.iam.Role('RunnerRole', { assumeRolePolicy: runnerAssumeRolePolicy })
    const runnerSsmPolicy = new aws.iam.RolePolicyAttachment('RunnerSsmPolicy', {
      role: runnerRole.name,
      policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
    })
    const runnerVolumeS3Policy = new aws.iam.RolePolicy('RunnerVolumeS3Policy', {
      role: runnerRole.name,
      policy: runnerVolumeS3PolicyDocument,
    })
    const runnerArtifactPolicy = new aws.iam.RolePolicy('RunnerArtifactS3Policy', {
      role: runnerRole.name,
      // Read-only, and only under the prefix build-mode Runner binaries are staged in. This is
      // how a host installs a binary that was never published; nothing else in the bucket is
      // reachable, and the Runner can never write here.
      policy: runnerArtifactS3PolicyDocument,
    })
    const runnerInstanceProfile = new aws.iam.InstanceProfile('RunnerProfile', { role: runnerRole.name })

    const extraRunnerRole = new aws.iam.Role('ExtraRunnerRole', {
      assumeRolePolicy: runnerAssumeRolePolicy,
    })
    const extraRunnerSsmPolicy = new aws.iam.RolePolicyAttachment('ExtraRunnerSsmPolicy', {
      role: extraRunnerRole.name,
      policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
    })
    const extraRunnerVolumeS3Policy = new aws.iam.RolePolicy('ExtraRunnerVolumeS3Policy', {
      role: extraRunnerRole.name,
      policy: runnerVolumeS3PolicyDocument,
    })
    const extraRunnerArtifactPolicy = new aws.iam.RolePolicy('ExtraRunnerArtifactS3Policy', {
      role: extraRunnerRole.name,
      policy: runnerArtifactS3PolicyDocument,
    })
    const extraRunnerInstanceProfile = new aws.iam.InstanceProfile('ExtraRunnerProfile', {
      name: extraRunnerInstanceProfileName($app.stage),
      role: extraRunnerRole.name,
    })

    // Dedicated runner security group (least-privilege, explicit in IaC).
    // Without it the runner falls back to the VPC's shared default SG, which
    // allows ALL ports from the whole VPC CIDR. The runner multiplexes its
    // control-plane API, box proxy, and (when enabled) ssh-gateway onto a single
    // port (API_PORT = PORTS.RUNNER); box ports are served INSIDE the runner and
    // never bound on the host NIC. So one inbound port — reachable only from
    // inside the VPC — is the complete surface. Combined with the public-subnet
    // placement (the runner egresses via the Internet Gateway, not the NAT that
    // serves the private services), this yields an egress-only public IP:
    // nothing on the internet can reach the runner.
    const runnerSecurityGroup = new aws.ec2.SecurityGroup('RunnerSecurityGroup', {
      vpcId: vpc.nodes.vpc.id,
      description: 'BoxLite runner - inbound only on the runner API port from within the VPC',
      ingress: [
        {
          protocol: 'tcp',
          fromPort: PORTS.RUNNER,
          toPort: PORTS.RUNNER,
          cidrBlocks: [vpc.nodes.vpc.cidrBlock],
          description: 'control-plane API + box proxy + ssh-gateway (multiplexed on the runner API port)',
        },
      ],
      egress: [
        {
          protocol: '-1',
          fromPort: 0,
          toPort: 0,
          cidrBlocks: ['0.0.0.0/0'],
          description: 'image pulls (ghcr/github/aws), S3, Secrets Manager, OTLP, control-plane callbacks',
        },
      ],
    })

    // ── Runner ghcr pull credential (legacy rollback + stable runtime ARN) ───
    // Keep the legacy GHCR container/version in v1 as rollback protection. New
    // runner user data reads the stable stage-named runtime secret below, while
    // the extra-runner role retains legacy read access until every
    // protected instance has converged away from its ignored legacy user data.
    const ghcrToken = process.env.GHCR_TOKEN?.trim() || ''
    const legacyGhcrSecret = new aws.secretsmanager.Secret(
      'GhcrPullToken',
      { recoveryWindowInDays: 7 },
      { retainOnDelete: true },
    )
    new aws.secretsmanager.SecretVersion(
      'GhcrPullTokenValue',
      {
        secretId: legacyGhcrSecret.id,
        secretString: $util.secret(ghcrToken || 'unused'),
      },
      { ignoreChanges: ['secretString'], retainOnDelete: true },
    )
    const extraRunnerRuntimeSecretPolicy = new aws.iam.RolePolicy('ExtraRunnerRuntimeSecretPolicy', {
      role: extraRunnerRole.name,
      policy: $resolve([legacyGhcrSecret.arn, runtimeSecretArn('ghcrPullToken')]).apply(
        ([legacyGhcrTokenArn, ghcrTokenArn]) =>
          JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['secretsmanager:GetSecretValue'],
                Resource: [legacyGhcrTokenArn, ghcrTokenArn],
              },
            ],
          }),
      ),
    })
    const defaultRunnerRuntimeSecretPolicy = new aws.iam.RolePolicy('DefaultRunnerRuntimeSecretPolicy', {
      role: runnerRole.name,
      policy: $resolve([
        legacyGhcrSecret.arn,
        runtimeSecretArn('defaultRunnerApiKey'),
        runtimeSecretArn('ghcrPullToken'),
      ]).apply(([legacyGhcrTokenArn, runnerTokenArn, ghcrTokenArn]) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['secretsmanager:GetSecretValue'],
              Resource: [legacyGhcrTokenArn, ghcrTokenArn],
            },
            {
              // Extra runners briefly share this historical role while their
              // protected profiles move forward or roll back. EC2 supplies this
              // global request context from the role credentials, so only the
              // protected default instance can use the default runner key.
              Effect: 'Allow',
              Action: ['secretsmanager:GetSecretValue'],
              Resource: runnerTokenArn,
              Condition: {
                ArnEquals: {
                  'ec2:SourceInstanceARN': defaultRunnerSourceArn,
                },
              },
            },
          ],
        }),
      ),
    })

    const runnerUserData = $resolve([
      api.url,
      otelCollectorOtlpHttpUrl,
      runtimeSecretArn('defaultRunnerApiKey'),
      runtimeSecretArn('ghcrPullToken'),
    ]).apply(([apiUrl, otelEndpoint, tokenSecretArn, ghcrSecretArn]) =>
      buildRunnerUserData({
        apiUrl,
        tokenSecretArn,
        otelEndpoint,
        awsRegion: REGION,
        artifact: runnerArtifact,
        ghcrSecretArn: ghcrUsername ? ghcrSecretArn : undefined,
        ghcrUsername,
      }),
    )

    // Runners hold load-bearing box state (/var/lib/boxlite + in-memory libkrun VMs).
    // The default runner and every extra runner are identical except for resource
    // name, identity tags, and per-runner user-data, so they share one factory. Two Pulumi
    // options keep a runner persistent across routine deploys:
    //   • ignoreChanges ['ami','userDataBase64']: monthly Ubuntu AMIs and Cargo.toml
    //     version bumps no longer force replacement. The version bump still has to reach
    //     the running fleet, so the UpgradeRunnerBinary commands below land it over SSM
    //     instead — every runner, one at a time (see scripts/runner-update-binary.mjs).
    //   • protect: refuses any delete (errant `pulumi destroy` / teardown). Keep this
    //     true; decommission and recovery stay outside routine deployments.
    const makeRunner = (
      resourceName: string,
      nameTag: string,
      controlPlaneRunnerName: string,
      userData: $util.Input<string>,
      access: {
        instanceProfile: $util.Input<string>
        policies: $util.Resource[]
      },
    ) =>
      new aws.ec2.Instance(
        resourceName,
        {
          ami: ubuntuAmi.then((a) => a.id),
          instanceType: RUNNER.instanceType,
          // Egress-only public IP: public subnet → Internet Gateway (not the NAT that
          // serves the private services) for image pulls (ghcr/github), S3, Secrets
          // Manager, and control-plane callbacks. Inbound is locked to the runner port
          // from inside the VPC by RunnerSecurityGroup, so the internet can't reach it.
          subnetId: vpc.publicSubnets[0],
          associatePublicIpAddress: true,
          vpcSecurityGroupIds: [runnerSecurityGroup.id],
          iamInstanceProfile: access.instanceProfile,
          cpuOptions: { nestedVirtualization: 'enabled' },
          // Enforce IMDSv2 + a 1-hop limit so a container escape or SSRF on this
          // untrusted-code host can't read the instance-role creds (S3
          // boxlite-volume-*, the ghcr token in Secrets Manager, SSM).
          metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1 },
          userDataBase64: userData,
          rootBlockDevice: { volumeSize: RUNNER.rootDiskGB },
          tags: {
            Name: nameTag,
            'boxlite:control-plane-runner-name': controlPlaneRunnerName,
            [RUNNER_STAGE_TAG]: $app.stage,
            [RUNNER_ROLE_TAG]: RUNNER_ROLE_VALUE,
          },
        },
        {
          ignoreChanges: ['ami', 'userDataBase64'],
          protect: true,
          // First boot reads the staged artifact with this role. The grants are siblings of the
          // instance under its role, not ancestors, so without this edge Pulumi may create
          // the host first and its user-data dies on AccessDenied — permanently, because
          // protect + ignoreChanges('userDataBase64') mean it never runs again. Same edge the
          // UpgradeRunnerBinary commands declare for the SSM path.
          dependsOn: access.policies,
        },
      )

    // Default runner — auto-seeded by the API at boot via DEFAULT_RUNNER_*.
    // Pulumi resource id stays 'Runner' (renaming it would replace a protect:true
    // instance); the AWS tags bind it to the API's configured default name.
    const defaultRunner = makeRunner(
      defaultRunnerConfig.resourceName,
      defaultRunnerConfig.nameTag,
      defaultRunnerConfig.controlPlaneRunnerName,
      runnerUserData,
      {
        instanceProfile: runnerInstanceProfile.name,
        policies: [
          runnerSsmPolicy,
          runnerVolumeS3Policy,
          runnerArtifactPolicy,
          defaultRunnerRuntimeSecretPolicy,
        ],
      },
    )

    // The migration below changes persistent host state. Keep an always-declared
    // rollback guard so a Runner-excluded deploy cannot accidentally invoke it.
    // The default Runner deliberately remains on the historical profile; during
    // a software rollback the delete hook can therefore fetch the stable key
    // before the dependent policy is removed in Pulumi's post-step delete phase.
    // It restores the value-bearing unit contract expected by the old stack.
    const defaultRunnerLegacyRollbackGuard = new command.local.Command(
      'DefaultRunnerLegacyRollbackGuard',
      {
        dir: $cli.paths.root,
        create: 'true',
        update: 'true',
        delete: 'node scripts/runtime-secrets-cli.mjs restore-default-runner-legacy',
        addPreviousOutputInEnv: false,
        logging: 'none',
        environment: {
          INSTANCE_ID: defaultRunner.id,
          AWS_REGION: REGION,
          SST_STAGE: $app.stage,
          BOXLITE_RUNNER_TOKEN_SECRET_ARN: runtimeSecretArn('defaultRunnerApiKey'),
          LEGACY_GHCR_SECRET_ARN: legacyGhcrSecret.arn,
          GHCR_USERNAME: ghcrUsername,
        },
      },
      { dependsOn: [defaultRunner, defaultRunnerRuntimeSecretPolicy] },
    )

    // Existing protected runners never replay user-data because the instance
    // deliberately ignores userDataBase64. Converge the live systemd unit over
    // SSM instead: the remote script first proves both ARN reads, replaces the
    // plaintext token line with a start wrapper + ARN-only drop-in, then reloads
    // and restarts atomically with rollback on failure. Bootstrap records each
    // nonsecret AWSCURRENT generation in the immutable release, so rotating GHCR
    // deliberately re-runs this command and the restarted service reads the new value.
    let defaultRunnerRuntimeSecretMigration: $util.Resource | undefined
    if (deploysRunner) {
      const migrateDefaultRunnerRuntimeSecrets =
        'node scripts/runtime-secrets-cli.mjs reconcile-default-runner'
      defaultRunnerRuntimeSecretMigration = new command.local.Command(
        'MigrateDefaultRunnerRuntimeSecrets',
        {
          dir: $cli.paths.root,
          create: migrateDefaultRunnerRuntimeSecrets,
          update: migrateDefaultRunnerRuntimeSecrets,
          environment: {
            INSTANCE_ID: defaultRunner.id,
            AWS_REGION: REGION,
            SST_STAGE: $app.stage,
            BOXLITE_RUNNER_TOKEN_SECRET_ARN: runtimeSecretArn('defaultRunnerApiKey'),
            GHCR_SECRET_ARN: runtimeSecretArn('ghcrPullToken'),
            GHCR_USERNAME: ghcrUsername,
          },
          triggers: [
            'runtime-secret-drop-in-v1',
            defaultRunner.id,
            runtimeSecretArn('defaultRunnerApiKey'),
            runtimeSecretArn('ghcrPullToken'),
            ghcrUsername,
            ghcrUsername
              ? runtimeSecretGeneration(runtimeSecretGenerations, 'ghcrPullToken')
              : 'disabled',
          ],
        },
        { dependsOn: [defaultRunnerLegacyRollbackGuard, defaultRunner, defaultRunnerRuntimeSecretPolicy] },
      )
    }

    // Multi-runner provisioning. Extra runners share the same OTel endpoint as
    // the default runner.
    //
    // ── Extra runners (RUNNERS > 1) ──────────────────────────────────────────
    // The default runner above is auto-seeded by the API at boot via
    // DEFAULT_RUNNER_*. The API has no multi-runner seed, so any additional
    // runners are provisioned here and registered with the control plane after
    // deploy via the admin API (RegisterExtraRunners below). Each gets its OWN
    // token — pairing is token-based (the runner row's apiKey must equal the
    // BOXLITE_RUNNER_TOKEN baked into the matching EC2's user-data) — and the
    // same protect/ignoreChanges options as the default so routine deploys never
    // replace a state-holding runner.
    const extraRunners = runnerInventory.slice(1).map((runner) => {
      const apiKey = randomKey(`RunnerApiKey-${runner.controlPlaneRunnerName}`)
      // Resource id stays `Runner-runner-N` (stable — these are protect:true);
      // the AWS Name tag takes the cleaner `boxlite-runner-N` form while a
      // separate tag preserves the exact control-plane name.
      const instance = makeRunner(
        runner.resourceName,
        runner.nameTag,
        runner.controlPlaneRunnerName,
        $resolve([api.url, apiKey.result, otelCollectorOtlpHttpUrl, runtimeSecretArn('ghcrPullToken')]).apply(
          ([apiUrl, token, otelEndpoint, ghcrSecretArn]) =>
            buildRunnerUserData({
              apiUrl,
              token,
              otelEndpoint,
              awsRegion: REGION,
              artifact: runnerArtifact,
              ghcrSecretArn: ghcrUsername ? ghcrSecretArn : undefined,
              ghcrUsername,
            }),
        ),
        {
          instanceProfile: extraRunnerInstanceProfile.name,
          policies: [
            extraRunnerSsmPolicy,
            extraRunnerVolumeS3Policy,
            extraRunnerArtifactPolicy,
            extraRunnerRuntimeSecretPolicy,
          ],
        },
      )
      return { name: runner.controlPlaneRunnerName, apiKey, instance }
    })

    // Protected extra runners retain their historical userDataBase64, including
    // the legacy GhcrPullToken ARN. Converge that one non-secret reference over
    // SSM before any binary restart. The remote transaction preserves the
    // per-runner token line byte-for-byte. Enabled GHCR installs the stable ARN;
    // disabled GHCR removes both known ARN spellings and the managed drop-in
    // without reading a secret value.
    const extraRunnerGhcrMigrations: $util.Resource[] = []
    const extraRunnerGhcrRollbackGuards = new Map<string, $util.Resource>()
    let previousRunnerRollbackGuard: $util.Resource = defaultRunnerLegacyRollbackGuard
    for (const { name, instance } of extraRunners) {
      const rollbackGuard = new command.local.Command(
        `ExtraRunnerGhcrLegacyRollbackGuard-${name}`,
        {
          dir: $cli.paths.root,
          create: 'true',
          update: 'true',
          delete: 'node scripts/runtime-secrets-cli.mjs restore-extra-runner-ghcr-legacy',
          addPreviousOutputInEnv: false,
          logging: 'none',
          environment: {
            INSTANCE_ID: instance.id,
            AWS_REGION: REGION,
            SST_STAGE: $app.stage,
            GHCR_ENABLED: ghcrUsername ? 'true' : 'false',
            GHCR_USERNAME: ghcrUsername,
            LEGACY_GHCR_SECRET_ARN: legacyGhcrSecret.arn,
            GHCR_SECRET_ARN: runtimeSecretArn('ghcrPullToken'),
          },
        },
        {
          // On rollback Pulumi first puts the host back on RunnerProfile, then
          // performs deletions. That historical role still has both GHCR ARNs
          // through DefaultRunnerRuntimeSecretPolicy. These dependencies keep
          // both the current and rollback role grants alive until this host has
          // restored the retained legacy ARN; the guard chain restarts one host
          // at a time in reverse order.
          dependsOn: [
            instance,
            extraRunnerRuntimeSecretPolicy,
            defaultRunnerRuntimeSecretPolicy,
            previousRunnerRollbackGuard,
          ],
        },
      )
      extraRunnerGhcrRollbackGuards.set(name, rollbackGuard)
      previousRunnerRollbackGuard = rollbackGuard
    }

    let previousRunnerSecretMigration: $util.Resource | undefined = defaultRunnerRuntimeSecretMigration
    if (deploysRunner) {
      for (const { name, instance } of extraRunners) {
        const rollbackGuard = extraRunnerGhcrRollbackGuards.get(name)!
        const reconcileExtraRunnerGhcr = 'node scripts/runtime-secrets-cli.mjs reconcile-extra-runner-ghcr'
        const migration = new command.local.Command(
          `MigrateExtraRunnerGhcr-${name}`,
          {
            dir: $cli.paths.root,
            create: reconcileExtraRunnerGhcr,
            update: reconcileExtraRunnerGhcr,
            environment: {
              INSTANCE_ID: instance.id,
              AWS_REGION: REGION,
              SST_STAGE: $app.stage,
              GHCR_ENABLED: ghcrUsername ? 'true' : 'false',
              GHCR_USERNAME: ghcrUsername,
              LEGACY_GHCR_SECRET_ARN: legacyGhcrSecret.arn,
              GHCR_SECRET_ARN: ghcrUsername
                ? runtimeSecretArn('ghcrPullToken')
                : runtimeSecrets.ghcrPullToken.arn,
            },
            triggers: [
              'extra-runner-ghcr-drop-in-v1',
              instance.id,
              legacyGhcrSecret.arn,
              ghcrUsername,
              ghcrUsername ? runtimeSecretArn('ghcrPullToken') : runtimeSecrets.ghcrPullToken.arn,
              ghcrUsername
                ? runtimeSecretGeneration(runtimeSecretGenerations, 'ghcrPullToken')
                : 'disabled',
            ],
          },
          {
            dependsOn: [
              rollbackGuard,
              instance,
              extraRunnerRuntimeSecretPolicy,
              ...(previousRunnerSecretMigration ? [previousRunnerSecretMigration] : []),
            ],
          },
        )
        extraRunnerGhcrMigrations.push(migration)
        previousRunnerSecretMigration = migration
      }
    }

    // Register the extra runners with the control plane once the API is healthy.
    // Idempotent (treats HTTP 409 as success), so redeploys are safe; only re-runs
    // when the API URL or the runner set changes.
    if (extraRunners.length > 0) {
      const runnersPayload = $resolve(extraRunners.map((r) => r.apiKey.result)).apply((keys) =>
        JSON.stringify(extraRunners.map((r, i) => ({ name: r.name, apiKey: keys[i] }))),
      )
      const registerRunnersCommand =
        'ADMIN_API_KEY="$("$AWS_CLI_PATH" secretsmanager get-secret-value --region "$AWS_REGION" ' +
        '--secret-id "$ADMIN_API_KEY_SECRET_ARN" --query SecretString --output text)" && ' +
        '[ -n "$ADMIN_API_KEY" ] && [ "$ADMIN_API_KEY" != "None" ] && ' +
        '[ "$ADMIN_API_KEY" != "unused" ] && export ADMIN_API_KEY && node scripts/register-runners.mjs'
      new command.local.Command(
        'RegisterExtraRunners',
        {
          // `dir` is required: command.local.Command runs from the Pulumi
          // process's cwd (.sst/platform), not the app root, so a bare
          // `scripts/...` resolves to .sst/platform/scripts and fails with
          // "Cannot find module". $cli.paths.root is the same anchor SST uses
          // for user-relative paths (platform/src/components/component.ts).
          dir: $cli.paths.root,
          create: registerRunnersCommand,
          update: registerRunnersCommand,
          environment: {
            API_URL: api.url,
            ADMIN_API_KEY_SECRET_ARN: runtimeSecretArn('adminApiKey'),
            AWS_CLI_PATH: process.env.AWS_CLI_PATH || 'aws',
            AWS_REGION: REGION,
            REGION_ID: envOr('DEFAULT_REGION_ID', 'us'),
            RUNNERS: runnersPayload,
          },
          triggers: [
            api.url,
            runnersPayload,
            runtimeSecretGeneration(runtimeSecretGenerations, 'adminApiKey'),
          ],
        },
        { dependsOn: extraRunners.map((r) => r.instance) },
      )
    }

    // ── Rolling runner binary upgrade ────────────────────────────────────────
    // ignoreChanges ['userDataBase64'] above means a Cargo.toml version bump never
    // reaches a running runner, so these commands land it over SSM instead — the EC2
    // and the box state on it are never replaced.
    //
    // Rolling is meant to be structural rather than scripted: each command handles
    // exactly one instance and dependsOn the previous one, so the dependency graph — not
    // any logic in the script — is what should keep two runners from restarting at once,
    // and a failure should stop the chain with the unvisited hosts still serving.
    //
    // `triggers` REPLACES the command rather than updating it, so `create` is the body
    // that re-runs on a version bump (@pulumi/command documents this) — hence create and
    // update are the same script. The script converges rather than reinstalls: it leaves
    // alone a runner already on the target version, one whose binary/unit are not in place
    // yet (its user-data is installing this same version), and one serving something NEWER
    // than Cargo.toml declares — that last case is refused, not silently reverted, so a
    // deliberate hand-install survives an unrelated deploy (ALLOW_DOWNGRADE=1 forces it).
    // That second guard is what keeps the create-time run on a brand-new runner from
    // fighting cloud-init: this resource only depends on the instance reaching `running`,
    // which happens long before cloud-init finishes. The deployer side of the same race —
    // SendCommand being rejected until the SSM agent registers — is handled by a bounded
    // retry in the script, since no host-side guard can see it.
    //
    // In build mode the version string does not move between two commits, so what re-runs the
    // command is the commit itself; the script's convergence guard compares the same identity.
    //
    // Typed as a bare Resource because the chain only needs something to depend on.
    const runnerTargetVersion = runnerArtifactSource.version
    const runnerArtifactTrigger =
      runnerArtifactSource.kind === 'build'
        ? `build:${runnerArtifactSource.version}:${runnerArtifactSource.ref}`
        : `release:${runnerArtifactSource.version}`
    // Declared only when the Runner is in scope. `--exclude Runner` keeps the instance out of the
    // plan but not these — they are siblings of it, not children, and SST is never passed
    // --exclude-dependents. Their trigger carries the deployed commit, so on an Api-only deploy
    // they would still fire and fetch runner/<sha>/ from S3 for a commit whose build-runner job
    // was skipped, and deployment-preview.mjs would not catch it: isRunnerLikeResource matches a
    // name against /^Runner(?:-|$)/ OR an aws:ec2/instance:Instance carrying Runner identity
    // tags, and this command satisfies neither arm of that disjunction.
    //
    // Undeclaring is a delete in Pulumi's model, which is the honest trade here: command.local
    // .Command has no `delete:` script, so the delete touches nothing on the host, and the next
    // full deploy recreates it — `create:` re-runs the same convergence-guarded script, a no-op
    // when the host already serves the target identity.
    // The profile migration rewrites and restarts the default unit. It must
    // finish before the binary roll so two sibling commands never mutate or
    // restart that same protected host concurrently.
    let previousUpgrade: $util.Resource | undefined = defaultRunnerRuntimeSecretMigration
    for (const { label, instance, artifactPolicy } of !deploysRunner
      ? []
      : [
          { label: 'default', instance: defaultRunner, artifactPolicy: runnerArtifactPolicy },
          ...extraRunners.map((r) => ({
            label: r.name,
            instance: r.instance,
            artifactPolicy: extraRunnerArtifactPolicy,
          })),
        ]) {
      previousUpgrade = new command.local.Command(
        `UpgradeRunnerBinary-${label}`,
        {
          dir: $cli.paths.root, // see RegisterExtraRunners above
          create: 'node scripts/runner-update-binary.mjs',
          update: 'node scripts/runner-update-binary.mjs',
          environment: {
            AWS_REGION: REGION,
            SST_STAGE: $app.stage,
            INSTANCE_IDS: instance.id,
            RUNNER_VERSION: runnerTargetVersion,
            RUNNER_PORT: String(PORTS.RUNNER),
            // The source selection, not the resolved URLs: the script runs the same resolver, so
            // `npm run runner:update` out of band lands the identical artifact.
            RUNNER_ARTIFACT_SOURCE: runnerArtifactSource.kind,
            RUNNER_ARTIFACT_BUCKET: artifactsBucketName,
            BOXLITE_ARTIFACT_REF: runnerArtifactSource.kind === 'build' ? runnerArtifactSource.ref : '',
          },
          triggers: [runnerArtifactTrigger, instance.id],
        },
        {
          // The artifact policy is a hard prerequisite, not a sibling: in build mode the payload
          // reads S3 with the instance role, so an upgrade started before the grant exists fails
          // AccessDenied and stops the roll. Pulumi has no implicit edge — the bucket reaches the
          // command as a plain string — so it is declared here.
          dependsOn: [
            instance,
            artifactPolicy,
            ...extraRunnerGhcrMigrations,
            ...(previousUpgrade ? [previousUpgrade] : []),
          ],
        },
      )
    }
  },
})

// ── runner bootstrap ─────────────────────────────────────────────────────────
// EC2 user-data: downloads prebuilt runner binary from GitHub Releases
// and runs it directly with BoxLite VM isolation.
async function buildRunnerUserData(input: {
  apiUrl: string
  token?: string
  tokenSecretArn?: string
  otelEndpoint: string
  awsRegion: string
  artifact: { tarballName: string; tarballUrl: string; checksumUrl: string; fetch: 'https' | 's3' }
  ghcrSecretArn?: string
  ghcrUsername?: string
}): Promise<string> {
  if (Boolean(input.token) === Boolean(input.tokenSecretArn)) {
    throw new Error('runner user data requires exactly one token or tokenSecretArn')
  }
  const { artifactFetchCommand } = await import('./scripts/runner-artifact.mjs')
  const tarballPath = `/tmp/${input.artifact.tarballName}`
  const fetchTarball = artifactFetchCommand(input.artifact, input.artifact.tarballUrl, tarballPath, input.awsRegion)
  const fetchChecksum = artifactFetchCommand(
    input.artifact,
    input.artifact.checksumUrl,
    '/tmp/runner.sha256',
    input.awsRegion,
  )

  const runnerTokenFetch = input.tokenSecretArn
    ? `
for i in 1 2 3 4 5; do
  BOXLITE_RUNNER_TOKEN=\$(aws secretsmanager get-secret-value --region "\$AWS_REGION" --secret-id "\$BOXLITE_RUNNER_TOKEN_SECRET_ARN" --query SecretString --output text 2>/dev/null || true)
  { [ -n "\$BOXLITE_RUNNER_TOKEN" ] && [ "\$BOXLITE_RUNNER_TOKEN" != "None" ] && [ "\$BOXLITE_RUNNER_TOKEN" != "unused" ]; } && break
  echo "runner token fetch attempt \$i failed; retrying in \$((i*5))s" >&2
  sleep \$((i*5))
done
if [ -z "\${BOXLITE_RUNNER_TOKEN:-}" ] || [ "\$BOXLITE_RUNNER_TOKEN" = "None" ] || [ "\$BOXLITE_RUNNER_TOKEN" = "unused" ]; then
  echo "FATAL: could not fetch the runner token; refusing to start" >&2
  exit 1
fi
export BOXLITE_RUNNER_TOKEN
`
    : ''
  const ghcrTokenFetch = input.ghcrSecretArn
    ? `
for i in 1 2 3 4 5; do
  GHCR_TOKEN=\$(aws secretsmanager get-secret-value --region "\$AWS_REGION" --secret-id "\$GHCR_SECRET_ARN" --query SecretString --output text 2>/dev/null || true)
  { [ -n "\$GHCR_TOKEN" ] && [ "\$GHCR_TOKEN" != "None" ] && [ "\$GHCR_TOKEN" != "unused" ]; } && break
  echo "ghcr token fetch attempt \$i failed; retrying in \$((i*5))s" >&2
  sleep \$((i*5))
done
if [ -z "\${GHCR_TOKEN:-}" ] || [ "\$GHCR_TOKEN" = "None" ] || [ "\$GHCR_TOKEN" = "unused" ]; then
  echo "FATAL: could not fetch ghcr pull token; refusing to start with anonymous pulls" >&2
  exit 1
fi
export GHCR_TOKEN
`
    : ''
  const runtimeSecretBlock = input.tokenSecretArn || input.ghcrSecretArn
    ? `
# ── rotation-capable runtime credential setup ────────────────────────────────
cat > /usr/local/bin/boxlite-runner-start.sh << 'STARTWRAP'
#!/bin/bash
set -euo pipefail
${runnerTokenFetch}${ghcrTokenFetch}
exec /usr/local/bin/boxlite-runner
STARTWRAP
chmod +x /usr/local/bin/boxlite-runner-start.sh
`
    : ''

  const script = `#!/bin/bash
exec > /var/log/runner-setup.log 2>&1
# Fail fast + loud: a half-finished bootstrap must not leave a runner that looks
# up but silently skipped the binary download or its checksum verification.
set -euo pipefail

# Wait for dpkg locks
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 5; done

apt-get update
apt-get install -y curl

# Install Mountpoint for Amazon S3, used by volume mounts
MOUNT_S3_VERSION=1.20.0
MOUNT_S3_ARCH=x86_64
curl -fsSL "https://s3.amazonaws.com/mountpoint-s3-release/\${MOUNT_S3_VERSION}/\${MOUNT_S3_ARCH}/mount-s3-\${MOUNT_S3_VERSION}-\${MOUNT_S3_ARCH}.deb" -o /tmp/mount-s3.deb
apt-get install -y /tmp/mount-s3.deb
rm -f /tmp/mount-s3.deb

# AWS CLI v2. Needed unconditionally rather than only by the paths that use it here: a host
# created while the stack pointed at a published release can later be upgraded to a binary
# staged in S3, and that upgrade runs over SSM with no chance to install anything first.
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
apt-get install -y unzip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install --update
rm -rf /tmp/awscliv2.zip /tmp/aws

# Download the runner binary, then verify its SHA-256 against the checksum published
# alongside it before installing (it runs as root). A missing, malformed, or mismatched
# checksum is fatal. Where the two come from — a published release or a build staged in the
# stack's artifacts bucket — is decided by scripts/runner-artifact.mjs, not here.
RUNNER_TARBALL="${input.artifact.tarballName}"
${fetchTarball}
${fetchChecksum}
EXPECTED=\$(awk -v name="\$RUNNER_TARBALL" '\$2 == name || \$2 == "*" name {print \$1}' /tmp/runner.sha256)
[ -n "\$EXPECTED" ] || { echo "FATAL: checksum manifest does not name \$RUNNER_TARBALL" >&2; exit 1; }
[[ "\$EXPECTED" =~ ^[0-9a-f]{64}\$ ]] || { echo "FATAL: invalid runner checksum file" >&2; exit 1; }
ACTUAL=\$(sha256sum "${tarballPath}" | awk '{print \$1}')
[ "\$EXPECTED" = "\$ACTUAL" ] || { echo "FATAL: runner checksum mismatch (want \$EXPECTED got \$ACTUAL)" >&2; exit 1; }
echo "runner tarball checksum verified (\$ACTUAL)"
tar -xzf "${tarballPath}" -C /usr/local/bin/
rm -f "${tarballPath}" /tmp/runner.sha256
chmod +x /usr/local/bin/boxlite-runner

# Get host IP via IMDSv2
IMDS_TOKEN=\$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
HOST_IP=\$(curl -s -H "X-aws-ec2-metadata-token: \$IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
${runtimeSecretBlock}
# Create systemd service for the BoxLite runner
cat > /etc/systemd/system/boxlite-runner.service << UNIT
[Unit]
Description=BoxLite Runner
After=network.target

[Service]
Type=simple
ExecStart=${input.tokenSecretArn || input.ghcrSecretArn ? '/usr/local/bin/boxlite-runner-start.sh' : '/usr/local/bin/boxlite-runner'}
Restart=always
RestartSec=5
# Give the runner time to gracefully stop all VMs on SIGTERM (it budgets 30s
# internally via Client.Shutdown(); 60s here leaves headroom for in-flight
# HTTP handlers + the deferred Close).
TimeoutStopSec=60
Environment=BOXLITE_API_URL=${input.apiUrl.replace(/\/$/, '')}/api
${
    input.tokenSecretArn
      ? `Environment=BOXLITE_RUNNER_TOKEN_SECRET_ARN=${input.tokenSecretArn}`
      : `Environment=BOXLITE_RUNNER_TOKEN=${input.token}`
  }
Environment=API_VERSION=2
Environment=API_PORT=${PORTS.RUNNER}
Environment=RUNNER_DOMAIN=\$HOST_IP
Environment=BOXLITE_HOME_DIR=/var/lib/boxlite
Environment=AWS_REGION=${input.awsRegion}
Environment=OTEL_LOGGING_ENABLED=true
Environment=OTEL_TRACING_ENABLED=true
Environment=OTEL_EXPORTER_OTLP_ENDPOINT=${input.otelEndpoint}${
    input.ghcrSecretArn
      ? `
# ghcr: username + secret ARN are non-secret; the start-wrapper fetches the TOKEN at runtime.
Environment=GHCR_USERNAME=${input.ghcrUsername ?? ''}
Environment=GHCR_SECRET_ARN=${input.ghcrSecretArn}`
      : ''
  }

[Install]
WantedBy=multi-user.target
UNIT

mkdir -p /var/lib/boxlite
systemctl daemon-reload
systemctl enable boxlite-runner
systemctl start boxlite-runner

echo "Runner setup complete"
`
  return Buffer.from(script).toString('base64')
}
