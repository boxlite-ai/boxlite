/*
 * The runner fleet on EC2.
 *
 * Nested virtualization is one instance attribute here — `cpuOptions.
 * nestedVirtualization` — and the guest needs nothing, which is why this
 * provider's `prepareKvm` hook is empty and GCP's is not.
 *
 * Two Pulumi options keep a host alive across routine deploys, and both are
 * load-bearing rather than cautious. A runner holds state no other resource
 * does — `/var/lib/boxlite` and the libkrun VMs in its memory — so
 * `ignoreChanges` on the image and the boot script stops a monthly Ubuntu
 * release or a version bump from replacing a machine with running boxes on it,
 * and `protect` refuses a delete outright. The version bump still has to reach
 * the fleet, and it does: `UpgradeRunnerBinary*` below replaces the binary in
 * place over SSM, one host at a time, as part of the same deploy. See
 * `stack/runner-upgrade.ts` — "installed at boot" would mean "never" for a host
 * whose boot script is ignored and which is never replaced.
 *
 * A consequence worth stating: because the boot script is ignored after the
 * first boot, its dependencies have to be right the *first* time. The artifact
 * grant is a sibling of the instance rather than an ancestor, so without an
 * explicit edge Pulumi may create the host first and its boot script dies on
 * AccessDenied — permanently, because it never runs again.
 *
 * Secrets reach a host through a start wrapper that re-fetches them on every
 * start, not through the boot script. Anything written into user data is
 * readable from the instance metadata by whatever runs on the host, and what
 * runs on a runner is untrusted code by design.
 *
 * The registration token is the one deliberate exception, and `runner-boot.ts`
 * records why it was accepted rather than leaving it to look like a slip.
 */

import type { Placement } from '../../network.ts'
import type { RunnerProvider, RunnerRequest, Runners } from '../../runners.ts'
import { RUNNER_PORT, RUNNER_TOKEN_VARIABLE } from '../../runners.ts'
import { renderRunnerBoot, type BootPlatform } from '../../runner-boot.ts'
import {
  REGISTER_RUNNERS_COMMAND,
  extraRunnersOf,
  registrationDir,
  registrationPayload,
} from '../../runner-registration.ts'
import {
  UPGRADE_RUNNER_COMMAND,
  encodeUpgradePayload,
  upgradeDir,
  upgradeResourceName,
  upgradeTrigger,
} from '../../runner-upgrade.ts'

/** What each requested size answers to. Every one of these can nest. */
const INSTANCE = { small: 'c8i.large', medium: 'c8i.xlarge', large: 'c8i.2xlarge' } as const

const UBUNTU_OWNER = '099720109477'
const UBUNTU_NAME = 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*'

/** Mountpoint for Amazon S3, which is what mounts a volume on this cloud. */
const MOUNT_S3_VERSION = '1.20.0'

/**
 * The wrapper that fetches every secret this host reads, on every start.
 *
 * Fail-closed and retried: at first boot the instance profile's grants may not
 * have propagated yet, and a host that gave up would run without the
 * credentials it needs rather than without starting. Five attempts with a
 * growing pause, then a refusal.
 */
const startWrapper = (names: string[], region: string): BootPlatform['startWrapper'] =>
  names.length === 0
    ? null
    : {
        path: '/usr/local/bin/boxlite-runner-start.sh',
        script: `
cat > /usr/local/bin/boxlite-runner-start.sh << 'STARTWRAP'
#!/bin/bash
# Re-fetch every secret on each start, so a rotation needs a restart rather
# than a redeploy. Fail-closed: a host that cannot read one does not start.
set -o pipefail
fetch() {
  local name="$1" arn="$2" value=""
  for attempt in 1 2 3 4 5; do
    value=$(aws secretsmanager get-secret-value --region "${region}" --secret-id "$arn" --query SecretString --output text 2>/dev/null)
    { [ -n "$value" ] && [ "$value" != "None" ]; } && break
    echo "fetch of $name attempt $attempt failed; retrying in $((attempt * 5))s" >&2
    sleep $((attempt * 5))
  done
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    echo "FATAL: could not read $name from $arn; refusing to start without it" >&2
    exit 1
  fi
  export "$name=$value"
}
${names.map((name) => `fetch ${name} "$${name}_ARN"`).join('\n')}
exec /usr/local/bin/boxlite-runner
STARTWRAP
chmod +x /usr/local/bin/boxlite-runner-start.sh
`,
      }

export const awsRunnerProvider =
  ({
    placement,
    region,
    artifactsBucket,
    adminApiKey,
    regionId,
    dependsOn,
  }: {
    placement: Extract<Placement, { cloud: 'aws' }>
    region: string
    /** Where a build-mode binary is staged. Read-only, and only under `runner/`. */
    artifactsBucket: string
    /** What registers the hosts the API does not seed. See `runner-registration.ts`. */
    adminApiKey: $util.Input<string>
    /** The region those rows go in — the same one the API seeded its own into. */
    regionId: string
    dependsOn: any[]
  }): RunnerProvider =>
  (request: RunnerRequest): Runners => {
    if (placement.exposure !== 'egress-only-public') {
      throw new Error(
        `The runner was placed as ${placement.exposure}; it pulls box images constantly and must ` +
          'egress through the internet gateway rather than the NAT the services share',
      )
    }

    const role = new aws.iam.Role('RunnerRole', {
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      }),
    })
    // How a binary upgrade reaches a live host, and the only way in: there is
    // no inbound port for a person.
    new aws.iam.RolePolicyAttachment('RunnerSsmPolicy', {
      role: role.name,
      policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
    })
    /*
     * Exactly Mountpoint for Amazon S3's documented permission set, against the
     * volume buckets alone. Bucket lifecycle — create, tag, delete — is the
     * API's, not a runner's: a compromised runner must not be able to delete
     * the volume it is serving.
     */
    new aws.iam.RolePolicy('RunnerVolumeS3Policy', {
      role: role.name,
      policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: ['arn:aws:s3:::boxlite-volume-*'] },
          {
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
            Resource: ['arn:aws:s3:::boxlite-volume-*/*'],
          },
        ],
      }),
    })
    // Read-only, and only under the prefix a build-mode binary is staged in.
    // Nothing else in the bucket is reachable, and a runner can never write here.
    const artifactPolicy = new aws.iam.RolePolicy('RunnerArtifactS3Policy', {
      role: role.name,
      policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: `arn:aws:s3:::${artifactsBucket}/runner/*` }],
      }),
    })

    const secretNames = Object.keys(request.secrets)
    const secretPolicy =
      secretNames.length > 0
        ? new aws.iam.RolePolicy('RunnerSecretPolicy', {
            role: role.name,
            policy: $resolve(Object.values(request.secrets)).apply((arns: string[]) =>
              JSON.stringify({
                Version: '2012-10-17',
                Statement: [{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: arns }],
              }),
            ),
          })
        : undefined

    const profile = new aws.iam.InstanceProfile('RunnerProfile', { role: role.name })

    const ami = aws.ec2.getAmiOutput({
      mostRecent: true,
      owners: [UBUNTU_OWNER],
      filters: [
        { name: 'name', values: [UBUNTU_NAME] },
        { name: 'architecture', values: ['x86_64'] },
      ],
    })

    const platform: BootPlatform = {
      // IMDSv2, which the instance below requires. A v1 read would fail here
      // rather than silently returning nothing.
      hostAddress: `IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
HOST_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)`,
      installVolumeMount: `# Mountpoint for Amazon S3, which is what mounts a box volume here.
curl -fsSL "https://s3.amazonaws.com/mountpoint-s3-release/${MOUNT_S3_VERSION}/x86_64/mount-s3-${MOUNT_S3_VERSION}-x86_64.deb" -o /tmp/mount-s3.deb
apt-get install -y /tmp/mount-s3.deb
rm -f /tmp/mount-s3.deb

# The AWS CLI, unconditionally rather than only where a path here uses it: a
# host created against a published release can later be upgraded to a binary
# staged in S3, and that upgrade runs over SSM with no chance to install first.
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
apt-get install -y unzip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install --update
rm -rf /tmp/awscliv2.zip /tmp/aws`,
      // Nothing: nested virtualization is an instance attribute on this cloud,
      // and the guest's own /dev/kvm is present as soon as it is set.
      prepareKvm: '',
      startWrapper: startWrapper(secretNames, region),
      unitEnvironment: { AWS_REGION: region },
    }

    const assignments = request.fleet

    const instances = assignments.map(
      ({ slot, token }) =>
        new aws.ec2.Instance(
          slot.resourceName,
          {
            ami: ami.id,
            instanceType: INSTANCE[request.size],
            // Public subnet, and the security group the network arranged is
            // what makes the address egress-only.
            subnetId: placement.subnets[0],
            associatePublicIpAddress: true,
            vpcSecurityGroupIds: placement.securityGroups,
            iamInstanceProfile: profile.name,
            cpuOptions: { nestedVirtualization: request.nestedVirtualization ? 'enabled' : 'disabled' },
            // IMDSv2 and one hop, so a container escape or an SSRF on this
            // untrusted-code host cannot read the instance role's credentials.
            metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1 },
            userDataBase64: $resolve([
              request.apiUrl,
              request.otlpUrl,
              // Resolved rather than cast, and the secret addresses with them:
              // both are `Input<string>`, and the composition root sets
              // `OTEL_EXPORTER_OTLP_ENDPOINT` from the collector's own URL. An
              // unresolved one renders as Pulumi's `[toString]` refusal text,
              // so the host ships telemetry nowhere and the start wrapper
              // fetches each secret from an address that is that text.
              $resolve(Object.values(request.environment)),
              $resolve(Object.values(request.secrets)),
              token,
            ]).apply(([apiUrl, otlpUrl, resolved, addresses, hostToken]) =>
              renderRunnerBoot({
                apiUrl: apiUrl as string,
                otlpUrl: otlpUrl as string,
                // Plain strings: the binary comes from the checkout, not from
                // another resource, so there is nothing here to resolve.
                binary: request.binary,
                region,
                port: RUNNER_PORT,
                environment: {
                  ...Object.fromEntries(
                    Object.keys(request.environment).map((name, index) => [name, String((resolved as string[])[index])]),
                  ),
                  // Which host this is, as the control plane knows it.
                  BOXLITE_RUNNER_NAME: slot.controlPlaneRunnerName,
                  // The wrapper reads each secret's address from here.
                  ...Object.fromEntries(
                    secretNames.map((name, index) => [`${name}_ARN`, String((addresses as string[])[index])]),
                  ),
                  // Last, so this host's own token wins over the fleet-wide one
                  // the store delivered. Every host but the first has its own.
                  [RUNNER_TOKEN_VARIABLE]: hostToken as string,
                },
                platform,
              }),
            ),
            rootBlockDevice: { volumeSize: request.rootDiskGb, encrypted: true },
            tags: { Name: slot.nameTag, 'boxlite:control-plane-runner-name': slot.controlPlaneRunnerName },
          },
          {
            // See the note at the top: a host holds state nothing else does.
            ignoreChanges: ['ami', 'userDataBase64'],
            protect: true,
            // The boot script reads the staged artifact with this role, and it
            // only ever runs once. Without the edge the host may be created
            // first and fail permanently.
            dependsOn: [artifactPolicy, ...(secretPolicy ? [secretPolicy] : []), ...dependsOn],
          },
        ),
    )

    /*
     * How a new binary reaches the hosts above, which the boot script cannot.
     *
     * `userDataBase64` is ignored after the first boot and the instance is
     * protected, so a deploy that changes the binary changes nothing on a host
     * that already exists. These land it in place, over SSM — see
     * `stack/runner-upgrade.ts` for what the payload does and why.
     *
     * One command per host, chained: the dependency graph is what keeps two
     * hosts from restarting at once, and a failure stops the chain with the
     * unvisited hosts still serving the old binary. Each waits on its own
     * instance because a host that does not exist has nothing to upgrade.
     */
    let previousUpgrade: any
    for (const [index, instance] of instances.entries()) {
      const { slot } = assignments[index]
      const payload = encodeUpgradePayload({
        identity: request.binary.identity,
        binary: request.binary,
        port: RUNNER_PORT,
        // Only a build-mode binary needs it, and only because it is read from
        // S3 with the host's own role rather than fetched publicly.
        region,
      })
      previousUpgrade = new command.local.Command(
        upgradeResourceName(slot),
        {
          // See `runner-registration.ts`: a local command runs from the
          // engine's own cwd, and `$cli` is a name only SST defines.
          dir: upgradeDir(),
          create: UPGRADE_RUNNER_COMMAND,
          update: UPGRADE_RUNNER_COMMAND,
          environment: {
            RUNNER_UPGRADE_CLOUD: 'aws',
            RUNNER_UPGRADE_TARGET: instance.id,
            RUNNER_UPGRADE_LABEL: slot.controlPlaneRunnerName,
            RUNNER_UPGRADE_IDENTITY: request.binary.identity,
            RUNNER_UPGRADE_PAYLOAD: payload,
            AWS_REGION: region,
          },
          /*
           * The identity, the address it came from, and the host.
           *
           * `triggers` replaces the command rather than updating it, which is
           * why `create` and `update` run the same script. What is deliberately
           * not in there is a digest: the stack never reads one — the host does,
           * from the manifest beside the tarball — so a republished asset under
           * one version is a change this cannot see. `runner-binary.ts` records
           * that as the cost of resolving from the checkout.
           *
           * Narrow on purpose either way: a payload that re-ran on every deploy
           * would restart a converged fleet for nothing.
           */
          triggers: [upgradeTrigger({ identity: request.binary.identity, binary: request.binary }), instance.id],
        },
        { dependsOn: [instance, ...(previousUpgrade ? [previousUpgrade] : [])] },
      )
    }

    /*
     * The rows the API will not seed.
     *
     * Only when there are any: a single-host fleet is complete the moment the
     * API is up, and creating a command for it would run a script that has
     * nothing to do on every deploy. `triggers` is what keeps this from
     * re-running otherwise — the API's address and the payload are the only two
     * inputs that change the answer.
     */
    const extras = extraRunnersOf(assignments)
    if (extras.length > 0) {
      const payload = $resolve(extras.map((extra) => extra.token)).apply((tokens) =>
        registrationPayload({ runners: extras, tokens: tokens as string[] }),
      )
      new command.local.Command(
        'RegisterExtraRunners',
        {
          // A local command runs from the engine's own cwd, so the directory
          // has to be given. Derived rather than read from `$cli`, which only
          // SST defines — see `runner-registration.ts`.
          dir: registrationDir(),
          create: REGISTER_RUNNERS_COMMAND,
          update: REGISTER_RUNNERS_COMMAND,
          environment: {
            API_URL: request.apiUrl,
            // Sealed in state rather than handed over plain. `local.Command`
            // marks nothing on this resource secret, so an admin-scoped
            // control-plane key would otherwise be readable in the checkpoint
            // by anyone who can read the stage's state bucket.
            ADMIN_API_KEY: $util.secret(adminApiKey),
            REGION_ID: regionId,
            RUNNERS: payload,
          },
          // Every input that changes the answer, and nothing secret: the
          // payload carries the tokens, so it is named here by the ids of the
          // resources that mint them rather than by its own value.
          triggers: [
            request.apiUrl,
            extras.map((extra) => extra.slot.controlPlaneRunnerName).join(','),
          ],
        },
        // After the hosts exist and after the API answers: the script waits on
        // /api/health, but a row created before its host is a row nothing holds.
        { dependsOn: [...instances, ...dependsOn] },
      )
    }

    return { ids: instances.map((instance) => instance.id), ready: instances }
  }
