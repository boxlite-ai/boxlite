/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

function fixtureDaemonRunning(directory: string) {
  const pid = join(directory, 'daemon-pid')
  if (!existsSync(pid)) return false
  try {
    process.kill(Number(readFileSync(pid, 'utf8')), 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    return false
  }
}

function stopFixtureDaemon(directory: string) {
  const pid = join(directory, 'daemon-pid')
  if (!existsSync(pid)) return
  try {
    process.kill(Number(readFileSync(pid, 'utf8')), 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

export function executeWorkerBootstrap(entrypoint: string[], directory: string, scenario: string) {
  const runner = join(directory, 'runner'),
    bin = join(directory, 'bin'),
    trace = join(directory, 'bootstrap-trace')
  mkdirSync(runner)
  mkdirSync(bin)
  writeFileSync(trace, '')
  const scripts = {
    sudo: `shift
printf 'sudo:%s\\n' "$*" >> "$CI_BOOTSTRAP_TRACE"
while [[ "$1" == -* ]]; do
  case "$1" in -u|-g) shift 2 ;; *) shift ;; esac
done
exec "$@"`,
    timeout: 'shift; exec "$@"',
    iptables: 'exit 0',
    'apt-get': `printf 'apt-get:%s\\n' "$1" >> "$CI_BOOTSTRAP_TRACE"
[[ "$CI_BOOTSTRAP_CASE" != install-failure ]]`,
    docker: `if [[ "$CI_BOOTSTRAP_CASE" == existing ]]; then
  touch "$CI_BOOTSTRAP_DIR/ready"
elif [[ "$CI_BOOTSTRAP_CASE" == crash || "$CI_BOOTSTRAP_CASE" == timeout ]]; then
  exit 1
elif [[ -f "$CI_BOOTSTRAP_DIR/started" ]]; then
  if [[ -f "$CI_BOOTSTRAP_DIR/probed" ]]; then touch "$CI_BOOTSTRAP_DIR/ready"; fi
  touch "$CI_BOOTSTRAP_DIR/probed"
fi
if [[ -f "$CI_BOOTSTRAP_DIR/ready" ]]; then
  printf 'docker:ready\\n' >> "$CI_BOOTSTRAP_TRACE"
  exit 0
fi
exit 1`,
    dockerd: `printf '%s' "$$" > "$CI_BOOTSTRAP_DIR/daemon-pid"
printf 'dockerd\\n' >> "$CI_BOOTSTRAP_TRACE"
if [[ "$CI_BOOTSTRAP_CASE" == crash ]]; then printf 'fixture-daemon-failed\\n' >&2; exit 7; fi
touch "$CI_BOOTSTRAP_DIR/started"
exec /bin/sleep 30`,
  }
  for (const [name, script] of Object.entries(scripts))
    writeFileSync(join(bin, name), '#!/bin/bash\n' + script + '\n', { mode: 0o755 })
  writeFileSync(
    join(runner, 'run.sh'),
    `#!/bin/bash
if [[ -f "$CI_BOOTSTRAP_DIR/ready" ]]; then
  printf 'runner:ready\\n' >> "$CI_BOOTSTRAP_TRACE"
else
  printf 'runner:unready\\n' >> "$CI_BOOTSTRAP_TRACE"
fi
printf '%s' "$ACTIONS_RUNNER_INPUT_JITCONFIG" > "$CI_BOOTSTRAP_DIR/received-jit"
`,
    { mode: 0o755 },
  )
  writeFileSync(join(runner, '.boxlite-jitconfig'), 'dGVzdC1qaXQ=')
  if (scenario !== 'missing-jit') writeFileSync(join(runner, '.boxlite-jitconfig.ready'), 'ready')
  if (scenario === 'existing') writeFileSync(join(directory, 'ready'), '')
  // Accelerate the clock and polling delay; execute the emitted production bootstrap.
  const environment = join(directory, 'bash-environment')
  writeFileSync(
    environment,
    `sleep() {
  if [[ "$CI_BOOTSTRAP_CASE" == timeout ]]; then SECONDS=$((SECONDS + 120)); else SECONDS=$((SECONDS + 1)); fi
  /bin/sleep 0.01
}
command() {
  if [[ "$1" == -v && "$2" == iptables && "$CI_BOOTSTRAP_CASE" == install-* ]]; then return 1; fi
  builtin command "$@"
}
`,
  )
  const args = entrypoint
    .slice(1)
    .map((arg) =>
      arg.replaceAll('/home/runner', runner).replaceAll('/tmp/boxlite-ci-dockerd.log', join(directory, 'dockerd.log')),
    )
  try {
    const result = spawnSync(entrypoint[0], args, {
      encoding: 'utf8',
      timeout: 8000,
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        BASH_ENV: environment,
        CI_BOOTSTRAP_CASE: scenario,
        CI_BOOTSTRAP_DIR: directory,
        CI_BOOTSTRAP_TRACE: trace,
      },
    })
    if (result.error) throw result.error
    return {
      status: result.status,
      stderr: result.stderr,
      trace: readFileSync(trace, 'utf8').trim().split('\n'),
      jit: existsSync(join(directory, 'received-jit')) ? readFileSync(join(directory, 'received-jit'), 'utf8') : null,
      jitRemoved: !existsSync(join(runner, '.boxlite-jitconfig')),
      daemonRunning: fixtureDaemonRunning(directory),
    }
  } finally {
    stopFixtureDaemon(directory)
  }
}
