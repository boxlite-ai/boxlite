/*
 * The runner fleet on Compute Engine, with nested virtualization.
 *
 * This is the module BoxLite exists for, and the one where GCP asks for things
 * AWS asks for none of. Getting any of them wrong produces a host that boots,
 * registers, and fails every box with no `/dev/kvm` — so each is named here
 * rather than assumed:
 *
 *   1. A machine family that can nest. E2 cannot, and the cheapest machine on
 *      this cloud is an E2; neither can the memory-optimised families, nor the
 *      AMD-based ones other than N4D. `MACHINE` below is N4 for that reason —
 *      Intel, current, and the counterpart of the EC2 sizes the AWS side names.
 *   2. `advancedMachineFeatures.enableNestedVirtualization`, explicitly. The
 *      family being capable is not the same as the device being present.
 *   3. The boot disk N4 actually takes, which is Hyperdisk and not Persistent
 *      Disk. `BOOT_DISK_TYPE` says why.
 *
 * `scripts/deploy/gcp/create-instance.sh` has been doing this by hand for a
 * developer's own box host. This module is that script's content, made part of
 * a deploy, so the fleet a stage runs is described in the same place as
 * everything else it runs — with the machine family moved forward to N4, which
 * has one CPU platform and therefore needs no `--min-cpu-platform` floor.
 *
 * The other thing that script does is `setup-kvm.sh`: on GCP the guest's
 * `/dev/kvm` is owned by `root:kvm` and the account the runner runs as is not
 * in that group, so it has to be added. That is the `prepareKvm` hook, and it
 * is the reason `stack/runner-boot.ts` has one at all.
 *
 * `deletionProtection` and `protect` are the counterparts of the AWS side's
 * `protect`: a runner holds state nothing else does, and a teardown that took
 * one with it would take every box running on it.
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
import { splitSecretRef } from './secret-env.ts'

/**
 * What each requested size answers to.
 *
 * N4, which is this cloud's counterpart of the EC2 instances the AWS side runs:
 * the current general-purpose family, on Emerald Rapids. Every one of these can
 * nest — the families that cannot are E2, the memory-optimised ones, and the
 * AMD-based ones other than N4D, and a host on one of those accepts work and
 * fails every box.
 */
export const MACHINE = { small: 'n4-standard-4', medium: 'n4-standard-8', large: 'n4-standard-16' } as const

/**
 * The only disk type N4 takes.
 *
 * Not a preference: the family does not attach Persistent Disk at all, so the
 * `pd-balanced` an earlier N2 fleet used is refused at create time rather than
 * silently downgraded. It is also why no `minCpuPlatform` is set below — N4 has
 * exactly one platform, and naming an older one (the `Intel Haswell` that N2
 * needed to be held above its floor) is rejected rather than treated as a
 * minimum that is already met.
 */
export const BOOT_DISK_TYPE = 'hyperdisk-balanced'

const IMAGE = 'ubuntu-os-cloud/ubuntu-2404-lts-amd64'

/**
 * The wrapper that fetches every secret this host reads, on every start.
 *
 * Fail-closed and retried, exactly as on AWS and for the same reason: at first
 * boot the service account's grants may not have propagated, and a host that
 * gave up would run without the credentials it needs rather than not run.
 */
const startWrapper = (secrets: { name: string; secret: string; version: string }[]): BootPlatform['startWrapper'] =>
  secrets.length === 0
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
  local name="$1" secret="$2" version="$3" value=""
  for attempt in 1 2 3 4 5; do
    value=$(gcloud secrets versions access "$version" --secret="$secret" --format='get(payload.data)' 2>/dev/null | base64 -d)
    [ -n "$value" ] && break
    echo "fetch of $name attempt $attempt failed; retrying in $((attempt * 5))s" >&2
    sleep $((attempt * 5))
  done
  if [ -z "$value" ]; then
    echo "FATAL: could not read $name from $secret; refusing to start without it" >&2
    exit 1
  fi
  export "$name=$value"
}
${secrets.map(({ name, secret, version }) => `fetch ${name} ${secret} ${version}`).join('\n')}
exec /usr/local/bin/boxlite-runner
STARTWRAP
chmod +x /usr/local/bin/boxlite-runner-start.sh
`,
      }

export const gcpRunnerProvider =
  ({
    project,
    zone,
    placement,
    artifactsBucket,
    adminApiKey,
    regionId,
    dependsOn,
  }: {
    project: string
    /** A zone. An instance is zonal even where its subnet is not. */
    zone: string
    placement: Extract<Placement, { cloud: 'gcp' }>
    /** Where a build-mode binary is staged. Read-only, and only under `runner/`. */
    artifactsBucket: string
    /** What registers the hosts the API does not seed. See `runner-registration.ts`. */
    adminApiKey: $util.Input<string>
    /** The region those rows go in — the same one the API seeded its own into. */
    regionId: string
    dependsOn: any[]
  }): RunnerProvider =>
  (request: RunnerRequest): Runners => {

    const platform: BootPlatform = {
      // Google's metadata server. `Metadata-Flavor` is what distinguishes a
      // real request from a browser that wandered onto the address.
      hostAddress: `HOST_IP=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/ip)`,
      installVolumeMount: `# gcsfuse, which is what mounts a box volume here.
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt gcsfuse-noble main" > /etc/apt/sources.list.d/gcsfuse.list
apt-get update
apt-get install -y gcsfuse`,
      /*
       * What `scripts/deploy/gcp/setup-kvm.sh` does, made part of the boot.
       *
       * The device exists as soon as nested virtualization is on, but it is
       * owned by `root:kvm` and the account the runner runs as is not in that
       * group. Without this the runner starts, accepts work, and fails every
       * box on a permission error against a device that is plainly there.
       */
      prepareKvm: `# The KVM device is present but not readable by the runner's account.
# This is scripts/deploy/gcp/setup-kvm.sh, applied at boot rather than by hand.
groupadd -f kvm
usermod -aG kvm root
cat > /etc/udev/rules.d/65-kvm.rules << 'KVMRULE'
KERNEL=="kvm", GROUP="kvm", MODE="0660"
KVMRULE
udevadm control --reload-rules
udevadm trigger --name-match=kvm || true`,
      startWrapper: null,
      unitEnvironment: {
        CLOUDSDK_CORE_PROJECT: project,
        /*
         * The collector is a Cloud Run service with an invoker list, and that
         * is enforced per request against a Google ID token — so a host on the
         * list that sends none is answered 403 by Google's front end and
         * exports nothing. This tells the runner to mint one from the metadata
         * server; `apps/libs/common-go/pkg/telemetry/gcp_idtoken.go` says why a
         * static `OTEL_EXPORTER_OTLP_HEADERS` cannot carry it.
         *
         * Only on this cloud: the AWS collector is behind an internal load
         * balancer that authorises no caller, and a host there has no metadata
         * server to ask.
         */
        OTEL_EXPORTER_OTLP_GOOGLE_ID_TOKEN: 'true',
      },
    }

    /*
     * The staged binary, readable by the hosts and by nothing else of theirs.
     *
     * Only when this deploy installs one: a release comes over public HTTPS and
     * needs no grant, and a stage that has never staged an object has no bucket
     * for a binding to attach to — which fails the apply rather than the
     * download. The condition is the GCS answer to the AWS policy's
     * `arn:…:::<bucket>/runner/*`: object viewer on this bucket, under that one
     * prefix.
     */
    const staged =
      request.binary.transport === 'gcs'
        ? [
            new gcp.storage.BucketIAMMember('RunnerArtifactsRead', {
              bucket: artifactsBucket,
              role: 'roles/storage.objectViewer',
              member: placement.serviceAccount.apply((email: string) => `serviceAccount:${email}`),
              condition: {
                title: 'runner-artifacts-only',
                description: 'Only the staged runner binaries, not the rest of the bucket',
                expression: `resource.name.startsWith("projects/_/buckets/${artifactsBucket}/objects/runner/")`,
              },
            }),
          ]
        : []

    const assignments = request.fleet

    const instances = assignments.map(({ slot, token }) => {
      const userData = $resolve([
        request.apiUrl,
        request.otlpUrl,
        $resolve(Object.values(request.secrets)),
        // Resolved, not cast. See the note in `renderRunnerBoot`: these values
        // are `Input<string>` and the composition root sets
        // `OTEL_EXPORTER_OTLP_ENDPOINT` from the collector's own URL, so an
        // unresolved one is rendered as Pulumi's `[toString]` refusal text and
        // the host ships telemetry to that instead of to the collector.
        $resolve(Object.values(request.environment)),
        token,
      ]).apply(([apiUrl, otlpUrl, references, resolved, hostToken]) => {
        const secrets = Object.keys(request.secrets).map((name, index) => ({
          name,
          ...splitSecretRef((references as string[])[index] as string),
        }))
        return renderRunnerBoot({
          apiUrl: apiUrl as string,
          otlpUrl: otlpUrl as string,
          // Plain strings: the binary comes from the checkout, not from another
          // resource, so there is nothing here to resolve.
          binary: request.binary,
          port: RUNNER_PORT,
          environment: {
            ...Object.fromEntries(
              Object.keys(request.environment).map((name, index) => [name, String((resolved as string[])[index])]),
            ),
            BOXLITE_RUNNER_NAME: slot.controlPlaneRunnerName,
            // Last, so this host's own token wins over the fleet-wide one the
            // store delivered. Every host but the first has its own.
            [RUNNER_TOKEN_VARIABLE]: hostToken as string,
          },
          platform: { ...platform, startWrapper: startWrapper(secrets) },
        })
      })

      return new gcp.compute.Instance(
        slot.resourceName,
        {
          name: slot.nameTag,
          project,
          zone,
          machineType: MACHINE[request.size],
          // Explicitly, or the device is absent on a machine that can host it.
          advancedMachineFeatures: { enableNestedVirtualization: request.nestedVirtualization },
          bootDisk: {
            initializeParams: { image: IMAGE, size: request.rootDiskGb, type: BOOT_DISK_TYPE },
          },
          networkInterfaces: [
            {
              subnetwork: placement.subnetwork,
              /*
               * No external address, and so image pulls go out through Cloud
               * NAT rather than each host's own.
               *
               * The AWS side gives a runner a public address because it pulls
               * box images constantly and a shared NAT is a shared throughput
               * ceiling. That reasoning does not survive contact with
               * `constraints/compute.vmExternalIpAccess`: an organization that
               * forbids external addresses refuses the instance outright —
               * `Constraint … violated`, at create — so the choice is Cloud NAT
               * or no fleet. Cloud NAT it is, and if the ceiling ever bites,
               * the fix is more NAT addresses rather than a policy exemption
               * per host.
               */
            },
          ],
          serviceAccount: { email: placement.serviceAccount, scopes: ['cloud-platform'] },
          /*
           * OS Login, explicitly, because the in-place binary upgrade signs in.
           *
           * Without it gcloud falls back to writing an SSH key into project-wide
           * metadata, which grants that key every instance in the project and
           * outlives the deploy that wrote it. With it, access is an IAM
           * question — `roles/compute.osAdminLogin`, which `bootstrap/gcp.ts`
           * grants the deployer alone — and the key gcloud mints is scoped to
           * that identity and expires.
           */
          metadata: { 'enable-oslogin': 'TRUE' },
          // The boot script is base64 on AWS and plain text here, which is the
          // one place the two clouds want the same value differently.
          metadataStartupScript: userData.apply((encoded: string) =>
            Buffer.from(encoded, 'base64').toString('utf8'),
          ),
          labels: { 'boxlite-runner': slot.controlPlaneRunnerName.toLowerCase().replace(/[^a-z0-9_-]/g, '-') },
          // A host holds boxes. A teardown that took one with it would take
          // every box running on it.
          deletionProtection: true,
        },
        {
          // The boot script only ever runs once, and a newer image or a version
          // bump must not replace a machine with running boxes on it. Both are
          // landed on a live host out of band, one at a time.
          ignoreChanges: ['bootDisk', 'metadataStartupScript'],
          protect: true,
          // The read grant among them: a host whose boot script fetches the
          // staged object before the binding exists downloads nothing, and
          // that boot never happens again.
          dependsOn: [...dependsOn, ...staged],
        },
      )
    })

    /*
     * How a new binary reaches the hosts above, which the boot script cannot.
     *
     * `metadataStartupScript` is ignored after the first boot and the instance
     * is protected, so a deploy that changes the binary changes nothing on a
     * host that already exists — "at boot" means "never" here. These land it in
     * place over a tunnelled ssh; `src/upgrade-runners.ts` records why that is
     * the channel on this cloud, and why the answer differs from the one
     * `providers/gcp/clickhouse.ts` reached for its own reconcile.
     *
     * One command per host, chained, exactly as on AWS: the dependency graph
     * keeps two hosts from restarting at once, and a failure stops the chain.
     */
    let previousUpgrade: any
    for (const [index, instance] of instances.entries()) {
      const { slot } = assignments[index]
      // No region: a GCP stage installs a published release. A build-mode binary
      // is staged in S3, which this cloud has no bucket for — `runner-binary.ts`
      // refuses that combination before any of this runs.
      const payload = encodeUpgradePayload({
        identity: request.binary.identity,
        binary: request.binary,
        port: RUNNER_PORT,
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
            RUNNER_UPGRADE_CLOUD: 'gcp',
            // The instance's name, which is what `gcloud compute ssh` takes.
            RUNNER_UPGRADE_TARGET: slot.nameTag,
            RUNNER_UPGRADE_LABEL: slot.controlPlaneRunnerName,
            RUNNER_UPGRADE_IDENTITY: request.binary.identity,
            RUNNER_UPGRADE_PAYLOAD: payload,
            GCP_PROJECT: project,
            GCP_ZONE: zone,
          },
          // The identity and the address it came from. See the AWS side's note:
          // no digest, because the stack never reads one — and re-running on
          // every deploy would restart a converged fleet for nothing.
          triggers: [upgradeTrigger({ identity: request.binary.identity, binary: request.binary }), instance.id],
        },
        /*
         * The host, and whatever the caller said has to exist first.
         *
         * `dependsOn` carries the network's own rules, `RunnerIapFirewall`
         * among them — see `stack/index.ts`. Without that rule the tunnel
         * cannot open at all, and gcloud would spend the whole connect window
         * failing against a host that is perfectly healthy.
         */
        { dependsOn: [instance, ...dependsOn, ...(previousUpgrade ? [previousUpgrade] : [])] },
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
