// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { apiImageReference, apiImageRepository, apiImageTag, verifyApiImage } from './api-artifact.mjs'

const STAGE = { app: 'boxlite', stage: 'dev', region: 'ap-southeast-1', version: '1.2.3' }
const REF = 'a'.repeat(40)
const DIGEST = `sha256:${'a'.repeat(64)}`

const fakeCli = (result) => {
  const calls = []
  const run = (command, args, options) => {
    calls.push({ command, args, options })
    if (result instanceof Error) throw result
    return result
  }
  return { calls, run }
}

test('the image reference is the bootstrapped repository, not one the deploy invents', () => {
  assert.equal(apiImageRepository({ app: 'boxlite', stage: 'dev' }), 'boxlite-dev-api')
  assert.equal(
    apiImageReference({ ...STAGE, accountId: '123456789012' }),
    '123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/boxlite-dev-api:1.2.3',
  )
  assert.throws(
    () => apiImageRepository({ app: 'boxlite', stage: 'Feature One' }),
    /does not produce a valid ECR repository name/,
  )
})

test('a release names a version and a build names a commit, in the same repository', () => {
  // This literal is the contract with build-apps-api-image.yml's commit mode, which composes the
  // same string in shell. A drift here deploys a tag CI never pushed.
  assert.equal(apiImageTag({ version: '1.2.3', ref: REF }), `v1.2.3-${REF}`)
  assert.equal(apiImageTag({ version: '1.2.3' }), '1.2.3')
  // Tags are immutable in the bootstrapped repository, so the two shapes must not be able to
  // collide: a promoted release would otherwise be unrepairably shadowed by a commit build.
  assert.notEqual(apiImageTag({ version: '1.2.3', ref: REF }), apiImageTag({ version: '1.2.3' }))
  assert.equal(
    apiImageReference({ ...STAGE, accountId: '123456789012', ref: REF }),
    `123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/boxlite-dev-api:v1.2.3-${REF}`,
  )
  assert.throws(() => apiImageTag({ version: '1.2.3 4', ref: REF }), /does not produce a valid image tag/)
})

test('a published tag is confirmed by digest before SST is allowed to run', () => {
  const { calls, run } = fakeCli(`${DIGEST}\n`)
  assert.deepEqual(verifyApiImage(STAGE, { awsCliPath: '/fake/aws', run }), {
    repository: 'boxlite-dev-api',
    tag: '1.2.3',
    digest: DIGEST,
  })

  assert.equal(calls.length, 1)
  const { args } = calls[0]
  assert.deepEqual(args.slice(0, 2), ['ecr', 'describe-images'])
  assert.equal(args[args.indexOf('--repository-name') + 1], 'boxlite-dev-api')
  assert.equal(args[args.indexOf('--image-ids') + 1], 'imageTag=1.2.3')
  assert.equal(args[args.indexOf('--region') + 1], 'ap-southeast-1')
})

test('a commit image is looked up by its own tag, not the bare version', () => {
  // The preflight covers both sources now. Querying the version tag for a build deploy would
  // confirm an image that exists and deploy a different one that may not.
  const { calls, run } = fakeCli(`${DIGEST}\n`)
  assert.deepEqual(verifyApiImage({ ...STAGE, ref: REF }, { awsCliPath: '/fake/aws', run }), {
    repository: 'boxlite-dev-api',
    tag: `v1.2.3-${REF}`,
    digest: DIGEST,
  })
  assert.equal(calls[0].args[calls[0].args.indexOf('--image-ids') + 1], `imageTag=v1.2.3-${REF}`)
})

test('an absent tag is refused even though the CLI exits zero', () => {
  // `--query` on a missing image prints the literal `None` and succeeds, so treating exit status
  // as the answer would let a release deploy proceed to a tag that cannot be pulled.
  for (const empty of ['None\n', '', '   ']) {
    assert.throws(
      () => verifyApiImage(STAGE, { awsCliPath: '/fake/aws', run: fakeCli(empty).run }),
      /boxlite-dev-api:1\.2\.3 is unavailable: no image digest was returned/,
    )
  }
})

test('a failed lookup names the repository and tag it could not resolve', () => {
  const denied = Object.assign(new Error('exited 254'), { stderr: 'AccessDeniedException' })
  assert.throws(
    () => verifyApiImage(STAGE, { awsCliPath: '/fake/aws', run: fakeCli(denied).run }),
    /Api image boxlite-dev-api:1\.2\.3 is unavailable: AccessDeniedException/,
  )
  assert.throws(
    () => verifyApiImage({ ...STAGE, ref: REF }, { awsCliPath: '/fake/aws', run: fakeCli(denied).run }),
    new RegExp(`Api image boxlite-dev-api:v1\\.2\\.3-${REF} is unavailable: AccessDeniedException`),
  )
})
