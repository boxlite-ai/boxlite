// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  requireCleanCheckoutRef,
  requireCheckoutMatchesArtifactRefs,
  resolveArtifactSource,
} from './artifact-source.mjs'

const REF = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const workspace = { readVersion: () => '1.2.3' }

const resolve = (component, environment) => resolveArtifactSource(component, environment, workspace)

test('an unconfigured deploy keeps each component doing exactly what it did before', () => {
  // The Api has only ever been built from the deployed checkout; the Runner has only ever been
  // installed from a published release. Neither may change without being asked to.
  assert.deepEqual(resolve('api', {}), { kind: 'build', ref: undefined, refKey: 'BOXLITE_ARTIFACT_REF', version: '1.2.3' })
  assert.deepEqual(resolve('runner', {}), { kind: 'release', version: '1.2.3' })
})

test('one variable moves both components to the same corner', () => {
  const release = { BOXLITE_ARTIFACT_SOURCE: 'release' }
  assert.deepEqual(resolve('api', release), { kind: 'release', version: '1.2.3' })
  assert.deepEqual(resolve('runner', release), { kind: 'release', version: '1.2.3' })

  const build = { BOXLITE_ARTIFACT_SOURCE: 'build', BOXLITE_ARTIFACT_REF: REF }
  assert.deepEqual(resolve('api', build), { kind: 'build', ref: REF, refKey: 'BOXLITE_ARTIFACT_REF', version: '1.2.3' })
  assert.deepEqual(resolve('runner', build), { kind: 'build', ref: REF, refKey: 'BOXLITE_ARTIFACT_REF', version: '1.2.3' })
})

test('a per-component source overrides the global one', () => {
  const environment = {
    BOXLITE_ARTIFACT_SOURCE: 'release',
    RUNNER_ARTIFACT_SOURCE: 'build',
    BOXLITE_ARTIFACT_REF: REF,
  }
  assert.deepEqual(resolve('api', environment), { kind: 'release', version: '1.2.3' })
  assert.deepEqual(resolve('runner', environment), { kind: 'build', ref: REF, refKey: 'BOXLITE_ARTIFACT_REF', version: '1.2.3' })
})

test('release mode honours the VERSION override the deployment config already reads', () => {
  assert.deepEqual(resolve('runner', { VERSION: '9.9.9' }), { kind: 'release', version: '9.9.9' })
  assert.throws(() => resolve('runner', { VERSION: '9.9.9-rc.1' }), /not a stable semantic version/)
})

test('an unusable source or component fails naming what to fix', () => {
  assert.throws(() => resolve('runner', { RUNNER_ARTIFACT_SOURCE: 'latest' }), /RUNNER_ARTIFACT_SOURCE must be one of/)
  assert.throws(
    () => resolve('runner', { BOXLITE_ARTIFACT_SOURCE: 'nightly' }),
    /BOXLITE_ARTIFACT_SOURCE must be one of/,
  )
  assert.throws(() => resolve('proxy', {}), /unknown deployable component 'proxy'/)
})

test('an empty source variable is treated as unset rather than as an error', () => {
  // CI writes these unconditionally, so a component the run did not select arrives as ''.
  assert.deepEqual(resolve('runner', { RUNNER_ARTIFACT_SOURCE: '  ', BOXLITE_ARTIFACT_SOURCE: 'build' }), {
    kind: 'build',
    ref: undefined,
    refKey: 'BOXLITE_ARTIFACT_REF',
    version: '1.2.3',
  })
})

test('the build ref is normalized, and anything that is not a commit is refused', () => {
  // Through the resolver, which is what production calls. The Api defaults to build mode, so a
  // bare ref reaches the check; a release-mode component never looks at one.
  assert.equal(resolve('api', { BOXLITE_ARTIFACT_REF: REF.toUpperCase() }).ref, REF)
  assert.equal(resolve('api', {}).ref, undefined)
  for (const notACommit of ['main', 'a1b2c3d', 'a1b2c3']) {
    assert.throws(() => resolve('api', { BOXLITE_ARTIFACT_REF: notACommit }), /must be a full git commit sha/)
  }
  // Named for the key that was actually wrong, or the operator edits the one that was fine.
  assert.throws(
    () => resolve('runner', { RUNNER_ARTIFACT_SOURCE: 'build', RUNNER_ARTIFACT_REF: 'main' }),
    /^Error: RUNNER_ARTIFACT_REF must be/,
  )
})

test('a component ref wins over the global one, the way its source key does', () => {
  const other = 'b'.repeat(40)
  const build = { RUNNER_ARTIFACT_SOURCE: 'build' }
  const runner = (environment) => resolve('runner', { ...build, ...environment })

  assert.equal(runner({ BOXLITE_ARTIFACT_REF: REF, RUNNER_ARTIFACT_REF: other }).ref, other)
  assert.equal(runner({ BOXLITE_ARTIFACT_REF: REF, RUNNER_ARTIFACT_REF: other }).refKey, 'RUNNER_ARTIFACT_REF')
  assert.equal(runner({ BOXLITE_ARTIFACT_REF: REF }).ref, REF)
  assert.equal(runner({ BOXLITE_ARTIFACT_REF: REF }).refKey, 'BOXLITE_ARTIFACT_REF')
  // Blank is unset, not an override: CI writes these keys unconditionally.
  assert.equal(resolve('api', { BOXLITE_ARTIFACT_REF: REF, API_ARTIFACT_REF: '  ' }).ref, REF)
  assert.equal(resolve('api', { BOXLITE_ARTIFACT_REF: REF, API_ARTIFACT_REF: '  ' }).refKey, 'BOXLITE_ARTIFACT_REF')
})

test('staging only a Runner locally leaves the Api building from the checkout', () => {
  // What `npm run runner:build-artifact` prints. Reading the global ref for the Api here would
  // resolve boxlite-<stage>-api:v<version>-<sha> — a tag only deploy-infra.yml ever pushes — and
  // refuse the deploy at preflight, with no published image the developer could point at.
  const local = { RUNNER_ARTIFACT_SOURCE: 'build', RUNNER_ARTIFACT_REF: REF }
  assert.deepEqual(resolve('runner', local), { kind: 'build', ref: REF, refKey: 'RUNNER_ARTIFACT_REF', version: '1.2.3' })
  assert.equal(resolve('api', local).ref, undefined)

  // CI publishes both for one commit and says so with the global key.
  const ci = { BOXLITE_ARTIFACT_SOURCE: 'build', BOXLITE_ARTIFACT_REF: REF }
  assert.equal(resolve('api', ci).ref, REF)
  assert.equal(resolve('runner', ci).ref, REF)
})

test('a build deploy refuses a ref that is not the checkout it builds the rest of the stack from', () => {
  // The staged Runner object verifies either way and the post-deploy check only compares X.Y.Z,
  // so nothing downstream can notice a Runner from commit A beside a Proxy built from commit B.
  const other = 'b'.repeat(40)
  const staged = [{ ref: REF, refKey: 'BOXLITE_ARTIFACT_REF' }]
  assert.throws(
    () => requireCheckoutMatchesArtifactRefs(staged, { readHead: () => other }),
    (error) =>
      error.message.includes(`BOXLITE_ARTIFACT_REF is ${REF}`) &&
      error.message.includes(`this checkout is ${other}`) &&
      error.message.includes('same commit'),
  )
  assert.doesNotThrow(() => requireCheckoutMatchesArtifactRefs(staged, { readHead: () => REF }))
})

test('every ref is checked, not only the first component that has one', () => {
  // The regression this exists to stop: `npm run runner:build-artifact` addresses the Runner and
  // nothing else, so gating on the Api's ref skipped the check entirely for exactly that deploy.
  const other = 'b'.repeat(40)
  const runnerOnly = [
    { ref: undefined, refKey: 'BOXLITE_ARTIFACT_REF' },
    { ref: REF, refKey: 'RUNNER_ARTIFACT_REF' },
  ]
  assert.throws(
    () => requireCheckoutMatchesArtifactRefs(runnerOnly, { readHead: () => other }),
    // Names the key that was actually set, not the global one the operator never touched.
    (error) => error.message.startsWith(`RUNNER_ARTIFACT_REF is ${REF}`),
  )
  assert.doesNotThrow(() => requireCheckoutMatchesArtifactRefs(runnerOnly, { readHead: () => REF }))

  // Two refs that are both present may still disagree — the component keys are independent, so
  // stopping at the first match would let the second one address a different commit unnoticed.
  const divergent = [
    { ref: REF, refKey: 'API_ARTIFACT_REF' },
    { ref: other, refKey: 'RUNNER_ARTIFACT_REF' },
  ]
  assert.throws(
    () => requireCheckoutMatchesArtifactRefs(divergent, { readHead: () => REF }),
    (error) => error.message.startsWith(`RUNNER_ARTIFACT_REF is ${other}`),
  )
})

test('no ref at all reads the checkout not at all, so a plain local deploy still works', () => {
  // A release deploy and an unconfigured `npm run deploy` address nothing by ref. Reading HEAD
  // anyway would make both refuse to run outside a clean git checkout, which neither needs.
  let reads = 0
  assert.doesNotThrow(() =>
    requireCheckoutMatchesArtifactRefs([{ ref: undefined }, { ref: undefined }], {
      readHead: () => {
        reads += 1
        return REF
      },
    }),
  )
  assert.equal(reads, 0)
})

test('an unreadable checkout is refused rather than silently skipping the commit check', () => {
  assert.throws(
    () =>
      requireCheckoutMatchesArtifactRefs([{ ref: REF, refKey: 'BOXLITE_ARTIFACT_REF' }], {
        readHead: () => {
          throw new Error('not a git repository')
        },
      }),
    /could not read the deployed commit.*not a git repository/,
  )
})

test('build mode leaves the ref optional, because only the Runner has to address one', () => {
  // SST builds the Api image from the deployed checkout, so `npm run deploy` from a laptop must
  // not start demanding a staged artifact it never needed.
  assert.deepEqual(resolve('api', { API_ARTIFACT_SOURCE: 'build' }), {
    kind: 'build',
    ref: undefined,
    refKey: 'BOXLITE_ARTIFACT_REF',
    version: '1.2.3',
  })
})

test('the deployed commit is read at the repository root, not the caller working directory', () => {
  const calls = []
  const run = (args, cwd) => {
    calls.push({ args, cwd })
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo'
    if (args[0] === 'status') return ''
    return 'a'.repeat(40)
  }

  assert.equal(requireCleanCheckoutRef({ run }), 'a'.repeat(40))
  // The lookup itself is anchored to this module — pinned at the call site, not in a default
  // argument, so an injected runner can see it — and everything after it runs at the root a
  // nested repository or submodule would otherwise have answered for.
  assert.deepEqual(
    calls.map((call) => call.cwd),
    [fileURLToPath(new URL('.', import.meta.url)), '/repo', '/repo'],
  )
})

test('a dirty checkout cannot satisfy the commit the Runner artifact was staged from', () => {
  const run = (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo'
    if (args[0] === 'status') return ' M apps/api/src/main.ts'
    return 'a'.repeat(40)
  }

  assert.throws(() => requireCleanCheckoutRef({ run }), /uncommitted changes/)
})

test('an untracked file counts as dirty, as it does for the builder', () => {
  // The Docker build context is the working tree, so an untracked-but-not-ignored file ships in
  // the Api image while HEAD still equals the ref. runner-artifact-build.mjs already refuses on
  // --untracked-files=all; the two halves of one rule must ask git the same question.
  const flags = []
  const run = (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo'
    if (args[0] === 'status') {
      flags.push(...args)
      return '?? apps/api/src/scratch.ts'
    }
    return 'a'.repeat(40)
  }

  assert.throws(() => requireCleanCheckoutRef({ run }), /uncommitted changes/)
  assert.ok(flags.includes('--untracked-files=all'))
})
