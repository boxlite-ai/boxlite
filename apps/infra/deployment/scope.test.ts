// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEPLOY_SCOPE_KEY,
  exportDeployScope,
  readDeployScope,
  resolveDeployScope,
  requireSstSubcommandFirst,
  withRequiredRunnerPolicy,
} from './scope.js'

const INFRA_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RUNNER_POLICY_ROOT = resolve(INFRA_ROOT, 'policies/runner')

test('always injects the repository Runner policy root', () => {
  assert.deepEqual(withRequiredRunnerPolicy(['deploy', '--stage', 'dev'], '/untrusted/working-directory'), [
    'deploy',
    '--stage',
    'dev',
    '--policy',
    RUNNER_POLICY_ROOT,
  ])
})

test('rejects flag-first SST syntax so deployment guards cannot be bypassed', () => {
  assert.doesNotThrow(() => requireSstSubcommandFirst(['deploy', '--stage', 'dev']))
  assert.throws(
    () => requireSstSubcommandFirst(['--stage', 'dev', 'deploy', '--target', 'Api']),
    /subcommand must be the first argument/,
  )
  assert.throws(() => requireSstSubcommandFirst(['dev']), /sst dev is disabled/)
  assert.throws(() => requireSstSubcommandFirst(['dev', '--', 'next', 'dev']), /sst dev is disabled/)
  assert.throws(() => requireSstSubcommandFirst(['diff', '--stage', 'dev', '--']), /argument delimiter is disabled/)
  assert.throws(() => requireSstSubcommandFirst(['deploy', '--', '--policy', '.']), /argument delimiter is disabled/)
})

test('an unqualified deploy still covers both components', () => {
  assert.deepEqual(resolveDeployScope(['deploy', '--stage', 'dev']).components, ['api', 'runner'])
  assert.deepEqual(resolveDeployScope(['deploy', '--stage', 'dev']).excluded, [])
})

test('an excluded diff is narrowed exactly like the deploy behind it', () => {
  // The preview and the apply must build the SAME resource graph. Deriving the scope from the
  // subcommand instead of the selector made `diff --exclude Runner` declare UpgradeRunnerBinary-*
  // and plan an update, while `deploy --exclude Runner` undeclared it and planned a delete — the
  // plan the operator approved was not the plan that ran.
  for (const excluded of ['Runner', 'Api']) {
    const preview = resolveDeployScope(['diff', '--stage', 'dev', '--exclude', excluded])
    const apply = resolveDeployScope(['deploy', '--stage', 'dev', '--exclude', excluded])
    assert.deepEqual([...preview.components], [...apply.components], `--exclude ${excluded} graphs must agree`)
  }
})

test('--target never narrows the graph, on any subcommand', () => {
  // It filters which declared resources are acted on; it does not remove declarations, and
  // Pulumi reads a missing declaration as a delete.
  assert.deepEqual(resolveDeployScope(['diff', '--stage', 'dev', '--target', 'Api']).components, ['api', 'runner'])
  assert.deepEqual(resolveDeployScope(['diff', '--stage', 'dev', '--target', 'Runner']).components, ['api', 'runner'])
})

test('each reviewed exclusion drops exactly the leg it names', () => {
  // Both spellings, because accepting only one would let the other reach SST unexamined while
  // the preflight still believed the excluded component was in scope.
  for (const args of [
    ['deploy', '--stage', 'dev', '--exclude', 'Runner'],
    ['deploy', '--stage', 'dev', '--exclude=Runner'],
  ]) {
    const scope = resolveDeployScope(args)
    assert.deepEqual(scope.components, ['api'], `${args.join(' ')} must leave only the Api in scope`)
    assert.deepEqual(scope.excluded, ['runner'])
  }
  for (const args of [
    ['deploy', '--stage', 'dev', '--exclude', 'Api'],
    ['deploy', '--stage', 'dev', '--exclude=Api'],
  ]) {
    const scope = resolveDeployScope(args)
    assert.deepEqual(scope.components, ['runner'], `${args.join(' ')} must leave only the Runner in scope`)
    assert.deepEqual(scope.excluded, ['api'])
  }
})

test('--target stays banned for deploys — it is what stalled the stack in #1095', () => {
  // Not interchangeable with --exclude. A targeted update omits the shared and provider resources
  // it still depends on, which is how SST stopped on StorageBucket mid-provider-migration.
  for (const args of [
    ['deploy', '--stage', 'dev', '--target', 'Api'],
    ['deploy', '--stage', 'dev', '--target=Api'],
    ['deploy', '--stage', 'dev', '--target', 'Runner'],
  ]) {
    assert.throws(() => resolveDeployScope(args), /--target is disabled for deploys/)
  }
})

test('rejects any scope that is not one of the reviewed shapes', () => {
  // An allowlist, not a parser: an operator picks a reviewed scope rather than composing one.
  for (const args of [
    ['deploy', '--stage', 'dev', '--exclude', 'Proxy'],
    ['deploy', '--stage', 'dev', '--exclude', 'Storage'],
    ['deploy', '--stage', 'dev', '--exclude'],
    // A flag is a missing value, not the value — otherwise this excludes a component named
    // `--stage` and silently deploys everything while reporting a narrowed scope.
    ['deploy', '--exclude', '--stage', 'dev'],
  ]) {
    assert.throws(() => resolveDeployScope(args), /not a reviewed deploy scope/, args.join(' '))
  }
  assert.throws(
    () => resolveDeployScope(['deploy', '--stage', 'dev', '--exclude', 'Api', '--exclude', 'Runner']),
    /at most one scope selector/,
  )
})

test('the resolved scope reaches sst.config.ts unchanged', () => {
  // The config cannot read argv, so the wrapper exports what it resolved. A round-trip, not two
  // parsers: if these ever disagreed, the plan would exclude one leg while the resource graph
  // still declared it.
  for (const args of [
    ['deploy', '--stage', 'dev'],
    ['deploy', '--stage', 'dev', '--exclude', 'Runner'],
    ['deploy', '--stage', 'dev', '--exclude', 'Api'],
  ]) {
    const environment = {}
    const scope = resolveDeployScope(args)
    exportDeployScope(scope, environment)
    assert.deepEqual(readDeployScope(environment), [...scope.components], args.join(' '))
  }
})

test('an absent scope is the full stack, but a present empty one stays empty', () => {
  // Absent is what a bare `sst` invocation and a local `npm run deploy` get.
  assert.deepEqual(readDeployScope({}), ['api', 'runner'])
  assert.deepEqual(readDeployScope({ [DEPLOY_SCOPE_KEY]: undefined }), ['api', 'runner'])
  // Present-but-empty is a real scope, not a missing one. `diff --exclude Api --exclude Runner`
  // produces it, and keying on truthiness round-tripped it back to the full stack — previewing
  // a graph the operator excluded both legs from.
  const bothExcluded = resolveDeployScope(['diff', '--exclude', 'Api', '--exclude', 'Runner'])
  assert.deepEqual([...bothExcluded.components], [])
  const environment = {}
  exportDeployScope(bothExcluded, environment)
  assert.deepEqual(readDeployScope(environment), [])
  assert.deepEqual(readDeployScope({ [DEPLOY_SCOPE_KEY]: '  ' }), [])
  // Never a silent default: widening declares resources an excluded deploy must not touch, and
  // narrowing drops resources from a full deploy — which Pulumi reads as "delete".
  for (const value of ['proxy', 'api,proxy', 'api,api', 'Runner', 'api runner']) {
    assert.throws(
      () => readDeployScope({ [DEPLOY_SCOPE_KEY]: value }),
      new RegExp(`${DEPLOY_SCOPE_KEY} must be a unique comma-separated subset`),
      value,
    )
  }
})

test('requires the repository Runner policy for every preview and deploy', () => {
  assert.deepEqual(withRequiredRunnerPolicy(['diff', '--stage', 'dev'], RUNNER_POLICY_ROOT), [
    'diff',
    '--stage',
    'dev',
    '--policy',
    RUNNER_POLICY_ROOT,
  ])
  assert.deepEqual(withRequiredRunnerPolicy(['deploy', '--stage', 'dev', '--policy=.'], RUNNER_POLICY_ROOT), [
    'deploy',
    '--stage',
    'dev',
    `--policy=${RUNNER_POLICY_ROOT}`,
  ])
  assert.deepEqual(withRequiredRunnerPolicy(['state', 'export', '--stage', 'dev'], RUNNER_POLICY_ROOT), [
    'state',
    'export',
    '--stage',
    'dev',
  ])

  assert.throws(
    () => withRequiredRunnerPolicy(['deploy', '--stage', 'dev', '--policy', '../other-policy'], RUNNER_POLICY_ROOT),
    /Runner policy.*must be/,
  )
  assert.throws(
    () => withRequiredRunnerPolicy(['diff', '--policy', '.', '--policy=.'], RUNNER_POLICY_ROOT),
    /Runner policy.*exactly once/,
  )

  for (const args of [
    ['diff', '--policy'],
    ['diff', '--policy='],
    ['deploy', '--policy', '.', '--policy', '.'],
  ]) {
    assert.throws(() => withRequiredRunnerPolicy(args, RUNNER_POLICY_ROOT), /Runner policy/)
  }
})

test('resolves relative Runner policy paths from the supplied working directory', () => {
  const workingDirectory = resolve(INFRA_ROOT, 'scripts')

  assert.deepEqual(
    withRequiredRunnerPolicy(['deploy', '--stage', 'dev', '--policy', '../policies/runner'], workingDirectory),
    ['deploy', '--stage', 'dev', '--policy', RUNNER_POLICY_ROOT],
  )
})
