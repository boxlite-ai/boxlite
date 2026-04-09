// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 Daytona Platforms Inc.
// Modified and rebranded for BoxLite

/// <reference path="./.sst/platform/config.d.ts" />

// ─────────────────────────────────────────────────────────────────────────────
// BoxLite control plane on AWS (ap-southeast-1).
//
// Top of file: constants + helpers + the runner user-data builder.
// Inside `run()`, resources are created in deploy order:
//
//   1. secrets (auto-generated)     7. edge services (Proxy, SshGateway)
//   2. platform (VPC/DB/Redis/S3)   8. observability (Jaeger, OtelCollector)
//   3. IAM                          9. admin UIs (PgAdmin/RegistryUI/MailDev)
//   4. auth (Dex)                  10. CDN (CloudFront)
//   5. registry (SnapshotManager)  11. runner (EC2 + nested KVM)
//   6. API
// ─────────────────────────────────────────────────────────────────────────────

const REGION = "ap-southeast-1";

// Container ports each service listens on internally
const PORTS = {
  API: 3000,
  PROXY: 4000,
  SSH_GATEWAY: 2222,
  DEX: 5556,
  SNAPSHOT_MANAGER: 5000,
  RUNNER: 3003,
  JAEGER_UI: 16686,
  OTLP_HTTP: 4318,
  OTEL_HEALTH: 13133,
  MAILDEV_UI: 1080,
  PGADMIN: 80,
  REGISTRY_UI: 80,
} as const;

// Pinned third-party images
const IMAGES = {
  jaeger: "jaegertracing/all-in-one:1.67.0",
  pgadmin: "dpage/pgadmin4:9.2.0",
  registryUi: "joxit/docker-registry-ui:main",
  maildev: "maildev/maildev:latest",
} as const;

// Runner EC2 sizing
const RUNNER = {
  instanceType: "c8i.2xlarge",
  rootDiskGB: 100,
  ubuntuOwnerId: "099720109477",
  ubuntuNamePattern: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
} as const;

// ALB target-group health check defaults
const HEALTH_DEFAULTS = {
  interval: "30 seconds",
  timeout: "5 seconds",
  healthyThreshold: 2,
  unhealthyThreshold: 3,
} as const;

// Shared CloudFront origin + cache-behavior boilerplate
const CDN_ORIGIN_TIMEOUTS = {
  httpPort: 80,
  httpsPort: 443,
  originProtocolPolicy: "http-only" as const,
  originSslProtocols: ["TLSv1.2"],
  originReadTimeout: 60,
  originKeepaliveTimeout: 60,
};

const CDN_BEHAVIOR = {
  viewerProtocolPolicy: "redirect-to-https" as const,
  allowedMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
  cachedMethods: ["GET", "HEAD"],
  forwardedValues: {
    queryString: true,
    headers: ["*"],
    cookies: { forward: "all" as const },
  },
  minTtl: 0,
  defaultTtl: 0,
  maxTtl: 0,
};

// ── helpers ──────────────────────────────────────────────────────────────────

// Env var with fallback. Empty string also falls through.
const envOr = <T>(key: string, fallback: T) => process.env[key] || fallback;

// Strip protocol and path from a URL Output (for CloudFront origin domainName).
const stripProtocol = (url: $util.Output<string>) =>
  url.apply((u) =>
    u.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, ""),
  );

// HTTP health check with defaults + optional overrides.
const httpHealth = (
  path: string,
  overrides: Partial<{ successCodes: string }> = {},
) => ({ path, ...HEALTH_DEFAULTS, ...overrides });

// CloudFront custom origin (HTTP-only to ALB, HTTPS at the viewer).
const cloudfrontOrigin = (originId: string, serviceUrl: $util.Output<string>) => ({
  originId,
  domainName: stripProtocol(serviceUrl),
  customOriginConfig: CDN_ORIGIN_TIMEOUTS,
});

// The four env vars the API needs for each registry (transient + internal).
const registryEnv = (
  prefix: "TRANSIENT" | "INTERNAL",
  defaultUrl: $util.Output<string>,
) => ({
  [`${prefix}_REGISTRY_URL`]: envOr(`${prefix}_REGISTRY_URL`, defaultUrl),
  [`${prefix}_REGISTRY_ADMIN`]: envOr(`${prefix}_REGISTRY_ADMIN`, "admin"),
  [`${prefix}_REGISTRY_PASSWORD`]: envOr(`${prefix}_REGISTRY_PASSWORD`, "password"),
  [`${prefix}_REGISTRY_PROJECT_ID`]: envOr(`${prefix}_REGISTRY_PROJECT_ID`, "boxlite"),
});

// OIDC issuer URL — external override > CloudFront Dex > in-cluster Dex.
const oidcIssuer = (cloudfrontDomain: string | undefined, dexUrl: $util.Output<string>) =>
  envOr(
    "OIDC_ISSUER_BASE_URL",
    cloudfrontDomain
      ? `https://${cloudfrontDomain}/dex`
      : dexUrl.apply((u) => `${u}/dex`),
  );

// Runner endpoint overrides — use RUNNER_PRIVATE_IP shortcut when set.
const runnerEndpoint = (override: string, port: number, scheme: string) =>
  envOr(
    override,
    process.env.RUNNER_PRIVATE_IP
      ? `${scheme}${process.env.RUNNER_PRIVATE_IP}:${port}`
      : `${scheme}localhost:${port}`,
  );

// ── app config ───────────────────────────────────────────────────────────────
export default $config({
  app(input) {
    return {
      name: "boxlite",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: { region: REGION, profile: envOr("AWS_PROFILE", "default") },
        random: "4.16.6",
      },
    };
  },

  async run() {
    // Load .env overrides (anything unset falls back to auto-generated values)
    const { config } = await import("dotenv");
    config();

    const cloudfrontDomain = process.env.CUSTOM_DOMAIN
      ? process.env.CUSTOM_DOMAIN
      : process.env.CLOUDFRONT_DOMAIN;

    // ─── 1. SECRETS ──────────────────────────────────────────────────────────
    // Auto-generated — override any one by setting the matching env var.
    const randomKey = (name: string, length = 32) =>
      new random.RandomPassword(name, { length, special: false });

    const encryptionKey = randomKey("EncryptionKey", 64);
    const encryptionSalt = randomKey("EncryptionSalt", 32);
    const proxyApiKey = randomKey("ProxyApiKey");
    const sshGatewayApiKey = randomKey("SshGatewayApiKey");
    const adminApiKey = randomKey("AdminApiKey");
    const defaultRunnerApiKey = randomKey("DefaultRunnerApiKey");
    const pgAdminPassword = randomKey("PgAdminPassword", 24);

    // ─── 2. PLATFORM ─────────────────────────────────────────────────────────
    const vpc = new sst.aws.Vpc("Vpc", { nat: "ec2" });
    const db = new sst.aws.Postgres("Database", { vpc, instance: "t4g.micro", storage: "20 GB" });
    const redis = new sst.aws.Redis("Cache", { vpc, cluster: false }); // NestJS uses SELECT (multi-DB)
    const storage = new sst.aws.Bucket("Storage");
    const cluster = new sst.aws.Cluster("Cluster", { vpc, forceUpgrade: "v2" });

    // ─── 3. IAM ──────────────────────────────────────────────────────────────
    // S3 IAM user: API signs STS tokens for sandbox S3 uploads.
    const s3User = new aws.iam.User("S3User", {});
    new aws.iam.UserPolicy("S3UserPolicy", {
      user: s3User.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: ["s3:*"], Resource: ["*"] },
          { Effect: "Allow", Action: ["sts:AssumeRole", "sts:GetCallerIdentity"], Resource: ["*"] },
        ],
      }),
    });
    const s3AccessKey = new aws.iam.AccessKey("S3AccessKey", { user: s3User.name });

    // ─── 4. AUTH (Dex OIDC) ──────────────────────────────────────────────────
    // Issuer URL must match what clients use. On first deploy CLOUDFRONT_DOMAIN
    // isn't known yet; set it in .env after the initial deploy and redeploy.
    const dex = new sst.aws.Service("Dex", {
      cluster,
      image: { context: "../..", dockerfile: "apps/dex/Dockerfile" },
      loadBalancer: { rules: [{ listen: "80/http", forward: `${PORTS.DEX}/http` }] },
      environment: {
        DEX_ISSUER: cloudfrontDomain
          ? `https://${cloudfrontDomain}/dex`
          : envOr("DEX_ISSUER", `http://localhost:${PORTS.DEX}/dex`),
        REDIRECT_URI: cloudfrontDomain ? `https://${cloudfrontDomain}` : "http://localhost:3000",
      },
    });

    // ─── 5. REGISTRY (S3-backed snapshot store) ──────────────────────────────
    // Replaces upstream registry:2.8.2 — snapshots persist in S3, not on an
    // ephemeral container disk.
    const snapshotManager = new sst.aws.Service("SnapshotManager", {
      cluster,
      image: { context: "../..", dockerfile: "apps/snapshot-manager/Dockerfile" },
      loadBalancer: { rules: [{ listen: "80/http", forward: `${PORTS.SNAPSHOT_MANAGER}/http` }] },
      environment: {
        SNAPSHOT_MANAGER_STORAGE_DRIVER: "s3",
        SNAPSHOT_MANAGER_STORAGE_S3_REGION: REGION,
        SNAPSHOT_MANAGER_STORAGE_S3_BUCKET: storage.name,
        SNAPSHOT_MANAGER_STORAGE_S3_ACCESSKEY: s3AccessKey.id,
        SNAPSHOT_MANAGER_STORAGE_S3_SECRETKEY: s3AccessKey.secret,
        SNAPSHOT_MANAGER_STORAGE_DELETE_ENABLED: "true",
        SNAPSHOT_MANAGER_AUTH_TYPE: "none",
      },
    });
    const registry = snapshotManager; // API uses this URL for both transient + internal registries

    // ─── 6. API (NestJS control plane) ───────────────────────────────────────
    const api = new sst.aws.Service("Api", {
      cluster,
      image: { context: "../..", dockerfile: "apps/api/Dockerfile" },
      loadBalancer: { rules: [{ listen: "80/http", forward: `${PORTS.API}/http` }] },
      link: [db, redis, storage],
      scaling: { min: 1, max: 4 },
      environment: {
        // Core
        NODE_ENV: "production",
        PORT: String(PORTS.API),
        ENVIRONMENT: "production",
        RUN_MIGRATIONS: "true",
        VERSION: "0.1.0",
        DEFAULT_REGION_ENFORCE_QUOTAS: "false",
        DEFAULT_SNAPSHOT: envOr("DEFAULT_SNAPSHOT", "ubuntu:latest"),

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
        REDIS_TLS: "true",

        // Encryption
        ENCRYPTION_KEY: envOr("ENCRYPTION_KEY", encryptionKey.result),
        ENCRYPTION_SALT: envOr("ENCRYPTION_SALT", encryptionSalt.result),

        // OIDC (Dex by default, overridable to Auth0/Okta/etc.)
        OIDC_CLIENT_ID: envOr("OIDC_CLIENT_ID", "boxlite"),
        OIDC_AUDIENCE: envOr("OIDC_AUDIENCE", "boxlite"),
        OIDC_ISSUER_BASE_URL: oidcIssuer(process.env.CLOUDFRONT_DOMAIN, dex.url),

        // S3 (API signs STS creds for per-sandbox buckets)
        S3_ENDPOINT: $interpolate`https://s3.${aws.getRegionOutput().name}.amazonaws.com`,
        S3_STS_ENDPOINT: $interpolate`https://sts.${aws.getRegionOutput().name}.amazonaws.com`,
        S3_REGION: REGION,
        S3_ACCESS_KEY: s3AccessKey.id,
        S3_SECRET_KEY: s3AccessKey.secret,
        S3_DEFAULT_BUCKET: storage.name,
        S3_ACCOUNT_ID: aws.getCallerIdentityOutput().accountId,
        S3_ROLE_NAME: "BoxliteS3Role",

        // Proxy
        PROXY_DOMAIN: envOr("PROXY_DOMAIN", "localhost"),
        PROXY_PROTOCOL: envOr("PROXY_PROTOCOL", "http"),
        PROXY_API_KEY: envOr("PROXY_API_KEY", proxyApiKey.result),
        PROXY_TEMPLATE_URL: envOr("PROXY_TEMPLATE_URL", "http://localhost"),

        // SSH Gateway
        SSH_GATEWAY_URL: envOr("SSH_GATEWAY_URL", `ssh://localhost:${PORTS.SSH_GATEWAY}`),
        SSH_GATEWAY_API_KEY: envOr("SSH_GATEWAY_API_KEY", sshGatewayApiKey.result),

        // Admin
        ADMIN_API_KEY: envOr("ADMIN_API_KEY", adminApiKey.result),

        // Dashboard (empty → dashboard uses relative /api/* paths)
        DASHBOARD_URL: envOr("DASHBOARD_URL", ""),
        APP_URL: envOr("APP_URL", ""),
        DASHBOARD_BASE_API_URL: envOr("DASHBOARD_BASE_API_URL", ""),

        // Docker registries (both default to the in-cluster SnapshotManager)
        ...registryEnv("TRANSIENT", registry.url),
        ...registryEnv("INTERNAL", registry.url),

        // Default runner — wire via RUNNER_PRIVATE_IP after the first deploy
        DEFAULT_RUNNER_NAME: envOr("DEFAULT_RUNNER_NAME", "default"),
        DEFAULT_RUNNER_API_KEY: envOr("DEFAULT_RUNNER_API_KEY", defaultRunnerApiKey.result),
        DEFAULT_RUNNER_DOMAIN: runnerEndpoint("DEFAULT_RUNNER_DOMAIN", PORTS.RUNNER, ""),
        DEFAULT_RUNNER_API_URL: runnerEndpoint("DEFAULT_RUNNER_API_URL", PORTS.RUNNER, "http://"),
        DEFAULT_RUNNER_PROXY_URL: runnerEndpoint("DEFAULT_RUNNER_PROXY_URL", PORTS.PROXY, "http://"),

        // PostHog (enables the dashboard's "Create Sandbox" feature flag)
        ...(process.env.POSTHOG_API_KEY && {
          POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
          POSTHOG_HOST: envOr("POSTHOG_HOST", "https://us.posthog.com"),
        }),

        // Svix (webhook delivery; without this dashboard logs cosmetic errors)
        ...(process.env.SVIX_AUTH_TOKEN && {
          SVIX_AUTH_TOKEN: process.env.SVIX_AUTH_TOKEN,
          ...(process.env.SVIX_SERVER_URL && { SVIX_SERVER_URL: process.env.SVIX_SERVER_URL }),
        }),
      },
    });

    // ─── 7. EDGE SERVICES ────────────────────────────────────────────────────
    // Proxy: routes sandbox.<id>.host → sandbox pod. Health at /health.
    new sst.aws.Service("Proxy", {
      cluster,
      image: { context: "../..", dockerfile: "apps/proxy/Dockerfile" },
      loadBalancer: {
        rules: [{ listen: "80/http", forward: `${PORTS.PROXY}/http` }],
        health: { [`${PORTS.PROXY}/http`]: httpHealth("/health") },
      },
      environment: {
        PROXY_PORT: String(PORTS.PROXY),
        PROXY_PROTOCOL: envOr("PROXY_PROTOCOL", "http"),
        PROXY_API_KEY: envOr("PROXY_API_KEY", proxyApiKey.result),
        // api-client-go appends paths like "/config" directly → include /api suffix
        DAYTONA_API_URL: $interpolate`${api.url}/api`,
        OIDC_CLIENT_ID: envOr("OIDC_CLIENT_ID", "boxlite"),
        OIDC_AUDIENCE: envOr("OIDC_AUDIENCE", "boxlite"),
        OIDC_DOMAIN: cloudfrontDomain
          ? `https://${cloudfrontDomain}/dex`
          : `http://localhost:${PORTS.DEX}/dex`,
      },
    });

    // SSH Gateway: `ssh <sandbox>@gateway:2222` proxies to the sandbox.
    new sst.aws.Service("SshGateway", {
      cluster,
      image: { context: "../..", dockerfile: "apps/ssh-gateway/Dockerfile" },
      loadBalancer: { rules: [{ listen: `${PORTS.SSH_GATEWAY}/tcp`, forward: `${PORTS.SSH_GATEWAY}/tcp` }] },
      environment: {
        API_URL: api.url,
        API_KEY: envOr("SSH_GATEWAY_API_KEY", sshGatewayApiKey.result), // NB: not SSH_GATEWAY_API_KEY
        SSH_PRIVATE_KEY: envOr("SSH_PRIVATE_KEY_B64", ""),
        SSH_HOST_KEY: envOr("SSH_HOST_KEY_B64", ""),
      },
    });

    // ─── 8. OBSERVABILITY ────────────────────────────────────────────────────
    new sst.aws.Service("Jaeger", {
      cluster,
      image: IMAGES.jaeger,
      loadBalancer: { rules: [{ listen: "80/http", forward: `${PORTS.JAEGER_UI}/http` }] },
      environment: { COLLECTOR_OTLP_ENABLED: "true" },
    });

    // OtelCollector — Daytona's custom ocb build. The ClickHouse exporter is
    // compiled in but dropped at runtime via --set (dev has no ClickHouse).
    // Placeholder CLICKHOUSE_* env vars keep config.yaml parsing clean.
    new sst.aws.Service("OtelCollector", {
      cluster,
      image: { context: "../..", dockerfile: "apps/otel-collector/Dockerfile" },
      command: [
        "--config", "/otelcol/collector-config.yaml",
        "--set", "service::pipelines::traces::exporters=[daytona_exporter]",
        "--set", "service::pipelines::metrics::exporters=[daytona_exporter]",
        "--set", "service::pipelines::logs::exporters=[daytona_exporter]",
      ],
      loadBalancer: {
        rules: [
          { listen: `${PORTS.OTLP_HTTP}/http`, forward: `${PORTS.OTLP_HTTP}/http` },
          { listen: "80/http", forward: `${PORTS.OTEL_HEALTH}/http` },
        ],
        health: {
          // GET / on OTLP HTTP returns 405 Method Not Allowed — accept it.
          [`${PORTS.OTLP_HTTP}/http`]: httpHealth("/", { successCodes: "405" }),
          [`${PORTS.OTEL_HEALTH}/http`]: httpHealth("/health/status"),
        },
      },
      environment: {
        CLICKHOUSE_ENDPOINT: "tcp://localhost:9000",
        CLICKHOUSE_PASSWORD: "unused",
        DAYTONA_API_URL: $interpolate`${api.url}/api`,
      },
    });

    // ─── 9. ADMIN UIs ────────────────────────────────────────────────────────
    new sst.aws.Service("PgAdmin", {
      cluster,
      image: IMAGES.pgadmin,
      loadBalancer: { rules: [{ listen: "80/http", forward: `${PORTS.PGADMIN}/http` }] },
      environment: {
        PGADMIN_DEFAULT_EMAIL: "admin@boxlite.dev",
        PGADMIN_DEFAULT_PASSWORD: pgAdminPassword.result,
        PGADMIN_CONFIG_SERVER_MODE: "False",
        PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED: "False",
      },
    });

    new sst.aws.Service("RegistryUI", {
      cluster,
      image: IMAGES.registryUi,
      loadBalancer: { rules: [{ listen: "80/http", forward: `${PORTS.REGISTRY_UI}/http` }] },
      environment: {
        SINGLE_REGISTRY: "true",
        REGISTRY_TITLE: "BoxLite Registry",
        DELETE_IMAGES: "true",
        SHOW_CONTENT_DIGEST: "true",
        NGINX_PROXY_PASS_URL: snapshotManager.url,
        SHOW_CATALOG_NB_TAGS: "true",
        REGISTRY_SECURED: "false",
        CATALOG_ELEMENTS_LIMIT: "1000",
      },
    });

    new sst.aws.Service("MailDev", {
      cluster,
      image: IMAGES.maildev,
      loadBalancer: { rules: [{ listen: "80/http", forward: `${PORTS.MAILDEV_UI}/http` }] },
    });

    // ─── 10. CDN (HTTPS for Api + Dex) ───────────────────────────────────────
    // Default: free *.cloudfront.net cert. CUSTOM_DOMAIN → your own ACM cert
    // (must live in us-east-1, CloudFront requirement).
    const customDomain = process.env.CUSTOM_DOMAIN;
    new aws.cloudfront.Distribution("ApiCdn", {
      enabled: true,
      origins: [cloudfrontOrigin("api", api.url), cloudfrontOrigin("dex", dex.url)],
      // /dex/* → Dex, everything else → API
      orderedCacheBehaviors: [{ pathPattern: "/dex/*", targetOriginId: "dex", ...CDN_BEHAVIOR }],
      defaultCacheBehavior: { targetOriginId: "api", ...CDN_BEHAVIOR },
      restrictions: { geoRestriction: { restrictionType: "none" } },
      viewerCertificate: customDomain
        ? {
            acmCertificateArn: process.env.CUSTOM_DOMAIN_CERT_ARN!,
            sslSupportMethod: "sni-only",
            minimumProtocolVersion: "TLSv1.2_2021",
          }
        : { cloudfrontDefaultCertificate: true },
      ...(customDomain && { aliases: [customDomain] }),
    });

    // ─── 11. RUNNER (EC2 with nested KVM) ────────────────────────────────────
    // Pulls runner image from ECR, runs privileged with /dev/kvm mounted.
    const ubuntuAmi = aws.ec2.getAmi({
      mostRecent: true,
      owners: [RUNNER.ubuntuOwnerId],
      filters: [
        { name: "name", values: [RUNNER.ubuntuNamePattern] },
        { name: "architecture", values: ["x86_64"] },
      ],
    });

    const runnerRole = new aws.iam.Role("RunnerRole", {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
      }),
    });
    for (const [name, arn] of [
      ["RunnerEcrPolicy", "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"],
      ["RunnerSsmPolicy", "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"],
    ] as const) {
      new aws.iam.RolePolicyAttachment(name, { role: runnerRole.name, policyArn: arn });
    }
    const runnerInstanceProfile = new aws.iam.InstanceProfile("RunnerProfile", { role: runnerRole.name });

    // SST publishes app images to its shared ECR repo — reuse it for the runner image.
    const ecrRepo = $interpolate`${aws.getCallerIdentityOutput().accountId}.dkr.ecr.${REGION}.amazonaws.com/sst-asset`;

    const runnerUserData = $resolve([api.url, defaultRunnerApiKey.result, ecrRepo, registry.url]).apply(
      ([apiUrl, token, repo, registryUrl]) => buildRunnerUserData({ apiUrl, token, repo, registryUrl }),
    );

    new aws.ec2.Instance("Runner", {
      ami: ubuntuAmi.then((a) => a.id),
      instanceType: RUNNER.instanceType,
      subnetId: vpc.publicSubnets[0],
      iamInstanceProfile: runnerInstanceProfile.name,
      cpuOptions: { nestedVirtualization: "enabled" },
      associatePublicIpAddress: true,
      userDataBase64: runnerUserData,
      rootBlockDevice: { volumeSize: RUNNER.rootDiskGB },
      tags: { Name: "boxlite-runner" },
    });
  },
});

// ── runner bootstrap ─────────────────────────────────────────────────────────
// EC2 user-data: installs Docker + AWS CLI, logs into ECR, starts the runner
// container privileged with /dev/kvm mounted.
function buildRunnerUserData(input: {
  apiUrl: string;
  token: string;
  repo: string;
  registryUrl: string;
}): string {
  const ecrDomain = input.repo.split("/")[0];
  const registryHost = input.registryUrl
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const script = `#!/bin/bash
exec > /var/log/runner-setup.log 2>&1

# Wait for dpkg locks
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 5; done

# Install Docker via official script
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# Install AWS CLI v2
apt-get install -y unzip
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install

# Login to ECR
/usr/local/bin/aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${ecrDomain}

# Pull and run runner
docker pull ${input.repo}:Runner
docker run -d --restart=always --privileged \\
  --name boxlite-runner \\
  -p ${PORTS.RUNNER}:${PORTS.RUNNER} \\
  -v /dev/kvm:/dev/kvm \\
  -e DAYTONA_API_URL=${input.apiUrl}/api \\
  -e DAYTONA_RUNNER_TOKEN=${input.token} \\
  -e API_VERSION=2 \\
  -e API_PORT=${PORTS.RUNNER} \\
  ${input.repo}:Runner

# Point runner's Docker at the insecure in-cluster registry
sleep 10
docker exec boxlite-runner sh -c 'echo "{\\"insecure-registries\\": [\\"${registryHost}\\"]}" > /etc/docker/daemon.json'
docker restart boxlite-runner

echo "Runner setup complete"
`;
  return Buffer.from(script).toString("base64");
}
