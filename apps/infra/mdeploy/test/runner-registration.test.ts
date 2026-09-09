/*
 * Which hosts get registered, and under which key.
 *
 * The API seeds one row; every host past the first needs one created through
 * the admin API, and a host with no row is answered 401 on every call it makes.
 * What is checked here is the part that decides correctness rather than the
 * HTTP: that the first host is left to the API, that a single-host fleet asks
 * for nothing, and that a name is never paired with another host's key.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  REGISTER_RUNNERS_COMMAND,
  extraRunnersOf,
  registrationDir,
  registrationPayload,
} from '../stack/runner-registration.ts'
import type { RunnerAssignment } from '../stack/runners.ts'

const assignment = (name: string, token: string): RunnerAssignment => ({
  slot: { resourceName: name === 'default' ? 'Runner' : `Runner-${name}`, nameTag: `boxlite-${name}`, controlPlaneRunnerName: name },
  token,
})

test('a single-host fleet asks for no registration at all', () => {
  // The API seeds that one row itself, so a command here would run a script
  // with nothing to do on every deploy.
  assert.deepEqual(extraRunnersOf([assignment('default', 't0')]), [])
})

test('the first host is left to the API and every later one is registered', () => {
  const fleet = [assignment('default', 't0'), assignment('runner-2', 't1'), assignment('runner-3', 't2')]
  assert.deepEqual(
    extraRunnersOf(fleet).map((extra) => extra.slot.controlPlaneRunnerName),
    ['runner-2', 'runner-3'],
    'the default row is the API’s to seed; a second POST for it would collide with its own seed',
  )
})

test('each host is registered under its own key, in fleet order', () => {
  const extras = [assignment('runner-2', 'token-2'), assignment('runner-3', 'token-3')]
  assert.deepEqual(JSON.parse(registrationPayload({ runners: extras, tokens: ['token-2', 'token-3'] })), [
    { name: 'runner-2', apiKey: 'token-2' },
    { name: 'runner-3', apiKey: 'token-3' },
  ])
})

test('a fleet and a token list of different lengths is refused rather than paired off', () => {
  // Pairing is token-based, so registering a host under its neighbour's key
  // produces a fleet where every member authenticates as the wrong runner —
  // and nothing downstream would report it.
  assert.throws(
    () => registrationPayload({ runners: [assignment('runner-2', 'a'), assignment('runner-3', 'b')], tokens: ['a'] }),
    /2 host\(s\) to register and 1 token\(s\)/,
  )
})

test('the launcher exists where the command will look for it', () => {
  // The one check that would have caught `$cli is not defined` before an apply:
  // the command resource is `dir` plus a relative path, and neither half means
  // anything on its own. `$cli` is an SST-only global — the Pulumi engine never
  // injects it — and the two engines root paths differently anyway, so this
  // resolves the pair here and confirms the file is really there.
  assert.match(REGISTER_RUNNERS_COMMAND, /^node (?<script>[a-z/-]+\.mjs)$/)
  const script = REGISTER_RUNNERS_COMMAND.replace(/^node /, '')
  const resolved = join(registrationDir(), script)
  assert.ok(existsSync(resolved), `the command would run ${script} from ${registrationDir()}, which is not there`)
})
