// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// Modified and rebranded for BoxLite

/// <reference path="./.sst/platform/config.d.ts" />

// ─────────────────────────────────────────────────────────────────────────────
// BoxLite control plane on AWS (ap-southeast-1).
//
// Top of file: constants + helpers + the runner user-data builder.
// Inside `run()`, resources are created in deploy order:
//
//   1. secrets (auto-generated)     6. API
//   2. platform (VPC/DB/Redis/S3)   7. edge services (Proxy, SshGateway)
//   3. IAM                          8. admin UIs (PgAdmin/MailDev)
//   4. auth (external OIDC)         9. CDN (CloudFront)
//   5. observability               10. runner (EC2 + nested KVM)
// ─────────────────────────────────────────────────────────────────────────────

const REGION = 'ap-southeast-1'

// Container ports each service listens on internally
const PORTS = {
  API: 3000,
  PROXY: 4000,
  SSH_GATEWAY: 2222,
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

// OIDC issuer URL — must be set (Auth0, Okta, etc.). No default.
const requireOidcIssuer = () => {
  const v = process.env.OIDC_ISSUER_BASE_URL
  if (!v) throw new Error('OIDC_ISSUER_BASE_URL is required (e.g. https://<tenant>.auth0.com/)')
  return v
}

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
const runnerEndpoint = (override: string, port: number, scheme: string) =>
  envOr(override, `${scheme}localhost:${port}`)

// ── app config ───────────────────────────────────────────────────────────────
export default $config({
  app(input) {
    return {
      name: 'boxlite',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      home: 'aws',
      providers: {
        aws: { region: REGION, ...(process.env.AWS_PROFILE ? { profile: process.env.AWS_PROFILE } : {}) },
        cloudflare: '6.15.0',
        random: '4.16.6',
        // command provider: multi-runner post-deploy registration
        // (see RegisterExtraRunners in run()).
        command: '1.0.1',
      },
    }
  },

  async run() {
    // Load .env overrides (anything unset falls back to auto-generated values)
    const { config } = await import('dotenv')
    config()


    // Strip trailing slash from service.url so path concat produces clean URLs
    // (api.url = "https://api.dev.boxlite.ai/" → apiBase = "https://api.dev.boxlite.ai").
    const stripTrailingSlash = (url: $util.Output<string>) => url.apply((u) => (u.endsWith('/') ? u.slice(0, -1) : u))

    const clickHouseWriterEndpoint =
      process.env.CLICKHOUSE_WRITER_ENDPOINT || process.env.CLICKHOUSE_ENDPOINT || process.env.CLICKHOUSE_OTEL_ENDPOINT
    const clickHouseWriterPassword = process.env.CLICKHOUSE_WRITER_PASSWORD || process.env.CLICKHOUSE_PASSWORD
    const clickHouseReaderUrl = process.env.CLICKHOUSE_READER_URL || process.env.CLICKHOUSE_URL
    const clickHouseReaderHost = process.env.CLICKHOUSE_READER_HOST || process.env.CLICKHOUSE_HOST
    const clickHouseExporterEnabled = process.env.CLICKHOUSE_EXPORTER_ENABLED === 'true'
    if (clickHouseExporterEnabled && !clickHouseWriterEndpoint) {
      throw new Error('CLICKHOUSE_WRITER_ENDPOINT or CLICKHOUSE_ENDPOINT is required when CLICKHOUSE_EXPORTER_ENABLED=true')
    }
    if (clickHouseExporterEnabled && !clickHouseWriterPassword) {
      throw new Error('CLICKHOUSE_WRITER_PASSWORD or CLICKHOUSE_PASSWORD is required when CLICKHOUSE_EXPORTER_ENABLED=true')
    }
    const collectorExporters = clickHouseExporterEnabled ? '[boxlite_exporter,clickhouse]' : '[boxlite_exporter]'

    // HTTPS everywhere: the Router CloudFront Function deletes customOriginConfig
    // for http origins and CF then falls back to match-viewer (→ tries HTTPS on a
    // port-80-only ALB → 502). We side-step that by giving Api and Dex ALBs
    // HTTPS listeners with a wildcard ACM cert, so Router routes to https://
    // origins and the non-buggy branch runs.
    const stackDomain = process.env.STACK_DOMAIN
    if (!stackDomain) {
      throw new Error('STACK_DOMAIN is required (Cloudflare-managed subdomain, e.g. dev.boxlite.ai)')
    }
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
    const sshGatewayApiKey = randomKey('SshGatewayApiKey')
    const adminApiKey = randomKey('AdminApiKey')
    const defaultRunnerApiKey = randomKey('DefaultRunnerApiKey')
    const pgAdminPassword = randomKey('PgAdminPassword', 24)

    // App secrets — set via `sst secret set <NAME> --stage <stage>` (or bulk
    // `sst secret load <dotenv>`); stored encrypted in SST state and shared
    // per-stage by anyone with deploy access. Names match the env keys so a
    // dotenv `sst secret load` maps 1:1. Optional ones carry an empty-string
    // placeholder, so "unset" reads as '' — the same "empty = off" contract the
    // SSH keys already relied on. NB: the Cloudflare provider creds can't live
    // here (the provider initializes in app() before run() exists); they're
    // injected from SSM by scripts/sst-with-cloudflare.mjs.
    const oidcClientId = new sst.Secret('OIDC_CLIENT_ID', 'boxlite')
    const oidcMgmtClientId = new sst.Secret('OIDC_MANAGEMENT_API_CLIENT_ID')
    const oidcMgmtClientSecret = new sst.Secret('OIDC_MANAGEMENT_API_CLIENT_SECRET')
    const posthogApiKey = new sst.Secret('POSTHOG_API_KEY', '')
    const svixAuthToken = new sst.Secret('SVIX_AUTH_TOKEN', '')
    const sshPrivateKey = new sst.Secret('SSH_PRIVATE_KEY_B64', '')
    const sshHostKey = new sst.Secret('SSH_HOST_KEY_B64', '')
    const stripeSecretKey = new sst.Secret('STRIPE_SECRET_KEY', '')
    const stripeWebhookSecret = new sst.Secret('STRIPE_WEBHOOK_SECRET', '')
    const stripePreviousWebhookSecret = new sst.Secret('STRIPE_WEBHOOK_SECRET_PREVIOUS', '')

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
    // delete — so production also gets RDS deletion-protection + a final snapshot.
    // S3 versioning is on in every stage: cheap, and the only guard against an
    // object-level overwrite/delete (which `removal` never covers). Redis is a
    // transient cache, so it needs neither.
    const isProd = $app.stage === 'production'
    const billingPaymentProvider = isProd
      ? requireEnv('BILLING_PAYMENT_PROVIDER', 'for production billing')
      : envOr('BILLING_PAYMENT_PROVIDER', 'fake')
    const subscriptionPrice = (key: string) =>
      billingPaymentProvider === 'stripe'
        ? requireEnv(key, 'when Stripe subscription billing is enabled')
        : envOr(key, '')
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
    // Internal ALB by default: the trace UI exposes every span (URLs, headers,
    // IDs, SQL, error bodies) with no auth, and nothing outside the VPC needs
    // to read it. Reach it via VPN / bastion / `aws ssm start-session`.
    // JAEGER_PUBLIC=true opts into an internet-facing ALB.
    const jaegerPublic = envOr('JAEGER_PUBLIC', 'false') === 'true'
    new sst.aws.Service('Jaeger', {
      cluster,
      image: IMAGES.jaeger,
      loadBalancer: { public: jaegerPublic, rules: [{ listen: '80/http', forward: `${PORTS.JAEGER_UI}/http` }] },
      environment: { COLLECTOR_OTLP_ENABLED: 'true' },
    })

    const otelCollector = new sst.aws.Service('OtelCollector', {
      cluster,
      image: { context: '../..', dockerfile: 'apps/otel-collector/Dockerfile', cache: false },
      command: [
        '--config',
        '/otelcol/collector-config.yaml',
        '--set',
        `service::pipelines::traces::exporters=${collectorExporters}`,
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
        CLICKHOUSE_ENDPOINT: clickHouseWriterEndpoint || 'https://clickhouse-disabled.invalid:443',
        CLICKHOUSE_DATABASE: envOr('CLICKHOUSE_WRITER_DATABASE', envOr('CLICKHOUSE_DATABASE', 'otel')),
        CLICKHOUSE_USERNAME: envOr('CLICKHOUSE_WRITER_USERNAME', envOr('CLICKHOUSE_USERNAME', 'default')),
        CLICKHOUSE_PASSWORD: clickHouseWriterPassword || 'unused',
        CLICKHOUSE_CREATE_SCHEMA: envOr('CLICKHOUSE_CREATE_SCHEMA', 'false'),
        CLICKHOUSE_COMPRESS: envOr('CLICKHOUSE_COMPRESS', 'none'),
        BOXLITE_API_URL: envOr('BOXLITE_API_URL', `https://api.${stackDomain}/api`),
        BOXLITE_API_KEY: envOr(
          'BOXLITE_API_KEY',
          envOr('OTEL_COLLECTOR_API_KEY', envOr('ADMIN_API_KEY', adminApiKey.result)),
        ),
      },
    })
    const otelCollectorOtlpHttpUrl = stripTrailingSlash(otelCollector.url).apply((url) => `${url}:${PORTS.OTLP_HTTP}`)

    // ─── 6. API (NestJS control plane) ───────────────────────────────────────
    const api = new sst.aws.Service('Api', {
      cluster,
      image: {
        context: '../..',
        dockerfile: 'apps/api/Dockerfile',
      },
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
          // DescribeLogGroups ignores log-group-name granularity, but scoping
          // the resource still cuts cross-region/cross-account reach. The
          // observability reader defaults to this region
          // (ADMIN_OBSERVABILITY_CLOUDWATCH_REGION).
          actions: ['logs:DescribeLogGroups'],
          resources: [
            $interpolate`arn:aws:logs:${REGION}:${aws.getCallerIdentityOutput().accountId}:log-group:*`,
          ],
        },
        {
          // Admin observability S3 reader + VolumeManager boot probe are
          // list-only on the storage bucket (ListObjectsV2).
          actions: ['s3:ListBucket'],
          resources: [storage.arn],
        },
        {
          actions: ['logs:FilterLogEvents'],
          resources: [
            $interpolate`arn:aws:logs:${REGION}:${aws.getCallerIdentityOutput().accountId}:log-group:/sst/cluster/${cluster.nodes.cluster.name}/*`,
            $interpolate`arn:aws:logs:${REGION}:${aws.getCallerIdentityOutput().accountId}:log-group:/sst/cluster/${cluster.nodes.cluster.name}/*:*`,
          ],
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
        // Core
        NODE_ENV: 'production',
        PORT: String(PORTS.API),
        ENVIRONMENT: 'production',
        RUN_MIGRATIONS: 'true',
        VERSION: '0.1.0',
        DEFAULT_REGION_ENFORCE_QUOTAS: 'false',
        DEFAULT_TEMPLATE: envOr('DEFAULT_TEMPLATE', 'boxlite/base'),
        BILLING_TRIAL_GRANT_CENTS: envOr('BILLING_TRIAL_GRANT_CENTS', '10000'),
        BILLING_TRIAL_DURATION_DAYS: envOr('BILLING_TRIAL_DURATION_DAYS', '30'),
        BILLING_ENFORCEMENT_ENABLED: envOr('BILLING_ENFORCEMENT_ENABLED', 'false'),
        BILLING_ENFORCEMENT_RISK_WINDOW_SECONDS: envOr('BILLING_ENFORCEMENT_RISK_WINDOW_SECONDS', '120'),
        BILLING_PAYMENT_PROVIDER: billingPaymentProvider,
        STRIPE_SECRET_KEY: stripeSecretKey.value,
        STRIPE_WEBHOOK_SECRET: stripeWebhookSecret.value,
        STRIPE_WEBHOOK_SECRET_PREVIOUS: stripePreviousWebhookSecret.value,
        STRIPE_SUBSCRIPTION_PRICE_STARTER: subscriptionPrice('STRIPE_SUBSCRIPTION_PRICE_STARTER'),
        STRIPE_SUBSCRIPTION_PRICE_PRO: subscriptionPrice('STRIPE_SUBSCRIPTION_PRICE_PRO'),
        STRIPE_SUBSCRIPTION_PRICE_MAX: subscriptionPrice('STRIPE_SUBSCRIPTION_PRICE_MAX'),
        // Box base images: only the three digest-pinned *_IMAGE refs below are live — the
        // API gates box creation to that curated set (apps/api curated-images.constant.ts)
        // and the runner pulls them straight from ghcr.io with its GHCR_TOKEN. IMAGE_TAG and
        // the SOURCE_REGISTRY_* block are inert Daytona-port residue (no consumer — see
        // apps/api configuration.ts), kept only as reserved names for a future registry path.
        BOXLITE_SYSTEM_IMAGE_TAG: envOr('BOXLITE_SYSTEM_IMAGE_TAG', '20260605-p0-r3'),
        BOXLITE_SYSTEM_BASE_IMAGE: envOr(
          'BOXLITE_SYSTEM_BASE_IMAGE',
          'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3',
        ),
        BOXLITE_SYSTEM_PYTHON_IMAGE: envOr(
          'BOXLITE_SYSTEM_PYTHON_IMAGE',
          'ghcr.io/boxlite-ai/boxlite-agent-python:20260605-p0-r3',
        ),
        BOXLITE_SYSTEM_NODE_IMAGE: envOr(
          'BOXLITE_SYSTEM_NODE_IMAGE',
          'ghcr.io/boxlite-ai/boxlite-agent-node:20260605-p0-r3',
        ),
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
        OIDC_ISSUER_BASE_URL: requireOidcIssuer(),
        ...(process.env.PUBLIC_OIDC_DOMAIN && {
          PUBLIC_OIDC_DOMAIN: process.env.PUBLIC_OIDC_DOMAIN,
        }),
        // Optional: Auth0 Management API (enables account linking etc.)
        ...(process.env.OIDC_MANAGEMENT_API_ENABLED === 'true' && {
          OIDC_MANAGEMENT_API_ENABLED: 'true',
          // Client id/secret come from the SST secret store now. If the feature
          // is enabled but a secret is unset, the value resolves to '' and the
          // Api errors at runtime — instead of the old deploy-time requireEnv
          // throw (Output values can't be guarded at config-build time).
          OIDC_MANAGEMENT_API_CLIENT_ID: oidcMgmtClientId.value,
          OIDC_MANAGEMENT_API_CLIENT_SECRET: oidcMgmtClientSecret.value,
          OIDC_MANAGEMENT_API_AUDIENCE: requireEnv('OIDC_MANAGEMENT_API_AUDIENCE', 'when OIDC_MANAGEMENT_API_ENABLED=true'),
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
        PROXY_DOMAIN: envOr('PROXY_DOMAIN', `proxy.${stackDomain}`),
        PROXY_PROTOCOL: envOr('PROXY_PROTOCOL', 'https'),
        PROXY_API_KEY: envOr('PROXY_API_KEY', proxyApiKey.result),
        PROXY_TEMPLATE_URL: envOr('PROXY_TEMPLATE_URL', `https://proxy.${stackDomain}`),

        // SSH Gateway — friendly hostname `ssh.<stackDomain>` is provisioned
        // as a Cloudflare CNAME pointing at the SshGateway NLB further below.
        SSH_GATEWAY_URL: envOr('SSH_GATEWAY_URL', `ssh://ssh.${stackDomain}:${PORTS.SSH_GATEWAY}`),
        SSH_GATEWAY_API_KEY: envOr('SSH_GATEWAY_API_KEY', sshGatewayApiKey.result),

        // Admin
        ADMIN_API_KEY: envOr('ADMIN_API_KEY', adminApiKey.result),

        // Observability read/write path. These stay server-side; never expose
        // ClickHouse credentials to the dashboard bundle.
        OTEL_ENABLED: envOr('OTEL_ENABLED', 'true'),
        OTEL_EXPORTER_OTLP_ENDPOINT: envOr('OTEL_EXPORTER_OTLP_ENDPOINT', otelCollectorOtlpHttpUrl),
        ...(process.env.OTEL_EXPORTER_OTLP_HEADERS && {
          OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
        }),
        ...(clickHouseReaderUrl
          ? {
              CLICKHOUSE_URL: clickHouseReaderUrl,
              CLICKHOUSE_DATABASE: envOr('CLICKHOUSE_READER_DATABASE', envOr('CLICKHOUSE_DATABASE', 'otel')),
              CLICKHOUSE_USERNAME: envOr('CLICKHOUSE_READER_USERNAME', envOr('CLICKHOUSE_USERNAME', 'default')),
              CLICKHOUSE_PASSWORD: envOr('CLICKHOUSE_READER_PASSWORD', envOr('CLICKHOUSE_PASSWORD', '')),
            }
          : clickHouseReaderHost
            ? {
                CLICKHOUSE_HOST: clickHouseReaderHost,
                CLICKHOUSE_PORT: envOr('CLICKHOUSE_READER_PORT', envOr('CLICKHOUSE_PORT', '443')),
                CLICKHOUSE_DATABASE: envOr('CLICKHOUSE_READER_DATABASE', envOr('CLICKHOUSE_DATABASE', 'otel')),
                CLICKHOUSE_USERNAME: envOr('CLICKHOUSE_READER_USERNAME', envOr('CLICKHOUSE_USERNAME', 'default')),
                CLICKHOUSE_PASSWORD: envOr('CLICKHOUSE_READER_PASSWORD', envOr('CLICKHOUSE_PASSWORD', '')),
                CLICKHOUSE_PROTOCOL: envOr('CLICKHOUSE_READER_PROTOCOL', envOr('CLICKHOUSE_PROTOCOL', 'https')),
              }
            : {}),
        BOX_OTEL_ENDPOINT_URL: envOr(
          'BOX_OTEL_ENDPOINT_URL',
          envOr('OTEL_EXPORTER_OTLP_ENDPOINT', otelCollectorOtlpHttpUrl),
        ),
        ADMIN_OBSERVABILITY_CLOUDWATCH_REGION: envOr('ADMIN_OBSERVABILITY_CLOUDWATCH_REGION', REGION),
        ADMIN_OBSERVABILITY_CLOUDWATCH_LOG_GROUPS: envOr('ADMIN_OBSERVABILITY_CLOUDWATCH_LOG_GROUPS', ''),
        ADMIN_OBSERVABILITY_CLOUDWATCH_LOG_GROUP_PREFIX: envOr(
          'ADMIN_OBSERVABILITY_CLOUDWATCH_LOG_GROUP_PREFIX',
          $interpolate`/sst/cluster/${cluster.nodes.cluster.name}/`,
        ),
        ADMIN_OBSERVABILITY_CLOUDWATCH_LIMIT_PER_GROUP: envOr('ADMIN_OBSERVABILITY_CLOUDWATCH_LIMIT_PER_GROUP', '25'),
        ADMIN_OBSERVABILITY_CLOUDWATCH_MAX_LOG_GROUPS: envOr('ADMIN_OBSERVABILITY_CLOUDWATCH_MAX_LOG_GROUPS', '20'),
        ADMIN_OBSERVABILITY_S3_REGION: envOr('ADMIN_OBSERVABILITY_S3_REGION', REGION),
        ADMIN_OBSERVABILITY_S3_BUCKETS: envOr('ADMIN_OBSERVABILITY_S3_BUCKETS', storage.name),
        ADMIN_OBSERVABILITY_S3_MAX_OBJECTS: envOr('ADMIN_OBSERVABILITY_S3_MAX_OBJECTS', '25'),
        ...(process.env.ADMIN_OBSERVABILITY_CLICKSTACK_URL && {
          ADMIN_OBSERVABILITY_CLICKSTACK_URL: process.env.ADMIN_OBSERVABILITY_CLICKSTACK_URL,
        }),
        ...(process.env.ADMIN_OBSERVABILITY_CLICKSTACK_DASHBOARD_URL && {
          ADMIN_OBSERVABILITY_CLICKSTACK_DASHBOARD_URL: process.env.ADMIN_OBSERVABILITY_CLICKSTACK_DASHBOARD_URL,
        }),
        ...(process.env.ADMIN_OBSERVABILITY_CLICKSTACK_LOG_SOURCE_ID && {
          ADMIN_OBSERVABILITY_CLICKSTACK_LOG_SOURCE_ID: process.env.ADMIN_OBSERVABILITY_CLICKSTACK_LOG_SOURCE_ID,
        }),
        ...(process.env.ADMIN_OBSERVABILITY_CLICKSTACK_TRACE_SOURCE_ID && {
          ADMIN_OBSERVABILITY_CLICKSTACK_TRACE_SOURCE_ID: process.env.ADMIN_OBSERVABILITY_CLICKSTACK_TRACE_SOURCE_ID,
        }),
        ...(process.env.ADMIN_OBSERVABILITY_CLICKSTACK_METRIC_SOURCE_ID && {
          ADMIN_OBSERVABILITY_CLICKSTACK_METRIC_SOURCE_ID: process.env.ADMIN_OBSERVABILITY_CLICKSTACK_METRIC_SOURCE_ID,
        }),

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
        DEFAULT_RUNNER_NAME: envOr('DEFAULT_RUNNER_NAME', 'default'),
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
    // Proxy: routes `<port>-<boxid>.proxy.<stack>` to the box port.
    // Wildcard cert covers *.proxy.<stack>; Cloudflare serves wildcard DNS.
    const proxyDomain = `proxy.${stackDomain}`
    new sst.aws.Service('Proxy', {
      cluster,
      image: { context: '../..', dockerfile: 'apps/proxy/Dockerfile', cache: false },
      loadBalancer: {
        domain: {
          name: proxyDomain,
          aliases: [`*.${proxyDomain}`],
          dns: cloudflareDns,
        },
        rules: [{ listen: '443/https', forward: `${PORTS.PROXY}/http` }],
        health: { [`${PORTS.PROXY}/http`]: httpHealth('/health') },
      },
      // Same reasoning as the Api LB: bump idle to 1h so dashboard iframe
      // terminals (https://22222-<sbx>.proxy.<stack>/) survive idle pauses
      // until the runner-side keepalive in handleWebSocketTerminal lands.
      transform: {
        loadBalancer: (lbArgs) => {
          lbArgs.idleTimeout = 3600
        },
      },
      environment: {
        PROXY_PORT: String(PORTS.PROXY),
        PROXY_PROTOCOL: envOr('PROXY_PROTOCOL', 'http'),
        PROXY_API_KEY: envOr('PROXY_API_KEY', proxyApiKey.result),
        // api-client-go appends paths like "/config" directly → include /api suffix
        BOXLITE_API_URL: $interpolate`${stripTrailingSlash(api.url)}/api`,
        OIDC_CLIENT_ID: oidcClientId.value,
        OIDC_AUDIENCE: envOr('OIDC_AUDIENCE', 'boxlite'),
        OIDC_DOMAIN: requireOidcIssuer(),
      },
    })

    // SSH Gateway: `ssh <box>@ssh.<stackDomain>:2222` proxies to the box.
    // The NLB has no domain field (TCP listeners don't take ACM certs); instead we
    // attach a Cloudflare CNAME directly via cloudflareDns.createAlias below so users
    // get a stable, memorable hostname instead of the auto-generated NLB DNS name.
    const sshGateway = new sst.aws.Service('SshGateway', {
      cluster,
      image: { context: '../..', dockerfile: 'apps/ssh-gateway/Dockerfile', cache: false },
      loadBalancer: { rules: [{ listen: `${PORTS.SSH_GATEWAY}/tcp`, forward: `${PORTS.SSH_GATEWAY}/tcp` }] },
      environment: {
        // api-client-go composes paths like "/box/ssh-access/validate" directly.
        // The Nest control plane is globally mounted under /api, so the gateway
        // must use the API base path rather than the raw ALB root.
        API_URL: $interpolate`${stripTrailingSlash(api.url)}/api`,
        API_KEY: envOr('SSH_GATEWAY_API_KEY', sshGatewayApiKey.result), // NB: not SSH_GATEWAY_API_KEY
        SSH_PRIVATE_KEY: sshPrivateKey.value,
        SSH_HOST_KEY: sshHostKey.value,
      },
    })

    cloudflareDns.createAlias(
      'SshGateway',
      {
        name: `ssh.${stackDomain}`,
        aliasName: sshGateway.nodes.loadBalancer.dnsName,
        aliasZone: sshGateway.nodes.loadBalancer.zoneId,
      },
      {},
    )

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
        PGADMIN_DEFAULT_EMAIL: envOr('PGADMIN_DEFAULT_EMAIL', 'admin@boxlite.dev'),
        PGADMIN_DEFAULT_PASSWORD: envOr('PGADMIN_DEFAULT_PASSWORD', pgAdminPassword.result),
        // Server mode enables the login screen (desktop mode skips auth
        // entirely); master password gates saved server credentials.
        PGADMIN_CONFIG_SERVER_MODE: pgAdminServerMode,
        PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED: pgAdminMasterPassword,
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
    })

    // ─── 9. CDN ROUTES ───────────────────────────────────────────────────────
    // Router (declared in section 4) fronts the Api with HTTPS.
    router.route('/', api.url)

    // ─── 10. RUNNER (EC2 with nested KVM) ────────────────────────────────────
    // Boots an Ubuntu EC2 that runs the prebuilt runner binary (downloaded from
    // GitHub Releases) under systemd, with nested KVM enabled for box VMs.
    const ubuntuAmi = aws.ec2.getAmi({
      mostRecent: true,
      owners: [RUNNER.ubuntuOwnerId],
      filters: [
        { name: 'name', values: [RUNNER.ubuntuNamePattern] },
        { name: 'architecture', values: ['x86_64'] },
      ],
    })

    const runnerRole = new aws.iam.Role('RunnerRole', {
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      }),
    })
    new aws.iam.RolePolicyAttachment('RunnerSsmPolicy', {
      role: runnerRole.name,
      policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
    })
    new aws.iam.RolePolicy('RunnerVolumeS3Policy', {
      role: runnerRole.name,
      policy: JSON.stringify({
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
      }),
    })
    const runnerInstanceProfile = new aws.iam.InstanceProfile('RunnerProfile', { role: runnerRole.name })

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

    // ── Runner ghcr pull credential (private image access) ────────────────────
    // Runners pull box images straight from private ghcr.io (the self-hosted
    // registry was removed). The pull TOKEN is stored in Secrets Manager and
    // fetched by each runner at boot via its instance-role — NOT baked into
    // user-data/IMDS — so scaled-out runners pick it up automatically and a
    // rotated token only needs a secret update + a runner restart. The username
    // (a non-secret bot account) is baked directly. Env-gated: set GHCR_TOKEN
    // (+ GHCR_USERNAME) in apps/infra/.env to enable; unset = no ghcr auth wired.
    const ghcrUsername = process.env.GHCR_USERNAME?.trim() || ''
    const ghcrToken = process.env.GHCR_TOKEN?.trim() || ''
    const ghcrSecret =
      ghcrUsername && ghcrToken
        ? // 7-day recovery window: an accidental delete during rotation is undoable
          // (vs 0 = immediate, irreversible — which would break all runner image pulls).
          new aws.secretsmanager.Secret('GhcrPullToken', { recoveryWindowInDays: 7 })
        : undefined
    if (ghcrSecret) {
      new aws.secretsmanager.SecretVersion('GhcrPullTokenValue', {
        secretId: ghcrSecret.id,
        secretString: $util.secret(ghcrToken),
      })
      new aws.iam.RolePolicy('RunnerGhcrSecretPolicy', {
        role: runnerRole.name,
        policy: ghcrSecret.arn.apply((arn) =>
          JSON.stringify({
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: arn }],
          }),
        ),
      })
    }

    const runnerUserData = $resolve([
      api.url,
      defaultRunnerApiKey.result,
      otelCollectorOtlpHttpUrl,
      ghcrSecret ? ghcrSecret.arn : '',
    ]).apply(([apiUrl, token, otelEndpoint, ghcrSecretArn]) =>
      buildRunnerUserData({ apiUrl, token, otelEndpoint, ghcrSecretArn: ghcrSecretArn || undefined, ghcrUsername }),
    )

    // Runners hold load-bearing box state (/var/lib/boxlite + in-memory libkrun VMs).
    // The default runner and every extra runner are identical except for resource
    // name, Name tag, and per-runner user-data, so they share one factory. Two Pulumi
    // options keep a runner persistent across routine deploys:
    //   • ignoreChanges ['ami','userDataBase64']: monthly Ubuntu AMIs and Cargo.toml
    //     version bumps no longer force replacement; a new binary lands out-of-band via
    //     SSM instead of recreating the EC2 — scripts/deploy/runner-update-binary.sh
    //     upgrades the DEFAULT runner (matches its tag only); extra runners separately.
    //   • protect: refuses any delete (errant `pulumi destroy` / teardown). Deliberate
    //     decommission = set protect:false, deploy, then `pulumi destroy --target ...`.
    const makeRunner = (resourceName: string, nameTag: string, userData: $util.Input<string>) =>
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
          iamInstanceProfile: runnerInstanceProfile.name,
          cpuOptions: { nestedVirtualization: 'enabled' },
          // Enforce IMDSv2 + a 1-hop limit so a container escape or SSRF on this
          // untrusted-code host can't read the instance-role creds (S3
          // boxlite-volume-*, the ghcr token in Secrets Manager, SSM).
          metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1 },
          userDataBase64: userData,
          rootBlockDevice: { volumeSize: RUNNER.rootDiskGB },
          tags: { Name: nameTag },
        },
        {
          ignoreChanges: ['ami', 'userDataBase64'],
          protect: true,
        },
      )

    // Default runner — auto-seeded by the API at boot via DEFAULT_RUNNER_*.
    // Pulumi resource id stays 'Runner' (renaming it would replace a protect:true
    // instance); only the AWS Name tag carries the explicit `-default` suffix.
    makeRunner('Runner', 'boxlite-runner-default', runnerUserData)

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
    const totalRunners = Math.max(1, parseInt(envOr('RUNNERS', '1'), 10) || 1)
    const extraRunners = Array.from({ length: totalRunners - 1 }, (_, i) => {
      const index = i + 2 // default runner is #1, so extras start at #2
      const name = `runner-${index}` // control-plane registration name
      const apiKey = randomKey(`RunnerApiKey-${name}`)
      // Resource id stays `Runner-runner-N` (stable — these are protect:true);
      // only the AWS Name tag takes the cleaner `boxlite-runner-N` form.
      const instance = makeRunner(
        `Runner-${name}`,
        `boxlite-runner-${index}`,
        $resolve([api.url, apiKey.result, otelCollectorOtlpHttpUrl, ghcrSecret ? ghcrSecret.arn : '']).apply(
          ([apiUrl, token, otelEndpoint, ghcrSecretArn]) =>
            buildRunnerUserData({ apiUrl, token, otelEndpoint, ghcrSecretArn: ghcrSecretArn || undefined, ghcrUsername }),
        ),
      )
      return { name, apiKey, instance }
    })

    // Register the extra runners with the control plane once the API is healthy.
    // Idempotent (treats HTTP 409 as success), so redeploys are safe; only re-runs
    // when the API URL or the runner set changes.
    if (extraRunners.length > 0) {
      const runnersPayload = $resolve(extraRunners.map((r) => r.apiKey.result)).apply((keys) =>
        JSON.stringify(extraRunners.map((r, i) => ({ name: r.name, apiKey: keys[i] }))),
      )
      new command.local.Command(
        'RegisterExtraRunners',
        {
          create: 'node scripts/register-runners.mjs',
          update: 'node scripts/register-runners.mjs',
          environment: {
            API_URL: api.url,
            ADMIN_API_KEY: adminApiKey.result,
            REGION_ID: envOr('DEFAULT_REGION_ID', 'us'),
            RUNNERS: runnersPayload,
          },
          triggers: [api.url, runnersPayload],
        },
        { dependsOn: extraRunners.map((r) => r.instance) },
      )
    }
  },
})

// ── runner bootstrap ─────────────────────────────────────────────────────────
// EC2 user-data: downloads prebuilt runner binary from GitHub Releases
// and runs it directly with BoxLite VM isolation.
async function buildRunnerUserData(input: {
  apiUrl: string
  token: string
  otelEndpoint: string
  ghcrSecretArn?: string
  ghcrUsername?: string
}): Promise<string> {
  const { readFileSync } = await import('fs')
  const { resolve } = await import('path')

  // SST invokes from apps/infra/ as cwd; Cargo.toml lives at repo root.
  const cargoToml = readFileSync(resolve(process.cwd(), '../../Cargo.toml'), 'utf-8')
  const versionMatch = cargoToml.match(/^version\s*=\s*"(.+?)"/m)
  if (!versionMatch) {
    throw new Error('could not parse runner version from ../../Cargo.toml (expected a top-level `version = "X.Y.Z"`)')
  }
  const RUNNER_VERSION = versionMatch[1]

  // ghcr pull credential delivery (option B, rotation-capable): install AWS CLI v2
  // and write a start-wrapper that re-fetches the TOKEN from Secrets Manager on
  // EVERY service start — so `systemctl restart` picks up a rotated token — and is
  // fail-CLOSED (refuses to run with anonymous pulls) with a bounded retry for
  // instance-profile IAM propagation at first boot. The wrapper is exec'd as
  // ExecStart; username + secret ARN + region come from the unit's Environment=.
  // Only emitted when a ghcr secret is wired; the TOKEN is never baked into user-data.
  const ghcrBlock = input.ghcrSecretArn
    ? `
# ── ghcr pull credential setup: AWS CLI v2 + fail-closed start-wrapper ────────
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
apt-get install -y unzip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install --update
rm -rf /tmp/awscliv2.zip /tmp/aws
cat > /usr/local/bin/boxlite-runner-start.sh << 'STARTWRAP'
#!/bin/bash
# Re-fetch the ghcr pull token on every start (rotation), fail-closed (no anonymous
# pulls), bounded retry for instance-profile IAM propagation. GHCR_USERNAME /
# GHCR_SECRET_ARN / AWS_REGION come from the systemd Environment.
set -o pipefail
if [ -n "\${GHCR_SECRET_ARN:-}" ]; then
  for i in 1 2 3 4 5; do
    GHCR_TOKEN=\$(aws secretsmanager get-secret-value --region "\$AWS_REGION" --secret-id "\$GHCR_SECRET_ARN" --query SecretString --output text 2>/dev/null)
    { [ -n "\$GHCR_TOKEN" ] && [ "\$GHCR_TOKEN" != "None" ]; } && break
    echo "ghcr token fetch attempt \$i failed; retrying in \$((i*5))s" >&2
    sleep \$((i*5))
  done
  if [ -z "\${GHCR_TOKEN:-}" ] || [ "\$GHCR_TOKEN" = "None" ]; then
    echo "FATAL: could not fetch ghcr pull token from \$GHCR_SECRET_ARN; refusing to start with anonymous pulls" >&2
    exit 1
  fi
  export GHCR_TOKEN
fi
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

# Download the prebuilt runner binary, then verify its SHA-256 against the
# checksum published next to the release asset before installing (it runs as
# root). Best-effort for backward compatibility: a release with no .sha256 asset
# warns and proceeds; a present-but-mismatched checksum is fatal (fail-closed).
RUNNER_BASE="https://github.com/boxlite-ai/boxlite/releases/download/v${RUNNER_VERSION}"
RUNNER_TARBALL="boxlite-runner-v${RUNNER_VERSION}-linux-amd64.tar.gz"
curl -fsSL "\${RUNNER_BASE}/\${RUNNER_TARBALL}" -o "/tmp/\${RUNNER_TARBALL}"
if curl -fsSL "\${RUNNER_BASE}/\${RUNNER_TARBALL}.sha256" -o /tmp/runner.sha256; then
  EXPECTED=\$(awk '{print \$1}' /tmp/runner.sha256)
  ACTUAL=\$(sha256sum "/tmp/\${RUNNER_TARBALL}" | awk '{print \$1}')
  [ "\$EXPECTED" = "\$ACTUAL" ] || { echo "FATAL: runner checksum mismatch (want \$EXPECTED got \$ACTUAL)" >&2; exit 1; }
  echo "runner tarball checksum verified (\$ACTUAL)"
else
  echo "WARNING: no .sha256 published for v${RUNNER_VERSION}; installing without integrity verification" >&2
fi
tar -xzf "/tmp/\${RUNNER_TARBALL}" -C /usr/local/bin/
rm -f "/tmp/\${RUNNER_TARBALL}" /tmp/runner.sha256
chmod +x /usr/local/bin/boxlite-runner

# Get host IP via IMDSv2
IMDS_TOKEN=\$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
HOST_IP=\$(curl -s -H "X-aws-ec2-metadata-token: \$IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
${ghcrBlock}
# Create systemd service for the BoxLite runner
cat > /etc/systemd/system/boxlite-runner.service << UNIT
[Unit]
Description=BoxLite Runner
After=network.target

[Service]
Type=simple
ExecStart=${input.ghcrSecretArn ? '/usr/local/bin/boxlite-runner-start.sh' : '/usr/local/bin/boxlite-runner'}
Restart=always
RestartSec=5
# Give the runner time to gracefully stop all VMs on SIGTERM (it budgets 30s
# internally via Client.Shutdown(); 60s here leaves headroom for in-flight
# HTTP handlers + the deferred Close).
TimeoutStopSec=60
Environment=BOXLITE_API_URL=${input.apiUrl.replace(/\/$/, '')}/api
Environment=BOXLITE_RUNNER_TOKEN=${input.token}
Environment=API_VERSION=2
Environment=API_PORT=${PORTS.RUNNER}
Environment=RUNNER_DOMAIN=\$HOST_IP
Environment=BOXLITE_HOME_DIR=/var/lib/boxlite
Environment=AWS_REGION=${REGION}
Environment=OTEL_LOGGING_ENABLED=true
Environment=OTEL_TRACING_ENABLED=true
Environment=OTEL_EXPORTER_OTLP_ENDPOINT=${input.otelEndpoint}${input.ghcrSecretArn ? `
# ghcr: username + secret ARN are non-secret; the start-wrapper fetches the TOKEN at runtime.
Environment=GHCR_USERNAME=${input.ghcrUsername ?? ''}
Environment=GHCR_SECRET_ARN=${input.ghcrSecretArn}` : ''}

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
