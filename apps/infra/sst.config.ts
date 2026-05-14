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

// ── helpers ──────────────────────────────────────────────────────────────────

// Env var with fallback. Empty string also falls through.
const envOr = <T>(key: string, fallback: T) => process.env[key] || fallback;

// HTTP health check with defaults + optional overrides.
const httpHealth = (
  path: string,
  overrides: Partial<{ successCodes: string }> = {},
) => ({ path, ...HEALTH_DEFAULTS, ...overrides });

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

// OIDC issuer URL — must be set (Auth0, Okta, etc.). No default.
const requireOidcIssuer = () => {
  const v = process.env.OIDC_ISSUER_BASE_URL;
  if (!v) throw new Error("OIDC_ISSUER_BASE_URL is required (e.g. https://<tenant>.auth0.com/)");
  return v;
};

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
        cloudflare: "6.14.0",
        random: "4.16.6",
      },
    };
  },

  async run() {
    // Load .env overrides (anything unset falls back to auto-generated values)
    const { config } = await import("dotenv");
    config();

    // Strip trailing slash from service.url so path concat produces clean URLs
    // (api.url = "https://api.dev.boxlite.ai/" → apiBase = "https://api.dev.boxlite.ai").
    const stripTrailingSlash = (url: $util.Output<string>) =>
      url.apply((u) => (u.endsWith("/") ? u.slice(0, -1) : u));

    // HTTPS everywhere: the Router CloudFront Function deletes customOriginConfig
    // for http origins and CF then falls back to match-viewer (→ tries HTTPS on a
    // port-80-only ALB → 502). We side-step that by giving Api and Dex ALBs
    // HTTPS listeners with a wildcard ACM cert, so Router routes to https://
    // origins and the non-buggy branch runs.
    const stackDomain = process.env.STACK_DOMAIN;
    if (!stackDomain) {
      throw new Error(
        "STACK_DOMAIN is required (Cloudflare-managed subdomain, e.g. dev.boxlite.ai)",
      );
    }
    const cloudflareDns = sst.cloudflare.dns();
    const serviceDomain = (name: string) => ({
      name: `${name}.${stackDomain}`,
      dns: cloudflareDns,
    });

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
    const router = new sst.aws.Router("ApiCdn", {
      domain: { name: stackDomain, dns: cloudflareDns },
      transform: {
        cdn: (cdnArgs) => {
          cdnArgs.origins = $util.output(cdnArgs.origins).apply((origins) =>
            (origins ?? []).map((o: any) => ({
              ...o,
              customOriginConfig: o.customOriginConfig
                ? { ...o.customOriginConfig, originProtocolPolicy: "https-only", originReadTimeout: 60 }
                : o.customOriginConfig,
            })),
          );
        },
      },
    });

    // ─── 5. REGISTRY (S3-backed snapshot store) ──────────────────────────────
    // Replaces upstream registry:2.8.2 — snapshots persist in S3, not on an
    // ephemeral container disk.
    const snapshotManager = new sst.aws.Service("SnapshotManager", {
      cluster,
      image: { context: "../..", dockerfile: "apps/snapshot-manager/Dockerfile", cache: false },
      loadBalancer: {
        rules: [{ listen: "80/http", forward: `${PORTS.SNAPSHOT_MANAGER}/http` }],
        health: { [`${PORTS.SNAPSHOT_MANAGER}/http`]: httpHealth("/healthz") },
      },
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
      image: {
        context: "../..",
        dockerfile: "apps/api/Dockerfile",
        cache: false,
        args: { CACHE_BUST: Date.now().toString() },
      },
      loadBalancer: {
        domain: serviceDomain("api"),
        rules: [{ listen: "443/https", forward: `${PORTS.API}/http` }],
      },
      // AWS ALB default idle_timeout is 60s; per AWS docs (HTTP 408 troubleshooting),
      // raise to match expected WebSocket session length so SDK exec attaches survive
      // multi-minute idle pauses. SST doesn't surface this directly — use transform
      // to set the underlying aws.lb.LoadBalancer's idleTimeout attribute.
      // Paired with Node `keepAliveTimeout` in apps/api/src/main.ts (AWS HTTP 502
      // guidance: target keep-alive must be >= LB idle).
      transform: {
        loadBalancer: (lbArgs) => {
          lbArgs.idleTimeout = 3600;
        },
      },
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

        // OIDC — external provider (Auth0/Okta/etc.)
        OIDC_CLIENT_ID: envOr("OIDC_CLIENT_ID", "boxlite"),
        OIDC_AUDIENCE: envOr("OIDC_AUDIENCE", "boxlite"),
        OIDC_ISSUER_BASE_URL: requireOidcIssuer(),
        // Optional: Auth0 Management API (enables account linking etc.)
        ...(process.env.OIDC_MANAGEMENT_API_ENABLED === "true" && {
          OIDC_MANAGEMENT_API_ENABLED: "true",
          OIDC_MANAGEMENT_API_CLIENT_ID: process.env.OIDC_MANAGEMENT_API_CLIENT_ID!,
          OIDC_MANAGEMENT_API_CLIENT_SECRET: process.env.OIDC_MANAGEMENT_API_CLIENT_SECRET!,
          OIDC_MANAGEMENT_API_AUDIENCE: process.env.OIDC_MANAGEMENT_API_AUDIENCE!,
        }),
        // RP-initiated logout fallback. Safe to set unconditionally: the API
        // probes the IdP's discovery doc at startup and only exposes this URL
        // to the dashboard when the IdP itself lacks end_session_endpoint
        // (e.g. Dex). For Auth0/Okta the API hides this and the SPA uses the
        // IdP's real endpoint advertised in /.well-known/openid-configuration.
        OIDC_END_SESSION_ENDPOINT: envOr(
          "OIDC_END_SESSION_ENDPOINT",
          `https://${stackDomain}/api/auth/end-session`,
        ),
        ...(process.env.OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST && {
          OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST: process.env.OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST,
        }),

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
        PROXY_DOMAIN: envOr("PROXY_DOMAIN", `proxy.${stackDomain}`),
        PROXY_PROTOCOL: envOr("PROXY_PROTOCOL", "https"),
        PROXY_API_KEY: envOr("PROXY_API_KEY", proxyApiKey.result),
        PROXY_TEMPLATE_URL: envOr("PROXY_TEMPLATE_URL", `https://proxy.${stackDomain}`),

        // SSH Gateway — friendly hostname `ssh.<stackDomain>` is provisioned
        // as a Cloudflare CNAME pointing at the SshGateway NLB further below.
        SSH_GATEWAY_URL: envOr("SSH_GATEWAY_URL", `ssh://ssh.${stackDomain}:${PORTS.SSH_GATEWAY}`),
        SSH_GATEWAY_API_KEY: envOr("SSH_GATEWAY_API_KEY", sshGatewayApiKey.result),

        // Admin
        ADMIN_API_KEY: envOr("ADMIN_API_KEY", adminApiKey.result),

        // Dashboard — point its API client at the direct `api.<stackDomain>`
        // ALB hostname so long-lived /attach WS, build-log SSE, and file
        // uploads bypass CloudFront (CF imposes a 10-min hard WS cap and a
        // 60s origin-read timeout that breaks streaming). Static SPA assets
        // (index.html + /assets/*) still serve through the CF Router at the
        // root domain. CORS on the API is already `origin: true` so the
        // cross-origin dashboard→API path works without further changes.
        DASHBOARD_URL: envOr("DASHBOARD_URL", `https://${stackDomain}`),
        APP_URL: envOr("APP_URL", ""),
        DASHBOARD_BASE_API_URL: envOr("DASHBOARD_BASE_API_URL", `https://api.${stackDomain}`),

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
    // Proxy: routes `<port>-<sandboxid>.proxy.<stack>` to the sandbox port.
    // Wildcard cert covers *.proxy.<stack>; Cloudflare serves wildcard DNS.
    const proxyDomain = `proxy.${stackDomain}`;
    new sst.aws.Service("Proxy", {
      cluster,
      image: { context: "../..", dockerfile: "apps/proxy/Dockerfile", cache: false },
      loadBalancer: {
        domain: {
          name: proxyDomain,
          aliases: [`*.${proxyDomain}`],
          dns: cloudflareDns,
        },
        rules: [{ listen: "443/https", forward: `${PORTS.PROXY}/http` }],
        health: { [`${PORTS.PROXY}/http`]: httpHealth("/health") },
      },
      // Same reasoning as the Api LB: bump idle to 1h so dashboard iframe
      // terminals (https://22222-<sbx>.proxy.<stack>/) survive idle pauses
      // until the runner-side keepalive in handleWebSocketTerminal lands.
      transform: {
        loadBalancer: (lbArgs) => {
          lbArgs.idleTimeout = 3600;
        },
      },
      environment: {
        PROXY_PORT: String(PORTS.PROXY),
        PROXY_PROTOCOL: envOr("PROXY_PROTOCOL", "http"),
        PROXY_API_KEY: envOr("PROXY_API_KEY", proxyApiKey.result),
        // api-client-go appends paths like "/config" directly → include /api suffix
        BOXLITE_API_URL: $interpolate`${stripTrailingSlash(api.url)}/api`,
        OIDC_CLIENT_ID: envOr("OIDC_CLIENT_ID", "boxlite"),
        OIDC_AUDIENCE: envOr("OIDC_AUDIENCE", "boxlite"),
        OIDC_DOMAIN: requireOidcIssuer(),
      },
    });

    // SSH Gateway: `ssh <sandbox>@ssh.<stackDomain>:2222` proxies to the sandbox.
    // The NLB has no domain field (TCP listeners don't take ACM certs); instead we
    // attach a Cloudflare CNAME directly via cloudflareDns.createAlias below so users
    // get a stable, memorable hostname instead of the auto-generated NLB DNS name.
    const sshGateway = new sst.aws.Service("SshGateway", {
      cluster,
      image: { context: "../..", dockerfile: "apps/ssh-gateway/Dockerfile", cache: false },
      loadBalancer: { rules: [{ listen: `${PORTS.SSH_GATEWAY}/tcp`, forward: `${PORTS.SSH_GATEWAY}/tcp` }] },
      environment: {
        API_URL: api.url,
        API_KEY: envOr("SSH_GATEWAY_API_KEY", sshGatewayApiKey.result), // NB: not SSH_GATEWAY_API_KEY
        SSH_PRIVATE_KEY: envOr("SSH_PRIVATE_KEY_B64", ""),
        SSH_HOST_KEY: envOr("SSH_HOST_KEY_B64", ""),
      },
    });

    cloudflareDns.createAlias(
      "SshGateway",
      {
        name: `ssh.${stackDomain}`,
        aliasName: sshGateway.nodes.loadBalancer.dnsName,
        aliasZone: sshGateway.nodes.loadBalancer.zoneId,
      },
      {},
    );

    // ─── 8. OBSERVABILITY ────────────────────────────────────────────────────
    new sst.aws.Service("Jaeger", {
      cluster,
      image: IMAGES.jaeger,
      loadBalancer: { rules: [{ listen: "80/http", forward: `${PORTS.JAEGER_UI}/http` }] },
      environment: { COLLECTOR_OTLP_ENABLED: "true" },
    });

    // OtelCollector — BoxLite's custom ocb build. The ClickHouse exporter is
    // compiled in but dropped at runtime via --set (dev has no ClickHouse).
    // Placeholder CLICKHOUSE_* env vars keep config.yaml parsing clean.
    new sst.aws.Service("OtelCollector", {
      cluster,
      image: { context: "../..", dockerfile: "apps/otel-collector/Dockerfile", cache: false },
      command: [
        "--config", "/otelcol/collector-config.yaml",
        "--set", "service::pipelines::traces::exporters=[boxlite_exporter]",
        "--set", "service::pipelines::metrics::exporters=[boxlite_exporter]",
        "--set", "service::pipelines::logs::exporters=[boxlite_exporter]",
      ],
      loadBalancer: {
        rules: [
          { listen: `${PORTS.OTLP_HTTP}/http`, forward: `${PORTS.OTLP_HTTP}/http` },
          { listen: "80/http", forward: `${PORTS.OTEL_HEALTH}/http` },
        ],
        health: {
          // The OTLP HTTP receiver returns a client-error status for a bare
          // health-check GET, which still proves the receiver is listening.
          [`${PORTS.OTLP_HTTP}/http`]: httpHealth("/", { successCodes: "200-499" }),
          [`${PORTS.OTEL_HEALTH}/http`]: httpHealth("/health/status"),
        },
      },
      environment: {
        CLICKHOUSE_ENDPOINT: "tcp://localhost:9000",
        CLICKHOUSE_PASSWORD: "unused",
        BOXLITE_API_URL: $interpolate`${stripTrailingSlash(api.url)}/api`,
      },
    });

    // ─── 9. ADMIN UIs ────────────────────────────────────────────────────────
    new sst.aws.Service("PgAdmin", {
      cluster,
      image: IMAGES.pgadmin,
      loadBalancer: {
        rules: [{ listen: "80/http", forward: `${PORTS.PGADMIN}/http` }],
        health: { [`${PORTS.PGADMIN}/http`]: httpHealth("/", { successCodes: "200-399" }) },
      },
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

    // ─── 10. CDN ROUTES ──────────────────────────────────────────────────────
    // Router (declared in section 4) fronts the Api with HTTPS.
    router.route("/", api.url);

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
    new aws.iam.RolePolicyAttachment("RunnerSsmPolicy", {
      role: runnerRole.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    });
    new aws.iam.RolePolicy("RunnerVolumeS3Policy", {
      role: runnerRole.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:*"],
            Resource: ["arn:aws:s3:::boxlite-volume-*", "arn:aws:s3:::boxlite-volume-*/*"],
          },
        ],
      }),
    });
    const runnerInstanceProfile = new aws.iam.InstanceProfile("RunnerProfile", { role: runnerRole.name });

    const runnerUserData = $resolve([api.url, defaultRunnerApiKey.result, registry.url]).apply(
      ([apiUrl, token, registryUrl]) => buildRunnerUserData({ apiUrl, token, registryUrl }),
    );

    // Runner holds load-bearing sandbox state (/var/lib/boxlite + in-memory
    // libkrun VMs). Two Pulumi resource options keep it persistent across
    // routine deploys:
    //
    //   ignoreChanges: drift in `ami` (Ubuntu publishes new AMIs monthly)
    //   and `userDataBase64` (Cargo.toml version bumps rewrite the embedded
    //   RUNNER_VERSION) no longer triggers replacement. The new runner
    //   binary lands via `scripts/deploy/runner-update-binary.sh` (SSM Run
    //   Command) instead of by recreating the EC2.
    //
    //   protect: refuses any deletion attempt, including an errant
    //   `pulumi destroy` or stack-wide teardown. Deliberate decommission
    //   requires editing this file to `protect: false`, deploying that
    //   change, then `pulumi destroy --target ...Runner`.
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
    }, {
      ignoreChanges: ["ami", "userDataBase64"],
      protect: true,
    });
  },
});

// ── runner bootstrap ─────────────────────────────────────────────────────────
// EC2 user-data: downloads prebuilt runner binary from GitHub Releases
// and runs it directly with BoxLite VM isolation.
async function buildRunnerUserData(input: {
  apiUrl: string;
  token: string;
  registryUrl: string;
}): Promise<string> {
  const { readFileSync } = await import("fs");
  const { resolve } = await import("path");

  // SST invokes from apps/infra/ as cwd; Cargo.toml lives at repo root.
  const RUNNER_VERSION = readFileSync(resolve(process.cwd(), "../../Cargo.toml"), "utf-8")
    .match(/^version\s*=\s*"(.+?)"/m)![1];

  const registryHost = input.registryUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const script = `#!/bin/bash
exec > /var/log/runner-setup.log 2>&1

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

# Download prebuilt runner binary from GitHub Releases
curl -fsSL "https://github.com/boxlite-ai/boxlite/releases/download/v${RUNNER_VERSION}/boxlite-runner-v${RUNNER_VERSION}-linux-amd64.tar.gz" | tar xz -C /usr/local/bin/
chmod +x /usr/local/bin/boxlite-runner

# Get host IP via IMDSv2
IMDS_TOKEN=\$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
HOST_IP=\$(curl -s -H "X-aws-ec2-metadata-token: \$IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)

# Create systemd service for the BoxLite runner
cat > /etc/systemd/system/boxlite-runner.service << UNIT
[Unit]
Description=BoxLite Runner
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/boxlite-runner
Restart=always
RestartSec=5
Environment=BOXLITE_API_URL=${input.apiUrl.replace(/\/$/, "")}/api
Environment=BOXLITE_RUNNER_TOKEN=${input.token}
Environment=API_VERSION=2
Environment=API_PORT=${PORTS.RUNNER}
Environment=RUNNER_DOMAIN=\$HOST_IP
Environment=BOXLITE_HOME_DIR=/var/lib/boxlite
Environment=INSECURE_REGISTRIES=${registryHost}
Environment=AWS_REGION=${REGION}

[Install]
WantedBy=multi-user.target
UNIT

mkdir -p /var/lib/boxlite
systemctl daemon-reload
systemctl enable boxlite-runner
systemctl start boxlite-runner

echo "Runner setup complete"
`;
  return Buffer.from(script).toString("base64");
}
