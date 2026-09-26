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

import { RUNNER_ENV_FILE, runnerApiUrl } from './runner-boot.ts'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactFetchCommand, verifyAgainstManifest } from './runner-binary.ts'
import type { RunnerBinary, RunnerSlot } from './runners.ts'

/** Stable X.Y.Z, optionally carrying the commit a build was produced from. */
const BINARY_IDENTITY = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(\+[0-9a-f]{40})?$/
const TARBALL_NAME = /^[A-Za-z0-9._-]+\.tar\.gz$/
/**
 * An origin the unit environment is converged onto, as tight as the places it
 * is interpolated.
 *
 * The control plane's and the collector's, which are checked by one rule
 * because they run the same risk: each lands inside a single-quoted assignment
 * and inside the `awk` invocation that rewrites the file, both in a script that
 * runs as root — so a quote or a pipe in one is not a malformed URL but a
 * command. An allowlist rather than an escape, for the reason the other two
 * here are.
 */
const UNIT_ENV_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/
/** The object store a host mounts a volume from, as this module will spell it. */
const VOLUME_BACKEND = /^[a-z0-9]+$/

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
 * command at one fixed name, so the fleet's upgrades sit in the graph under it.
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
  /**
   * Where the control plane answers, so a host that predates a domain move can
   * be told.
   *
   * Absent for two kinds of caller, and for different reasons. The OS-policy
   * renderers describe the binary alone, because GCP converges the environment
   * through a resource of its own. `runner:update` rolls a release by hand and
   * never reads the stage's environment, so it has no address to enforce —
   * inventing one there would rewrite a host from a value nobody supplied.
   */
  apiUrl?: string | null
  /**
   * Where the collector accepts OTLP, so a host whose boot script wrote an
   * empty one can be told.
   *
   * Absent for the same two callers `apiUrl` is absent for, and for the same
   * reasons. Never empty: see `assertUnitEnvironment`.
   */
  otlpUrl?: string | null
  /**
   * Which object store a volume is mounted from, or null where the boot script
   * writes no such key. The cloud's answer: only the GCP hosts carry gcsfuse,
   * and an AWS host that were handed one would disagree with its own boot
   * script forever.
   */
  volumeBackend?: string | null
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
const assertUpgradeTarget = (target: UpgradeTarget): void => {
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
  assertUnitEnvironment(target)
}

/**
 * The values the unit environment is converged onto, checked wherever they are
 * given.
 *
 * All three reach a single-quoted assignment and an awk invocation that run as
 * root, which is the rule every other interpolated value in this module follows.
 *
 * Absent and empty are deliberately not one answer. Absent means a caller with
 * nothing to enforce — `runner:update`, which reads no stage environment — and
 * the key is then left out of the expected set entirely, so the host keeps
 * whatever it holds. Empty means the stage composed nothing, which is the very
 * state this convergence exists to repair: a host converged onto
 * `OTEL_EXPORTER_OTLP_ENDPOINT=` would be restarted onto the one value the
 * runner reads as "do not export" — the policy enforcing the bug. So an empty
 * value is refused here rather than shipped to a fleet.
 */
const assertUnitEnvironment = ({
  apiUrl,
  otlpUrl,
  volumeBackend,
}: Pick<UpgradeTarget, 'apiUrl' | 'otlpUrl' | 'volumeBackend'>): void => {
  if (apiUrl != null && !UNIT_ENV_URL.test(apiUrl)) {
    throw new RunnerUpgradeError(
      `the control plane's URL reaches a single-quoted assignment and an awk invocation that run as root, ` +
        `so it is checked here even though the stack composed it; got ${JSON.stringify(apiUrl)}`,
    )
  }
  if (otlpUrl != null && !UNIT_ENV_URL.test(otlpUrl)) {
    throw new RunnerUpgradeError(
      `the collector's URL reaches the same two places, and an empty one would converge the fleet onto ` +
        `the value that silences its exporter; got ${JSON.stringify(otlpUrl)}`,
    )
  }
  if (volumeBackend != null && !VOLUME_BACKEND.test(volumeBackend)) {
    throw new RunnerUpgradeError(`the volume backend reaches the same two places; got ${JSON.stringify(volumeBackend)}`)
  }
}

/** What the host is and how to ask what it is serving. Both scripts open with it. */
const preamble = (target: UpgradeTarget): string => `set -euo pipefail
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

`

/**
 * Steps 1 and 2: the two checks that mean there is nothing to do, ended however
 * the caller grades that.
 *
 * Three gradings share them, and each reads "nothing to do" as *in the desired
 * state*: a payload exits 0, an OS policy's `validate` exits 100 — which is what
 * keeps `enforce` off a host that is still bootstrapping or already serving the
 * target — and the binary half of a combined payload returns, so the unit
 * environment after it still runs. Passing the statement rather than a code is
 * what keeps one copy of the checks.
 */
const guards = (satisfied: string): string => `if [ ! -x /usr/local/bin/boxlite-runner ] ||
  [ ! -f /etc/systemd/system/boxlite-runner.service ] ||
  ! systemctl is-enabled --quiet boxlite-runner 2>/dev/null; then
  echo "still bootstrapping (binary or unit not in place, or not enabled); the boot script installs $TARGET itself — nothing to do"
  ${satisfied}
fi

CURRENT=$(probe_identity || true)
echo "current identity: \${CURRENT:-<not serving>}"
if [ "$CURRENT" = "$TARGET" ]; then
  echo "already serving $TARGET; leaving the unit untouched"
  ${satisfied}
fi

`

/** Steps 3 to 5, in the shell's own grading: fall off the end, or exit 1. */
const swapSequence = (target: UpgradeTarget): string => {
  const region = target.region ?? null
  const fetch = (url: string, destination: string) =>
    artifactFetchCommand({ artifact: target.binary, url, destination, region })
  return `${downgradeGuard(target.binary.source)}
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

export const renderUpgradePayload = (target: UpgradeTarget): string => {
  assertUpgradeTarget(target)
  return `${preamble(target)}${guards('exit 0')}${swapSequence(target)}`
}

/**
 * The same work as an OS policy's two scripts, graded by exit code.
 *
 * `validate` answers the two guards and nothing else: 100 means the host is in
 * the desired state, 101 is the only answer that makes the agent run `enforce`.
 * `enforce` is the tail of the same script — it re-checks nothing, because the
 * agent reaches it only after `validate` said to.
 */
export type UpgradePolicyScripts = { validate: string; enforce: string }

/**
 * The interpreter, spelled in the file rather than named in the resource.
 *
 * `interpreter: SHELL` is `/bin/sh`, which on Ubuntu is dash: the very first
 * line of this payload — `set -euo pipefail` — is a bashism there, and dash
 * answers `Illegal option -o pipefail` with exit 2. To the agent that is
 * neither 100 nor 101 but an execution error, so the host reports UNKNOWN and
 * nothing is ever attempted. `NONE` runs the file itself, which is what makes
 * this line the one that chooses the shell.
 */
const SHEBANG = '#!/bin/bash\n'

export const renderPolicyScripts = (target: UpgradeTarget): UpgradePolicyScripts => {
  assertUpgradeTarget(target)
  return {
    validate: `${SHEBANG}${preamble(target)}${guards('exit 100')}echo "not serving $TARGET"
exit 101
`,
    /*
     * The payload verbatim, in its own shell, with only its final status
     * translated.
     *
     * Re-grading it line by line would mean teaching `verifyAgainstManifest`
     * and the downgrade guard — both shared with the boot script, where 0 and 1
     * are exactly right — a second vocabulary. A heredoc keeps one copy of the
     * work and one place where 0 becomes 100.
     */
    enforce: `${SHEBANG}set -u
bash <<'BOXLITE_RUNNER_UPGRADE'
${renderUpgradePayload(target)}
BOXLITE_RUNNER_UPGRADE
status=$?
if [ "$status" -eq 0 ]; then exit 100; fi
exit 101
`,
  }
}

/**
 * The unit environment a host must converge on, for the keys a deploy moves.
 *
 * `BOXLITE_API_URL` and `OTEL_EXPORTER_OTLP_ENDPOINT` are written once, at
 * first boot, from `api.address` and the collector's own URL, and nothing
 * rewrites them afterwards: the script that wrote them is in `ignoreChanges` on
 * both clouds — `userDataBase64` on AWS, `metadataStartupScript` on GCP — and a
 * `protect: true` instance is never replaced. So a stage that changes its
 * domain leaves every existing host calling a name that no longer resolves, and
 * a stage whose hosts were created before it had a collector leaves them with
 * an empty endpoint, which the runner reads as "do not export" and which no
 * redeploy can reach.
 *
 * The work is here, once, because two transports and one desired-state engine
 * all need it and none of them may disagree about what "converged" means. The
 * restart is the cost and it is not hidden: boxes on the host take it, which is
 * why nothing runs until the two checks above say the file actually disagrees.
 */
export const unitEnvironmentBlock = ({
  apiUrl,
  otlpUrl,
  volumeBackend,
}: Pick<UpgradeTarget, 'otlpUrl' | 'volumeBackend'> & { apiUrl: string }): string => {
  assertUnitEnvironment({ apiUrl, otlpUrl, volumeBackend })
  // An array, so an optional key is absent rather than empty: an AWS host's
  // boot script writes no backend, and a caller that supplied no collector has
  // no endpoint to enforce. Pinning either as a blank line would leave every
  // such host disagreeing with itself forever, or restart it onto nothing.
  // Verbatim, unlike the address: the boot script writes this one as it stands.
  const expected = [
    `'BOXLITE_API_URL=${runnerApiUrl(apiUrl)}'`,
    ...(otlpUrl ? [`'OTEL_EXPORTER_OTLP_ENDPOINT=${otlpUrl}'`] : []),
    ...(volumeBackend ? [`'VOLUME_STORAGE_BACKEND=${volumeBackend}'`] : []),
  ].join(' ')
  /*
   * Prefixed names, because this block is concatenated after the binary half,
   * whose own `EXPECTED` holds the manifest digest — two meanings under one
   * name in one script is a payload that reads correctly and converges the
   * wrong thing.
   *
   * The path takes an override so the rewrite can be executed by a test rather
   * than only matched as text: the shell is what runs on the host, and a
   * pattern asserted against it proves nothing about what it does. Nothing sets
   * that variable anywhere — an OS policy and an SSM command each start from a
   * clean environment, so the default is what every host uses.
   */
  return `UNIT_ENV_FILE="\${BOXLITE_RUNNER_ENV_FILE:-${RUNNER_ENV_FILE}}"
UNIT_ENV_EXPECTED=(${expected})

unit_environment_matches() {
  local line
  for line in "\${UNIT_ENV_EXPECTED[@]}"; do
    grep -qxF "$line" "$UNIT_ENV_FILE" || return 1
  done
}

# Bail out as settled while a host is still bootstrapping: the boot script
# writes this file itself, and enforcing against a file that does not exist yet
# would restart a unit that has not started once.
unit_environment_settled() {
  if [ ! -f "$UNIT_ENV_FILE" ] || ! systemctl is-enabled --quiet boxlite-runner 2>/dev/null; then
    echo "still bootstrapping; the boot script writes $UNIT_ENV_FILE itself — nothing to do"
    return 0
  fi
  if unit_environment_matches; then
    echo "already pointed at the current control plane, with the keys this cloud writes"
    return 0
  fi
  return 1
}

# Rewrite each key the file names, in place, and append the ones it does not.
# One awk pass per key does both and keeps the order, and the value travels as a
# variable rather than inside the program — an address carrying a pipe or an
# ampersand would be a sed expression that rewrote something else. Called from a
# condition, so a failure returns here rather than ending the script with the
# backup still on disk.
rewrite_unit_environment() {
  local line key next
  next="$UNIT_ENV_FILE.next"
  for line in "\${UNIT_ENV_EXPECTED[@]}"; do
    key="\${line%%=*}"
    # In a subshell with a tight umask: this file holds the whole environment,
    # token included, for as long as the rewrite takes — at the default umask
    # that is a world-readable copy of it, however briefly.
    if ! (umask 077; awk -v key="$key" -v line="$line" '
      $0 ~ "^" key "=" { print line; found = 1; next }
      { print }
      END { if (!found) print line }
    ' "$UNIT_ENV_FILE" > "$next"); then
      rm -f "$next"
      return 1
    fi
    # Written back into the file rather than renamed over it. The boot script
    # ends with chmod 640 because this carries BOXLITE_RUNNER_TOKEN, and a
    # rename would put the umask's mode on it instead — 644 under the default,
    # which is the token readable by every account on the host. Truncating the
    # original keeps its mode, its owner and its inode.
    if ! cat "$next" > "$UNIT_ENV_FILE"; then
      rm -f "$next"
      return 1
    fi
    rm -f "$next"
  done
}

converge_unit_environment() {
  if unit_environment_settled; then return 0; fi
  # The copy carries BOXLITE_RUNNER_TOKEN, so it is removed on every path out.
  cp -a "$UNIT_ENV_FILE" "$UNIT_ENV_FILE.bak"
  if ! rewrite_unit_environment || ! unit_environment_matches; then
    echo "rewrite did not take; restoring" >&2
    mv "$UNIT_ENV_FILE.bak" "$UNIT_ENV_FILE"
    return 1
  fi
  rm -f "$UNIT_ENV_FILE.bak"
  echo "the unit environment named something this stage no longer serves; rewritten"
  systemctl restart boxlite-runner
}
`
}

/**
 * The same convergence, as the two scripts an OS policy grades by exit code.
 *
 * GCP's half. Declared as desired state for the same reason the binary is, and
 * carried by the same assignment so one host moves at a time: an OS policy is
 * project IAM, where ssh would need a POSIX identity an account outside the
 * instance's organization cannot be granted. What it converges, and why a host
 * cannot be told any other way, is above `unitEnvironmentBlock`.
 */
export const renderUnitEnvironmentPolicyScripts = ({
  apiUrl,
  otlpUrl,
  volumeBackend,
}: Pick<UpgradeTarget, 'otlpUrl' | 'volumeBackend'> & { apiUrl: string }): UpgradePolicyScripts => {
  const block = `set -euo pipefail
${unitEnvironmentBlock({ apiUrl, otlpUrl, volumeBackend })}`
  return {
    validate: `${SHEBANG}${block}
if unit_environment_settled; then exit 100; fi
echo "the unit environment names something this stage no longer serves"
exit 101
`,
    /*
     * The same block, in its own shell, with only its final status translated —
     * the shape the binary's `enforce` already uses, and for the same reason: a
     * second grading of the same work is a second place for the two to drift.
     */
    enforce: `${SHEBANG}set -u
bash <<'BOXLITE_RUNNER_UNIT_ENV'
${block}
converge_unit_environment
BOXLITE_RUNNER_UNIT_ENV
status=$?
if [ "$status" -eq 0 ]; then exit 100; fi
exit 101
`,
  }
}

/**
 * Everything one command has to do to a host, for the transports that send one.
 *
 * SSM and ssh carry a script rather than a desired state, so both halves travel
 * together: the binary first, then the unit environment — the order GCP's two
 * policy resources run in. One command per host is also what keeps the restarts
 * to the host whose turn it is; two would let each restart it in its own time.
 *
 * The binary half becomes a function so that "already serving this identity"
 * ends that half rather than the payload, which is the case where only the
 * environment has moved — a stage that changed its domain and nothing else.
 */
export const renderHostConvergence = (target: UpgradeTarget): string => {
  assertUpgradeTarget(target)
  const binary = `upgrade_binary() {
${guards('return 0')}${swapSequence(target)}}
`
  const environment = target.apiUrl
    ? `${unitEnvironmentBlock({ apiUrl: target.apiUrl, otlpUrl: target.otlpUrl, volumeBackend: target.volumeBackend })}
converge_unit_environment
`
    : ''
  return `${preamble(target)}${binary}upgrade_binary
${environment}`
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
  Buffer.from(renderHostConvergence(target)).toString('base64')
