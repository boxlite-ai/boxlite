// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Rolling in-place upgrade of the boxlite-runner binary on live Runner EC2s.
 *
 * The Runner resources in sst.config.ts carry `ignoreChanges: ['ami','userDataBase64']`,
 * so a Cargo.toml version bump is detected but never acted on — `sst deploy` will not
 * replace a runner that holds box state (/var/lib/boxlite + in-memory libkrun VMs).
 * This is how the new version actually lands: /usr/local/bin/boxlite-runner is replaced
 * over SSM and the systemd unit restarted. The instance is not touched.
 *
 * One host at a time. On the deploy path each `UpgradeRunnerBinary-*` command handles a
 * single instance and Pulumi's dependsOn chain sequences them; invoked by hand it walks
 * the discovered fleet in the same order. Either way a failure stops the roll, so the
 * hosts not yet visited keep serving the old binary.
 *
 * The runner is NOT drained first: boxes on the host being upgraded take the restart.
 * Cordoning through the admin API needs a control-plane runner id, an operator key, and
 * the organization-infrastructure flag, none of which the deploy path has.
 *
 * Usage:
 *   npm run runner:update                  # version from Cargo.toml, every running runner
 *   npm run runner:update -- 0.9.5         # explicit version
 *   INSTANCE_IDS=i-abc npm run runner:update
 *
 * Env:
 *   RUNNER_VERSION   target version (argv[2] wins; falls back to the workspace version)
 *   INSTANCE_IDS     comma-separated EC2 ids; unset = discover by tag:Name=boxlite-runner-*
 *   AWS_REGION       default ap-southeast-1
 *   RUNNER_PORT      port the runner's health route listens on (default 3003)
 *   ALLOW_DOWNGRADE  set to 1 to permit replacing a runner with an OLDER version
 */

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { readWorkspaceVersion } from './deployment-environment.mjs'
import { resolveRunnerReleaseAssets } from './runner-release-assets.mjs'

const REGION = process.env.AWS_REGION || 'ap-southeast-1'
const RUNNER_PORT = process.env.RUNNER_PORT || '3003'
const NAME_TAG_PATTERN = 'boxlite-runner-*'
// ~5 min at 10s apart — covers SSM agent registration on a freshly created instance.
const SSM_REGISTRATION_ATTEMPTS = 30
// ~10 min at 5s apart — comfortably above the payload's own worst case (release download
// plus the 60s readiness gate), so a slow host is never mistaken for a failed one.
const SSM_COMPLETION_ATTEMPTS = 120

// ── aws CLI ──────────────────────────────────────────────────────────────────
// Shelling out to the CLI (rather than adding an @aws-sdk dependency) matches
// scripts/sst-with-cloudflare.mjs and keeps this package dependency-free.

function runAws(args) {
  const result = spawnSync('aws', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new Error('the `aws` CLI is required but was not found on PATH')
    throw new Error(`could not launch aws: ${result.error.message}`)
  }
  return { ok: result.status === 0, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() }
}

// Same call, but a non-zero exit is fatal — for output we cannot proceed without.
function aws(args) {
  const { ok, stdout, stderr } = runAws(args)
  if (!ok) throw new Error(`aws ${args[0]} ${args[1]} failed: ${stderr || '(no stderr)'}`)
  return stdout
}

// ── target + version resolution ──────────────────────────────────────────────

// Explicit ids (SST passes exactly one per command) or every running runner in the
// region. The caller walks whichever list it gets one entry at a time.
export function resolveTargets(environment = process.env, { describe = aws } = {}) {
  const explicit = (environment.INSTANCE_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  if (explicit.length > 0) return explicit

  const discovered = describe([
    'ec2',
    'describe-instances',
    '--region',
    REGION,
    '--filters',
    `Name=tag:Name,Values=${NAME_TAG_PATTERN}`,
    'Name=instance-state-name,Values=running',
    '--query',
    'Reservations[].Instances[].InstanceId',
    '--output',
    'text',
  ])
    .split(/\s+/)
    .filter((id) => id && id !== 'None')
    // describe-instances does not promise an order; sort so a fleet-wide roll visits the
    // same hosts in the same sequence every run.
    .sort()

  if (discovered.length === 0) {
    throw new Error(`no running instances tagged Name=${NAME_TAG_PATTERN} in ${REGION}`)
  }
  return discovered
}

// The workspace version is the release version for every published asset — the same
// field sst.config.ts bakes into the runner user-data.
export function resolveVersion(argv = process.argv, environment = process.env) {
  const explicit = argv[2] || environment.RUNNER_VERSION
  return explicit ? explicit.trim().replace(/^v/, '') : readWorkspaceVersion()
}

// ── remote upgrade script ────────────────────────────────────────────────────

export function buildRemoteScript(version, { runnerPort = RUNNER_PORT, allowDowngrade = false } = {}) {
  // Shared with the deploy-time preflight, so a target with no usable release is
  // rejected here too rather than 404-ing on the host.
  const { tarballUrl, checksumUrl, tarballName } = resolveRunnerReleaseAssets(version)
  // The port reaches the remote script body verbatim, so reject a malformed one here
  // rather than letting it fail obscurely inside a curl on the host.
  if (!/^[0-9]+$/.test(String(runnerPort))) {
    throw new Error(`RUNNER_PORT must be numeric (got '${runnerPort}')`)
  }
  // The manifest's filename column is matched as an awk ERE, so the dots in the tarball
  // name must be escaped — otherwise they are wildcards and a differently-named asset
  // could satisfy the check.
  const tarballPattern = tarballName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return `set -euo pipefail

TARGET="${version}"
HEALTH="http://127.0.0.1:${runnerPort}/"
ALLOW_DOWNGRADE="${allowDowngrade ? '1' : ''}"

# The binary parses no CLI args, so there is no --version to ask. Of the places that do
# report it, this health route is the only one reachable here without a token (/info is
# auth-gated and the healthcheck service only pushes to the control plane). Empty output
# means the runner is not serving.
probe_version() {
  curl -fsS --max-time 3 "$HEALTH" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'
}

# A just-created EC2 reports "running" — all Pulumi waits for — long before cloud-init has
# installed the binary and written the unit. Nothing to do on such a host: its user-data
# installs this very version. Bail out BEFORE the probe, because "not serving" here means
# "not built yet", and stopping/installing/starting against a missing unit would fail and
# roll back a runner that was coming up fine.
# is-enabled is the last of the three to become true (user-data writes the unit, then
# daemon-reloads, enables, and only then starts), so it also covers the window where the
# unit exists but cloud-init has not started it yet — swapping the binary there could race
# the install cloud-init is doing. A runner that was enabled and later died still reports
# enabled, so the repair path below stays reachable.
if [ ! -x /usr/local/bin/boxlite-runner ] ||
  [ ! -f /etc/systemd/system/boxlite-runner.service ] ||
  ! systemctl is-enabled --quiet boxlite-runner 2>/dev/null; then
  echo "still bootstrapping (binary/unit not in place or not enabled); user-data installs v$TARGET itself — nothing to do"
  exit 0
fi

# Converge, don't reinstall: a runner already on the target version is left completely
# alone, which is what makes running this on every deploy free of gratuitous restarts.
# Past the guard above, an unreachable probe means installed-but-unhealthy — do NOT skip
# that, a binary swap is exactly what might repair it.
CURRENT=$(probe_version || true)
echo "current version: \${CURRENT:-<not serving>}"
if [ "$CURRENT" = "$TARGET" ]; then
  echo "already at $TARGET; leaving the unit untouched"
  exit 0
fi

# Is the live version newer than the target? \`sort -V\` orders release cores correctly
# (0.9.10 above 0.9.9, 1.0.0 above 0.9.99) but gets prereleases backwards — it calls
# 0.9.8-alpha newer than 0.9.8 — so cores are compared with sort -V and semver's
# "a prerelease precedes its release" is applied by hand. TARGET is always a stable
# X.Y.Z (the shared resolver rejects anything else), so only the live side can carry a
# prerelease suffix. A blank CURRENT (not serving) is never newer, so an unhealthy
# runner still gets repaired below.
live_is_newer() {
  cur_core=\${CURRENT%%-*}
  tgt_core=\${TARGET%%-*}
  if [ "$cur_core" != "$tgt_core" ]; then
    [ "$(printf '%s\\n%s\\n' "$cur_core" "$tgt_core" | sort -V | tail -1)" = "$cur_core" ]
    return $?
  fi
  # Same core, so live is either the identical release (handled above) or a prerelease
  # of it — which semver puts first, meaning it is due this upgrade.
  return 1
}

# Never move a runner backwards by accident. One serving something newer than the declared
# version is usually a deliberate hand-install, and silently reverting it during an
# unrelated deploy is a nasty surprise; a real rollback sets ALLOW_DOWNGRADE=1.
if [ "\${ALLOW_DOWNGRADE:-}" != "1" ] && live_is_newer; then
  echo "WARNING: live $CURRENT is newer than target $TARGET; refusing to downgrade (set ALLOW_DOWNGRADE=1 to force)"
  exit 0
fi

# Download and verify BEFORE stopping the unit, so a failed or corrupt fetch never takes
# the runner down. Fail closed: the checksum sidecar is required, and must name exactly
# the tarball we fetched — same contract the deploy-time preflight enforces.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
curl -fsSL "${tarballUrl}" -o "$WORK/runner.tar.gz"
curl -fsSL "${checksumUrl}" -o "$WORK/runner.sha256"
EXPECTED=$(awk '$2 ~ /^\\*?${tarballPattern}$/ {print $1}' "$WORK/runner.sha256")
[ -n "$EXPECTED" ] || { echo "FATAL: checksum manifest does not name ${tarballName}" >&2; exit 1; }
ACTUAL=$(sha256sum "$WORK/runner.tar.gz" | awk '{print $1}')
[ "$EXPECTED" = "$ACTUAL" ] || { echo "FATAL: checksum mismatch (want $EXPECTED got $ACTUAL)" >&2; exit 1; }
echo "checksum verified ($ACTUAL)"
tar -xzf "$WORK/runner.tar.gz" -C "$WORK"
test -x "$WORK/boxlite-runner" || { echo "FATAL: tarball has no boxlite-runner binary" >&2; exit 1; }

# Back up the live binary so a failed swap or start can roll back.
HAD_PREVIOUS=false
if [ -x /usr/local/bin/boxlite-runner ]; then
  cp -a /usr/local/bin/boxlite-runner /usr/local/bin/boxlite-runner.bak
  HAD_PREVIOUS=true
fi
systemctl stop boxlite-runner || true

# The rolling-step boundary: the caller must not move to the next host until this one is
# actually serving the new version, so process-alive is not a sufficient signal.
wait_for_target() {
  for _ in $(seq 1 30); do
    [ "$(probe_version || true)" = "$TARGET" ] && return 0
    sleep 2
  done
  return 1
}

# Swap + start + readiness as one guarded condition: any failing step routes to the
# rollback branch instead of aborting under set -e (if-conditions are exempt).
# daemon-reload closes the narrow window where user-data has written the unit file but not
# yet loaded it: without this, the start below would fail on a unit systemd cannot see.
if install -m 0755 "$WORK/boxlite-runner" /usr/local/bin/boxlite-runner \\
  && systemctl daemon-reload \\
  && systemctl start boxlite-runner \\
  && systemctl is-active --quiet boxlite-runner \\
  && wait_for_target; then
  if [ "$HAD_PREVIOUS" = true ]; then rm -f /usr/local/bin/boxlite-runner.bak; fi
  echo "systemd unit: active"
  echo "new version: $(probe_version)"
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

// ── one host ─────────────────────────────────────────────────────────────────

const indent = (text) =>
  text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')

// Blocking on purpose: the whole script is sequential (one host at a time), so there is
// nothing to interleave and this keeps the call chain synchronous.
const sleepSeconds = (seconds) => spawnSync('sleep', [String(seconds)])

// Two transient conditions are worth retrying, and nothing else. SendCommand is rejected
// with InvalidInstanceId until the instance's SSM agent has registered, and an instance
// reports `running` — all the Pulumi resource waits for — well before that; this runs on
// the deployer, before any payload exists, so the still-bootstrapping guard inside the
// payload cannot cover it. Throttling is the other: losing a whole roll to a rate limit
// would strand the fleet half-upgraded. A bad id, a denied permission, anything else,
// fails immediately.
const RETRYABLE_SEND_ERRORS = /InvalidInstanceId|ThrottlingException|TooManyUpdates|RequestLimitExceeded/
export function sendCommand(instanceId, version, payload, { run = runAws, sleep = sleepSeconds } = {}) {
  const args = [
    'ssm',
    'send-command',
    '--region',
    REGION,
    '--document-name',
    'AWS-RunShellScript',
    '--instance-ids',
    instanceId,
    '--comment',
    `boxlite-runner upgrade to v${version}`,
    '--parameters',
    `commands=["echo ${payload} | base64 -d | bash"]`,
    '--query',
    'Command.CommandId',
    '--output',
    'text',
  ]
  for (let attempt = 1; ; attempt++) {
    const { ok, stdout, stderr } = run(args)
    if (ok) return stdout
    if (!RETRYABLE_SEND_ERRORS.test(stderr) || attempt >= SSM_REGISTRATION_ATTEMPTS) {
      throw new Error(`aws ssm send-command failed for ${instanceId}: ${stderr || '(no stderr)'}`)
    }
    console.log(
      `    ${instanceId} SSM send-command not accepted yet (${attempt}/${SSM_REGISTRATION_ATTEMPTS}); retrying`,
    )
    sleep(10)
  }
}

// `aws ssm wait command-executed` gives up after 100s (delay 5 × 20 attempts) and treats
// InProgress as retryable, so on a host whose upgrade legitimately runs longer — the
// readiness gate alone allows 60s on top of the download — it returns with the command
// still running. Reading that as a verdict would abort the roll on a host that is
// upgrading fine, so poll to a terminal status instead of using the waiter at all.
export const TERMINAL_SSM_STATUSES = new Set(['Success', 'Failed', 'Cancelled', 'TimedOut'])

export function waitForTerminalStatus(invocation, instanceId, { run = runAws, sleep = sleepSeconds } = {}) {
  // A poll can legitimately fail for a moment — InvocationDoesNotExist is normal right
  // after send-command — so a single failure is not fatal. But the cause must survive:
  // a persistent AccessDeniedException otherwise looks identical to a slow upgrade and
  // would be reported as a timeout naming nothing, which is the very fault this script
  // was written to stop making.
  let lastFailure = ''
  let lastStatus = ''
  for (let attempt = 1; attempt <= SSM_COMPLETION_ATTEMPTS; attempt++) {
    const { ok, stdout, stderr } = run([...invocation, '--query', 'Status', '--output', 'text'])
    if (ok) {
      if (TERMINAL_SSM_STATUSES.has(stdout)) return stdout
      lastStatus = stdout
      // Cleared on recovery: InvocationDoesNotExist right after send-command is expected,
      // and a stale one would otherwise outrank ten minutes of later InProgress polls and
      // blame a failure that had already resolved.
      lastFailure = ''
    } else {
      lastFailure = stderr || '(no stderr)'
    }
    sleep(5)
  }
  const why = lastFailure ? `last polling error: ${lastFailure}` : `last status: ${lastStatus || 'unknown'}`
  throw new Error(
    `${instanceId}: SSM command still not terminal after ${(SSM_COMPLETION_ATTEMPTS * 5) / 60} minutes (${why})`,
  )
}

function upgradeOne(instanceId, version) {
  // Hand the payload to SSM base64-encoded rather than quote-escaped: it becomes a
  // single token with no shell metacharacters, sidestepping the brittle escaping of a
  // multi-line script inside the commands=[...] shorthand.
  const script = buildRemoteScript(version, { allowDowngrade: process.env.ALLOW_DOWNGRADE === '1' })
  const commandId = sendCommand(instanceId, version, Buffer.from(script).toString('base64'))
  console.log(`    command:  ${commandId}`)

  const invocation = [
    'ssm',
    'get-command-invocation',
    '--region',
    REGION,
    '--command-id',
    commandId,
    '--instance-id',
    instanceId,
  ]
  const status = waitForTerminalStatus(invocation, instanceId)
  const stdout = aws([...invocation, '--query', 'StandardOutputContent', '--output', 'text'])
  const stderr = aws([...invocation, '--query', 'StandardErrorContent', '--output', 'text'])

  if (stdout) console.log(indent(stdout))
  if (stderr) console.error(indent(stderr))
  if (status !== 'Success') throw new Error(`${instanceId}: SSM command ${commandId} finished ${status}`)
}

// ── roll ─────────────────────────────────────────────────────────────────────

function main() {
  const version = resolveVersion()
  const targets = resolveTargets()

  console.log(`==> Rolling boxlite-runner to v${version} across ${targets.length} instance(s) in ${REGION}`)
  targets.forEach((instanceId, i) => {
    console.log(`==> [${i + 1}/${targets.length}] ${instanceId}`)
    upgradeOne(instanceId, version)
  })
  // Deliberately does not assert the fleet is at the target: a host can be skipped as
  // already-current, left alone as still-bootstrapping, or refused as a downgrade. The
  // per-host lines above say which; a blanket "all at vX" would be false for those.
  console.log(`==> done (${targets.length} instance(s))`)
}

// Importable for tests; only the direct invocation performs the roll. Both normalizations
// are load-bearing, and both failure modes are silent — the roll is skipped while the
// Pulumi command still reports success. `import.meta.url` is percent-encoded and
// symlink-resolved; a raw `file://${argv[1]}` matches neither a path containing a space
// nor a checkout reached through a symlink.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main()
  } catch (err) {
    console.error(`runner-update-binary: ${err.message}`)
    process.exit(1)
  }
}
