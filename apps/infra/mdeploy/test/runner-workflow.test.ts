/*
 * The workflow that stages a runner binary, held against what `runner:build`
 * actually demands of its environment.
 *
 * Three of those demands are invisible in the tool's own tests, because they
 * are about the machine it runs on: the tree has to be the commit being staged,
 * its submodules have to be there, and on GCP the upload goes through a CLI
 * nothing else in this repository installs.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const workflow = readFileSync(
  fileURLToPath(new URL('../../../../.github/workflows/mrunner.yml', import.meta.url)),
  'utf8',
)

/** What the job runs, with the commentary that discusses it removed. */
const commands = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

test('it stages the commit it was given, with the submodules that commit names', () => {
  // `inspectCheckout` refuses a tree whose submodules are missing or ahead: a
  // commit-keyed object that held anything else would claim bytes that commit
  // does not produce, and nothing downstream could tell.
  const moved = commands.indexOf('ref: ${{ steps.ref.outputs.sha }}')
  assert.notEqual(moved, -1, 'nothing checks out the commit being staged')
  assert.match(commands.slice(moved, moved + 200), /submodules: recursive/)
  assert.ok(moved < commands.indexOf('runner:build'), 'the build must come from that commit')
})

test('the GCP path installs the CLI the upload goes through', () => {
  // `gcpDestination` reaches Cloud Storage with `gcloud storage`, and
  // `google-github-actions/auth` writes a credential without installing one.
  // The failure without this is at the upload, after the build has been paid.
  const install = commands.indexOf('setup-gcloud')
  assert.notEqual(install, -1, 'a GCP stage cannot upload without it')
  assert.ok(install < commands.indexOf('runner:build'), 'and it has to be there before the build')
  assert.match(
    commands.slice(commands.lastIndexOf('- name:', install), install),
    /artifact-registry/,
    'only the cloud that needs it',
  )
})

test('staging is not retried, because neither of its failures is transient', () => {
  // The destination is proved reachable before anything is compiled, so what is
  // left is the build itself and a refusal about what the bucket already holds.
  const start = commands.indexOf('- name: Build the runner')
  assert.notEqual(start, -1, 'the step this is about is not in the workflow')
  const staging = commands.slice(start, commands.indexOf('- name: Report'))
  assert.ok(staging.includes('runner:promote'), 'both commands run in the region this reads')
  assert.doesNotMatch(staging, /for attempt in/)
})

test('an orchestrator can call it and learn which commit it staged', () => {
  // The deploy after it installs a build-mode binary by commit, so the caller
  // needs the resolved SHA rather than the ref it passed in.
  assert.match(workflow, /^  workflow_call:$/m, 'it must be callable')
  assert.match(workflow, /value: \$\{\{ jobs\.stage-runner\.outputs\.sha \}\}/)
  assert.match(workflow, /sha: \$\{\{ steps\.ref\.outputs\.sha \}\}/)
})

/*
 * The second command, which moves bytes instead of making them.
 *
 * A promotion needs neither the tree nor the submodules — it copies an object
 * between two buckets by the name the source holds it under — and the submodule
 * fetch is the expensive half of this job. What it does need is the source
 * stage's declaration, which lives in an environment this job does not bind to.
 */
test('a promotion takes neither the tree nor the submodules, and reads the source stage', () => {
  const checkout = commands.slice(commands.indexOf('- if: inputs.command ==')).split('\n      - ')[0]
  assert.match(checkout, /inputs\.command == 'build'/, 'only a build needs the commit checked out')
  assert.match(checkout, /submodules: recursive/, 'and that is where the submodules are paid for')

  assert.match(commands, /stages: \$\{\{ inputs\.command == 'promote' && format\('\{0\} \{1\}', inputs\.from, inputs\.stage\)/)
  assert.match(commands, /stage-config-from: \$\{\{ needs\.declaration\.outputs\.config \}\}/)

  // One command per dispatch, and each in its own step.
  assert.match(commands, /if: inputs\.command == 'build'\n\s+working-directory: apps\/infra\n\s+run: npm run runner:build/)
  assert.match(commands, /if: inputs\.command == 'promote'/)
  assert.match(commands, /npm run runner:promote -- --tag/)
})
