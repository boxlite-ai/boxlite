/*
 * How a new runner binary reaches a host that already exists.
 *
 * Both providers create a runner with the boot script and the image in
 * `ignoreChanges`, because a host holds state nothing else in the stack does —
 * `/var/lib/boxlite` and the libkrun VMs in its memory. That is the right call
 * and it has one consequence: a deploy that changes which binary the fleet
 * should run changes nothing at all. The boot script runs once, at first boot,
 * and a `protect: true` instance is never replaced, so "installed at boot" means
 * "never" for every host that already exists.
 *
 * So the version is landed in place instead: the binary under
 * `/usr/local/bin/boxlite-runner` is replaced and the unit restarted, and the
 * machine is not touched. This module is the half that is the same on both
 * clouds — what the host is asked to do, and how a run is keyed — while each
 * provider builds the command resource and supplies the transport, because
 * constructing resources is a provider's job.
 *
 * One host at a time, and structurally rather than in a script: each provider
 * creates one command per host and chains them with `dependsOn`, so the
 * dependency graph is what keeps two hosts from restarting at once, and a
 * failure stops the chain with the unvisited hosts still serving the old binary.
 *
 * The host is *not* drained first: boxes on the host being upgraded take the
 * restart. Cordoning through the admin API needs a control-plane runner id, an
 * operator key and the organization-infrastructure flag, none of which a deploy
 * has — the same trade the incumbent path made, recorded rather than implied.
 *
 * What the payload converges on is the identity the runner reports on its own
 * health route, not a file it wrote. A marker file says what an install
 * intended; the health route says what is actually serving, which is the only
 * answer that repairs a host whose last upgrade half-finished.
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactFetchCommand, verifyAgainstManifest } from './runner-binary.ts'
import type { RunnerBinary, RunnerSlot } from './runners.ts'

/** Stable X.Y.Z, optionally carrying the commit a build was produced from. */
const BINARY_IDENTITY = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(\+[0-9a-f]{40})?$/
const TARBALL_NAME = /^[A-Za-z0-9._-]+\.tar\.gz$/

export class RunnerUpgradeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerUpgradeError'
  }
}

/**
 * The launcher, and the directory it is relative to.
 *
 * Both derived exactly as `runner-registration.ts` derives its own, and for the
 * same two reasons: a local command runs from the engine's own cwd so the
 * directory has to be given, and `$cli` is a name only SST defines — a GCP
 * deploy that reached for it died on `$cli is not defined`. The `.mjs` shim's
 * path is recorded in the engine's state, so it stays stable while the
 * implementation moves.
 */
export const upgradeDir = (): string =>
  // stack/ → mdeploy/ → apps/infra, which is where `scripts/` lives.
  dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export const UPGRADE_RUNNER_COMMAND = 'node scripts/upgrade-runner-binary.mjs'

/**
 * The payload's first line, and the only way to know it ran at all.
 *
 * An exit code cannot tell "the payload refused" from "nothing ever reached the
 * host": both come back as a small non-zero number. `gcloud compute ssh` exits
 * 255 for its own transport failures — but not for all of them, and the one
 * that proved it is worth recording: an external-organization identity is
 * refused OS Login before any session opens, and gcloud exits **1**, which read
 * as the payload's own refusal and sent a reader to look at a host the run had
 * never touched.
 *
 * So the payload announces itself instead. Present in the output means the
 * exit code is a verdict about the runner; absent means it is a verdict about
 * the channel, and the CLI's stderr is the diagnosis.
 */
export const ON_HOST = 'boxlite-runner-upgrade: running on the host'

/**
 * One host's upgrade, named after the host it upgrades.
 *
 * Derived from the slot's resource name rather than from the control-plane name,
 * and the difference matters: the control-plane name of the first host is
 * `DEFAULT_RUNNER_NAME`, which a stage may set to anything, so a resource keyed
 * on it would be replaced — a create and a delete — the day someone renamed a
 * runner. `resourceName` is the stable half, which is why `stack-env.ts` keeps
 * the two apart in the first place. The prefix swap also keeps the first host's
 * command at one fixed name, which is what `plan.ts` can list as a target.
 */
export const upgradeResourceName = (slot: RunnerSlot): string =>
  slot.resourceName.replace(/^Runner/, 'UpgradeRunnerBinary')

/**
 * What a host is asked to end up running.
 *
 * `identity` rather than `version` because that is what it is compared against:
 * a build's is `X.Y.Z+<commit>`, and two builds of one checkout are otherwise
 * indistinguishable on the wire — an upgrade that could not tell them apart
 * would skip every dev deploy after the first.
 */
export type UpgradeTarget = {
  identity: string
  /** The same pair the boot script installs from. See `runner-binary.ts`. */
  binary: RunnerBinary
  /** The port the health route answers on. */
  port: number
  /** The region an `s3://` object is read from. Null for a public asset. */
  region?: string | null
  /** Force an older binary over a newer one. A real rollback, asked for. */
  allowDowngrade?: boolean
}

/**
 * The one thing that should make a host's upgrade run again.
 *
 * The identity and the address, which together are everything about the run
 * that could change. Not the digest: the stack never reads one — the host does,
 * from the manifest beside the tarball — so a republished asset under one
 * version is a case this cannot see, and `runner-binary.ts` records that as the
 * cost of resolving from the checkout rather than on the deployer.
 *
 * The instance id is added by the provider, because a replaced host is also due
 * an upgrade.
 */
export const upgradeTrigger = (target: Pick<UpgradeTarget, 'identity'> & { binary: Pick<RunnerBinary, 'tarballName'> }): string =>
  `${target.identity}:${target.binary.tarballName}`

/**
 * Never move a host backwards by accident.
 *
 * Ordering only means something between releases: two commits of one checkout
 * version are neither older nor newer than each other, so in build mode "install
 * this commit" can only mean install it. A host serving something newer than the
 * target is usually a deliberate hand-install, and silently reverting it during
 * an unrelated deploy is a nasty surprise — so it is refused, not reverted.
 *
 * `sort -V` orders release cores correctly (0.9.10 above 0.9.9) but gets
 * prereleases backwards, so semver's "a prerelease precedes its release" is
 * applied by hand. The target is always a stable X.Y.Z, so only the live side
 * can carry a suffix; build metadata is stripped because semver ignores it for
 * precedence — otherwise a release deploy would read `0.9.7+abc` as newer than
 * `0.9.7` and refuse to replace a dev build.
 */
const downgradeGuard = (source: RunnerBinary['source']): string =>
  source === 'build'
    ? '# Build mode: no ordering to guard, the requested commit is the requested commit.\n'
    : `live_is_newer() {
  cur_core=\${CURRENT%%-*}
  cur_core=\${cur_core%%+*}
  tgt_core=\${TARGET%%-*}
  if [ "$cur_core" != "$tgt_core" ]; then
    [ "$(printf '%s\\n%s\\n' "$cur_core" "$tgt_core" | sort -V | tail -1)" = "$cur_core" ]
    return $?
  fi
  # Same core, so live is a prerelease or a build of the target — both of which
  # semver puts first, meaning they are due this upgrade.
  return 1
}

if [ "\${ALLOW_DOWNGRADE:-}" != "1" ] && live_is_newer; then
  echo "WARNING: live $CURRENT is newer than target $TARGET; refusing to downgrade (set ALLOW_DOWNGRADE=1 to force)"
  exit 0
fi
`

/**
 * The script one host runs, as root, over whichever channel its cloud offers.
 *
 * Every value interpolated below is validated first, here rather than only at
 * the resolver: this text runs as root on a host that runs untrusted code, so
 * the module that emits it is the one that has to be sure.
 *
 * The order is the whole design and each step earns its place:
 *
 *   1. Bail out if the host is still bootstrapping. A freshly created instance
 *      reports `running` — all the engine waits for — long before cloud-init has
 *      installed the binary and written the unit, and its boot script installs
 *      this very identity. Swapping against a missing unit would fail and roll
 *      back a host that was coming up fine. `is-enabled` is the last of the
 *      three to become true, so it also covers the window where the unit exists
 *      but has not been started yet.
 *   2. Converge, don't reinstall. A host already serving the target is left
 *      completely alone, which is what makes running this on every deploy free
 *      of gratuitous restarts. Past step 1, an unreachable probe means
 *      installed-but-unhealthy — not skipped, because a swap is what repairs it.
 *   3. Download and verify BEFORE stopping the unit, so a failed or corrupt
 *      fetch never takes a runner down.
 *   4. Swap, start, and wait for the health route to report the target. The
 *      caller must not move to the next host until this one is actually serving
 *      the new binary, so process-alive is not a sufficient signal.
 *   5. Roll back on any failure in step 4 — the whole sequence is one guarded
 *      condition, because `set -e` exempts if-conditions and would otherwise
 *      abort before the rollback could run.
 */
export const renderUpgradePayload = (target: UpgradeTarget): string => {
  if (!BINARY_IDENTITY.test(target.identity)) {
    throw new RunnerUpgradeError(
      `the target identity must be X.Y.Z or X.Y.Z+<commit>; got ${JSON.stringify(target.identity)}`,
    )
  }
  if (!TARBALL_NAME.test(target.binary.tarballName)) {
    throw new RunnerUpgradeError(
      `the tarball name reaches an awk pattern and a shell; got ${JSON.stringify(target.binary.tarballName)}`,
    )
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535) {
    throw new RunnerUpgradeError(`the health port must be a whole number from 1 to 65535; got ${target.port}`)
  }
  const region = target.region ?? null
  const fetch = (url: string, destination: string) =>
    artifactFetchCommand({ artifact: target.binary, url, destination, region })

  return `set -euo pipefail
echo "${ON_HOST}"

TARGET="${target.identity}"
HEALTH="http://127.0.0.1:${target.port}/"
ALLOW_DOWNGRADE="${target.allowDowngrade ? '1' : ''}"

# The binary parses no CLI arguments, so there is no --version to ask. Of the
# places that do report one, this health route is the only one reachable here
# without a token: /info is auth-gated and the healthcheck service only pushes
# to the control plane. Empty output means the runner is not serving.
probe_identity() {
  curl -fsS --max-time 3 "$HEALTH" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'
}

if [ ! -x /usr/local/bin/boxlite-runner ] ||
  [ ! -f /etc/systemd/system/boxlite-runner.service ] ||
  ! systemctl is-enabled --quiet boxlite-runner 2>/dev/null; then
  echo "still bootstrapping (binary or unit not in place, or not enabled); the boot script installs $TARGET itself — nothing to do"
  exit 0
fi

CURRENT=$(probe_identity || true)
echo "current identity: \${CURRENT:-<not serving>}"
if [ "$CURRENT" = "$TARGET" ]; then
  echo "already serving $TARGET; leaving the unit untouched"
  exit 0
fi

${downgradeGuard(target.binary.source)}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
${fetch(target.binary.tarballUrl, '$WORK/runner.tar.gz')}
${fetch(target.binary.checksumUrl, '$WORK/runner.sha256')}
${verifyAgainstManifest({ tarballName: target.binary.tarballName, tarball: '$WORK/runner.tar.gz', manifest: '$WORK/runner.sha256' })}
tar -xzf "$WORK/runner.tar.gz" -C "$WORK"
test -x "$WORK/boxlite-runner" || { echo "FATAL: the tarball has no boxlite-runner binary" >&2; exit 1; }

# Back up the live binary so a failed swap or start can roll back.
HAD_PREVIOUS=false
if [ -x /usr/local/bin/boxlite-runner ]; then
  cp -a /usr/local/bin/boxlite-runner /usr/local/bin/boxlite-runner.bak
  HAD_PREVIOUS=true
fi
systemctl stop boxlite-runner || true

wait_for_target() {
  for _ in $(seq 1 30); do
    [ "$(probe_identity || true)" = "$TARGET" ] && return 0
    sleep 2
  done
  return 1
}

if install -m 0755 "$WORK/boxlite-runner" /usr/local/bin/boxlite-runner \\
  && systemctl daemon-reload \\
  && systemctl start boxlite-runner \\
  && systemctl is-active --quiet boxlite-runner \\
  && wait_for_target; then
  if [ "$HAD_PREVIOUS" = true ]; then rm -f /usr/local/bin/boxlite-runner.bak; fi
  echo "systemd unit: active"
  echo "new identity: $(probe_identity)"
else
  echo "upgrade failed; rolling back" >&2
  if [ "$HAD_PREVIOUS" = true ]; then
    mv -f /usr/local/bin/boxlite-runner.bak /usr/local/bin/boxlite-runner
    systemctl restart boxlite-runner || true
  fi
  journalctl -u boxlite-runner --no-pager -n 50 || true
  exit 1
fi
`
}

/**
 * The payload as the launcher receives it: base64, so it is one shell token.
 *
 * Handed over encoded rather than quote-escaped because both transports put it
 * inside another command line — SSM's `commands=[...]` shorthand and ssh's
 * remote command — and a multi-line script with shell metacharacters in it does
 * not survive either intact.
 */
export const encodeUpgradePayload = (target: UpgradeTarget): string =>
  Buffer.from(renderUpgradePayload(target)).toString('base64')
