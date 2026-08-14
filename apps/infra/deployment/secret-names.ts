// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * What the stage's secret store holds, by name.
 *
 * `npm run secrets` used to be `sst secret list` straight through, with sst's stdio inherited — which
 * printed every value to the terminal. That was already more than the documented purpose ("lists what
 * is set"), and it became a great deal more once the store started holding the whole stage
 * configuration rather than a handful of app secrets: one command now dumps every domain, issuer, and
 * token into scrollback and whatever collects it.
 *
 * So the values are read and discarded here, and only names are printed. Anyone who needs a value can
 * still ask sst for that one secret deliberately.
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { SST_APP_NAME as APP, loadDeploymentEnvironment } from './environment.js'
import { isStageConfigBookkeepingKey, parseSecretList } from './stage-config.js'
import { resolveSstStage } from './stage.js'

const SST_WRAPPER_PATH = fileURLToPath(new URL('./sst.ts', import.meta.url))

loadDeploymentEnvironment()

const args = process.argv.slice(2)
let stage
try {
  stage = resolveSstStage(args)
} catch (error: any) {
  console.error(`secret-names: ${error.message}`)
  process.exit(1)
}

let stdout
try {
  /*
   * Through the wrapper, not the sst binary: reading the store initializes the Cloudflare provider,
   * and the wrapper is what loads those credentials from SSM. Calling sst directly worked only for an
   * operator who already had them exported, which is not the documented local setup.
   *
   * Its stdout is captured rather than inherited — inheriting every value is the problem this
   * command exists to fix — and the wrapper's own progress lines are written to stderr, so what
   * arrives here is sst's output alone. parseSecretList ignores anything that is not an assignment
   * regardless.
   */
  stdout = execFileSync(process.execPath, ['--import', 'tsx', SST_WRAPPER_PATH, 'secret', 'list', '--stage', stage], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 120_000,
    killSignal: 'SIGTERM',
  })
} catch (error: any) {
  // The status only: execFileSync's message repeats the command and its captured output.
  console.error(`secret-names: could not read the ${stage} secret store (sst exited ${error?.status ?? 'unknown'})`)
  process.exit(1)
}

const stored = parseSecretList(stdout, { app: APP, stage })
// The bookkeeping entries describe the configuration; reporting them as secrets would invite someone
// to "rotate" one.
const names = Object.keys(stored)
  .filter((name) => !isStageConfigBookkeepingKey(name))
  .sort()

if (names.length === 0) {
  console.log(`${APP}/${stage}: no secrets set`)
} else {
  console.log(`${APP}/${stage}: ${names.length} secrets`)
  for (const name of names) console.log(`  ${name}`)
}
