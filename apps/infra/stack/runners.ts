// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

import { resolveArtifactSource } from '../artifacts/source.js'
import {
  resolveRunnerArtifact,
  runnerArtifactsBucketName,
} from '../artifacts/runner.js'
import { readDeployScope } from '../deployment/scope.js'
// eslint-disable-next-line @nx/enforce-module-boundaries -- Runner resources and policy validation share one inventory model.
import type { resolveRunnerInventory } from '../runner/model/inventory.js'
import type { ApiResources } from './api.js'
import type { FoundationResources } from './foundation.js'
import { PORTS, RUNNER, envOr } from './settings.js'

export interface RunnerInputs {
  foundation: FoundationResources
  api: ApiResources['api']
  otelCollectorOtlpHttpUrl: $util.Output<string>
  region: string
  accountId: string
  runnerInventory: ReturnType<typeof resolveRunnerInventory>
  defaultRunnerConfig: ReturnType<typeof resolveRunnerInventory>[number]
  defaultRunnerApiKey: random.RandomPassword
  adminApiKey: random.RandomPassword
  randomKey: (name: string, length?: number) => random.RandomPassword
}

export async function buildRunners(input: RunnerInputs): Promise<void> {
  const {
    foundation: { vpc },
    api,
    otelCollectorOtlpHttpUrl,
    region: REGION,
    accountId,
    runnerInventory,
    defaultRunnerConfig,
    defaultRunnerApiKey,
    adminApiKey,
    randomKey,
  } = input

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
const runnerArtifactPolicy = new aws.iam.RolePolicy('RunnerArtifactS3Policy', {
  role: runnerRole.name,
  // Read-only, and only under the prefix build-mode Runner binaries are staged in. This is
  // how a host installs a binary that was never published; nothing else in the bucket is
  // reachable, and the Runner can never write here.
  policy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: `arn:aws:s3:::${artifactsBucketName}/runner/*`,
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
// Runners pull box images straight from ghcr.io (the self-hosted registry
// was removed). The curated defaults (BOXLITE_SYSTEM_*_IMAGE, above) are
// public, so this credential is needed only for a private ref — whether set
// there or appended through BOXLITE_SYSTEM_IMAGES. When
// set, the pull TOKEN is stored in Secrets Manager and fetched by each
// runner at boot via its instance-role — NOT baked into user-data/IMDS — so
// scaled-out runners pick it up automatically and a rotated token only needs
// a secret update + a runner restart. The username (a non-secret bot
// account) is baked directly. Env-gated: set GHCR_TOKEN (+ GHCR_USERNAME)
// in apps/infra/.env to enable; unset = no ghcr auth wired.
const ghcrUsername = process.env.GHCR_USERNAME?.trim() || ''
const ghcrToken = process.env.GHCR_TOKEN?.trim() || ''
const ghcrSecret =
  ghcrUsername && ghcrToken
    ? // 7-day recovery window: an accidental delete during rotation is undoable
      // (vs 0 = immediate, irreversible — which would break all runner image pulls).
      //
      // Named explicitly, following stack/deploy.ts:161's s3-access role. SST's `<app>-<stage>-`
      // prefix comes from a transformation registered in the Component constructor, so it reaches a
      // component's children — not a resource declared at stack root like this one, which would
      // otherwise autoname to `GhcrPullToken-<suffix>`. The deploy role's secretsmanager grant is
      // scoped to `secret:boxlite-<stage>-*`, and an autonamed secret falls outside it: the deploy
      // would fail with AccessDenied the first time GHCR_TOKEN is set.
      new aws.secretsmanager.Secret('GhcrPullToken', {
        name: `${$app.name}-${$app.stage}-ghcr-pull-token`,
        recoveryWindowInDays: 7,
      })
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

const runnerUserDataFor = (token: $util.Input<string>) =>
  $resolve([api.url, token, otelCollectorOtlpHttpUrl, ghcrSecret ? ghcrSecret.arn : '']).apply(
    ([apiUrl, resolvedToken, otelEndpoint, ghcrSecretArn]) =>
      buildRunnerUserData({
        apiUrl,
        token: resolvedToken,
        otelEndpoint,
        awsRegion: REGION,
        artifact: runnerArtifact,
        ghcrSecretArn: ghcrSecretArn || undefined,
        ghcrUsername,
      }),
  )

const runnerUserData = runnerUserDataFor(defaultRunnerApiKey.result)

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
      iamInstanceProfile: runnerInstanceProfile.name,
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
      },
    },
    {
      ignoreChanges: ['ami', 'userDataBase64'],
      protect: true,
      // First boot reads the staged artifact with this role. The grant is a sibling of the
      // instance under runnerRole, not an ancestor, so without this edge Pulumi may create
      // the host first and its user-data dies on AccessDenied — permanently, because
      // protect + ignoreChanges('userDataBase64') mean it never runs again. Same edge the
      // UpgradeRunnerBinary commands declare for the SSM path.
      dependsOn: [runnerArtifactPolicy],
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
)

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
    runnerUserDataFor(apiKey.result),
  )
  return { name: runner.controlPlaneRunnerName, apiKey, instance }
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
      // `dir` is required: command.local.Command runs from the Pulumi
      // process's cwd (.sst/platform), not the app root, so a bare
      // `scripts/...` resolves to .sst/platform/scripts and fails with
      // "Cannot find module". $cli.paths.root is the same anchor SST uses
      // for user-relative paths (platform/src/components/component.ts).
      dir: $cli.paths.root,
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
// was skipped, and the Runner policy pack would not catch it: isRunnerLikeResource matches a
// name against /^Runner(?:-|$)/ OR an aws:ec2/instance:Instance carrying Runner identity
// tags, and this command satisfies neither arm of that disjunction.
//
// Undeclaring is a delete in Pulumi's model, which is the honest trade here: command.local
// .Command has no `delete:` script, so the delete touches nothing on the host, and the next
// full deploy recreates it — `create:` re-runs the same convergence-guarded script, a no-op
// when the host already serves the target identity.
let previousUpgrade: $util.Resource | undefined
for (const { label, instance } of !deploysRunner
  ? []
  : [
      { label: 'default', instance: defaultRunner },
      ...extraRunners.map((r) => ({ label: r.name, instance: r.instance })),
    ]) {
  previousUpgrade = new command.local.Command(
    `UpgradeRunnerBinary-${label}`,
    {
      dir: $cli.paths.root, // see RegisterExtraRunners above
      create: 'node scripts/runner-update-binary.mjs',
      update: 'node scripts/runner-update-binary.mjs',
      environment: {
        AWS_REGION: REGION,
        INSTANCE_IDS: instance.id,
        RUNNER_VERSION: runnerTargetVersion,
        RUNNER_PORT: String(PORTS.RUNNER),
        // The source selection, not the resolved URLs: the script runs the same resolver, so
        // `npm run runner:update` out of band lands the identical artifact.
        RUNNER_ARTIFACT_SOURCE: runnerArtifactSource.kind,
        RUNNER_ARTIFACT_BUCKET: artifactsBucketName,
        BOXLITE_ARTIFACT_REF: runnerArtifactSource.kind === 'build' ? (runnerArtifactSource.ref ?? '') : '',
      },
      triggers: [runnerArtifactTrigger, instance.id],
    },
    {
      // The artifact policy is a hard prerequisite, not a sibling: in build mode the payload
      // reads S3 with the instance role, so an upgrade started before the grant exists fails
      // AccessDenied and stops the roll. Pulumi has no implicit edge — the bucket reaches the
      // command as a plain string — so it is declared here.
      dependsOn: [instance, runnerArtifactPolicy, ...(previousUpgrade ? [previousUpgrade] : [])],
    },
  )
}
}

// ── runner bootstrap ─────────────────────────────────────────────────────────
// EC2 user-data: downloads prebuilt runner binary from GitHub Releases
// and runs it directly with BoxLite VM isolation.
async function buildRunnerUserData(input: {
  apiUrl: string
  token: string
  otelEndpoint: string
  awsRegion: string
  artifact: { tarballName: string; tarballUrl: string; checksumUrl: string; fetch: string }
  ghcrSecretArn?: string
  ghcrUsername?: string
}): Promise<string> {
  const { artifactFetchCommand } = await import('../artifacts/runner.js')
  const tarballPath = `/tmp/${input.artifact.tarballName}`
  const fetchTarball = artifactFetchCommand(input.artifact, input.artifact.tarballUrl, tarballPath, input.awsRegion)
  const fetchChecksum = artifactFetchCommand(
    input.artifact,
    input.artifact.checksumUrl,
    '/tmp/runner.sha256',
    input.awsRegion,
  )

  // ghcr pull credential delivery (option B, rotation-capable): write a start-wrapper
  // that re-fetches the TOKEN from Secrets Manager on EVERY service start — so
  // `systemctl restart` picks up a rotated token — and is fail-CLOSED (refuses to run
  // with anonymous pulls) with a bounded retry for instance-profile IAM propagation at
  // first boot. The wrapper is exec'd as ExecStart; username + secret ARN + region come
  // from the unit's Environment=. Only emitted when a ghcr secret is wired; the TOKEN is
  // never baked into user-data. The AWS CLI it needs is installed unconditionally above.
  const ghcrBlock = input.ghcrSecretArn
    ? `
# ── ghcr pull credential setup: fail-closed start-wrapper ────────────────────
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
# stack's artifacts bucket — is decided by artifacts/runner.ts, not here.
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
