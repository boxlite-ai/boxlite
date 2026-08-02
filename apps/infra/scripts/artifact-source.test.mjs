// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  requireCleanCheckoutRef,
  readArtifactRef,
  requireCheckoutMatchesArtifactRef,
  resolveArtifactSource,
} from './artifact-source.mjs'

const REF = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const workspace = { readVersion: () => '1.2.3' }

const resolve = (component, environment) => resolveArtifactSource(component, environment, workspace)

test('an unconfigured deploy keeps each component doing exactly what it did before', () => {
  // The Api has only ever been built from the deployed checkout; the Runner has only ever been
  // installed from a published release. Neither may change without being asked to.
  assert.deepEqual(resolve('api', {}), { kind: 'build', ref: undefined, version: '1.2.3' })
  assert.deepEqual(resolve('runner', {}), { kind: 'release', version: '1.2.3' })
})

test('one variable moves both components to the same corner', () => {
  const release = { BOXLITE_ARTIFACT_SOURCE: 'release' }
  assert.deepEqual(resolve('api', release), { kind: 'release', version: '1.2.3' })
  assert.deepEqual(resolve('runner', release), { kind: 'release', version: '1.2.3' })

  const build = { BOXLITE_ARTIFACT_SOURCE: 'build', BOXLITE_ARTIFACT_REF: REF }
  assert.deepEqual(resolve('api', build), { kind: 'build', ref: REF, version: '1.2.3' })
  assert.deepEqual(resolve('runner', build), { kind: 'build', ref: REF, version: '1.2.3' })
})

test('a per-component source overrides the global one', () => {
  const environment = {
    BOXLITE_ARTIFACT_SOURCE: 'release',
    RUNNER_ARTIFACT_SOURCE: 'build',
    BOXLITE_ARTIFACT_REF: REF,
  }
  assert.deepEqual(resolve('api', environment), { kind: 'release', version: '1.2.3' })
  assert.deepEqual(resolve('runner', environment), { kind: 'build', ref: REF, version: '1.2.3' })
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
    version: '1.2.3',
  })
})

test('the build ref is normalized, and anything that is not a commit is refused', () => {
  assert.equal(readArtifactRef({ BOXLITE_ARTIFACT_REF: REF.toUpperCase() }), REF)
  assert.equal(readArtifactRef({}), undefined)
  assert.throws(() => readArtifactRef({ BOXLITE_ARTIFACT_REF: 'main' }), /must be a full git commit sha/)
  assert.throws(() => readArtifactRef({ BOXLITE_ARTIFACT_REF: 'a1b2c3d' }), /must be a full git commit sha/)
  assert.throws(() => readArtifactRef({ BOXLITE_ARTIFACT_REF: 'a1b2c3' }), /must be a full git commit sha/)
})

test('a build deploy refuses a ref that is not the checkout it would build the Api from', () => {
  // The staged Runner object verifies either way and the post-deploy check only compares X.Y.Z,
  // so nothing downstream can notice Api commit B shipping beside Runner commit A.
  const other = 'b'.repeat(40)
  assert.throws(
    () => requireCheckoutMatchesArtifactRef(REF, { readHead: () => other }),
    (error) =>
      error.message.includes(`BOXLITE_ARTIFACT_REF is ${REF}`) &&
      error.message.includes(`this checkout is ${other}`) &&
      error.message.includes('same commit'),
  )
  assert.doesNotThrow(() => requireCheckoutMatchesArtifactRef(REF, { readHead: () => REF }))
})

test('an unreadable checkout is refused rather than silently skipping the commit check', () => {
  assert.throws(
    () =>
      requireCheckoutMatchesArtifactRef(REF, {
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
