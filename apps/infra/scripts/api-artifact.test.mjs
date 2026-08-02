// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { apiImageReference, apiImageRepository, verifyApiReleaseImage } from './api-artifact.mjs'

const STAGE = { app: 'boxlite', stage: 'dev', region: 'ap-southeast-1', version: '1.2.3' }
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

test('a published tag is confirmed by digest before SST is allowed to run', () => {
  const { calls, run } = fakeCli(`${DIGEST}\n`)
  assert.deepEqual(verifyApiReleaseImage(STAGE, { awsCliPath: '/fake/aws', run }), {
    repository: 'boxlite-dev-api',
    digest: DIGEST,
  })

  assert.equal(calls.length, 1)
  const { args } = calls[0]
  assert.deepEqual(args.slice(0, 2), ['ecr', 'describe-images'])
  assert.equal(args[args.indexOf('--repository-name') + 1], 'boxlite-dev-api')
  assert.equal(args[args.indexOf('--image-ids') + 1], 'imageTag=1.2.3')
  assert.equal(args[args.indexOf('--region') + 1], 'ap-southeast-1')
})

test('an absent tag is refused even though the CLI exits zero', () => {
  // `--query` on a missing image prints the literal `None` and succeeds, so treating exit status
  // as the answer would let a release deploy proceed to a tag that cannot be pulled.
  for (const empty of ['None\n', '', '   ']) {
    assert.throws(
      () => verifyApiReleaseImage(STAGE, { awsCliPath: '/fake/aws', run: fakeCli(empty).run }),
      /boxlite-dev-api:1\.2\.3 is unavailable: no image digest was returned/,
    )
  }
})

test('a failed lookup names the repository and tag it could not resolve', () => {
  const denied = Object.assign(new Error('exited 254'), { stderr: 'AccessDeniedException' })
  assert.throws(
    () => verifyApiReleaseImage(STAGE, { awsCliPath: '/fake/aws', run: fakeCli(denied).run }),
    /Api release image boxlite-dev-api:1\.2\.3 is unavailable: AccessDeniedException/,
  )
})
