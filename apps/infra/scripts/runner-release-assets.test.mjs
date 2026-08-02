// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveRunnerReleaseAssets, verifyRunnerReleaseAssets } from './runner-release-assets.mjs'

const VERSION = '1.2.3'
const TARBALL = `boxlite-runner-v${VERSION}-linux-amd64.tar.gz`
const DIGEST = 'a'.repeat(64)

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function createFakeCurl(
  t,
  {
    checksum = `${DIGEST}  ${TARBALL}\n`,
    checksumExit = 0,
    expectedProxy = process.env.HTTPS_PROXY ?? '',
    delaySeconds = 0,
    tarballExit = 0,
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-runner-release-curl-'))
  const curlPath = join(directory, 'curl')
  const logPath = join(directory, 'curl.log')
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${HTTPS_PROXY:-}" == ${shellQuote(expectedProxy)} ]] || { echo 'HTTPS_PROXY was not forwarded' >&2; exit 90; }
sleep ${delaySeconds}
printf '%s\\n' "$*" >> ${shellQuote(logPath)}
case "$*" in
  *${TARBALL}.sha256*)
    [[ ${checksumExit} -eq 0 ]] || exit ${checksumExit}
    printf '%s' ${shellQuote(checksum)}
    ;;
  *${TARBALL}*) exit ${tarballExit} ;;
  *) exit 2 ;;
esac
`,
  )
  chmodSync(curlPath, 0o755)
  return { curlPath, logPath }
}

test('resolves the exact Linux Runner release artifacts for a stable version', () => {
  assert.deepEqual(resolveRunnerReleaseAssets(VERSION), {
    tarballName: TARBALL,
    checksumName: `${TARBALL}.sha256`,
    tarballUrl: `https://github.com/boxlite-ai/boxlite/releases/download/v${VERSION}/${TARBALL}`,
    checksumUrl: `https://github.com/boxlite-ai/boxlite/releases/download/v${VERSION}/${TARBALL}.sha256`,
  })
})

test('uses bounded curl requests so deployment honors the host proxy environment', async (t) => {
  const expectedProxy = 'http://deployment-proxy.test:8080'
  const fixture = createFakeCurl(t, { expectedProxy })
  const assets = await verifyRunnerReleaseAssets(VERSION, {
    curlPath: fixture.curlPath,
    environment: { ...process.env, HTTPS_PROXY: expectedProxy },
    timeoutMs: 5_000,
  })

  assert.equal(assets.tarballName, TARBALL)
  const requests = readFileSync(fixture.logPath, 'utf8').trim().split('\n')
  assert.equal(requests.length, 2)
  assert.match(requests[0], new RegExp(`--max-time 5 .*${TARBALL}\\.sha256$`))
  assert.doesNotMatch(requests[0], /--head/)
  assert.match(requests[1], new RegExp(`--max-time [1-5] .*--head .*${TARBALL}$`))
})

test('rejects a missing or mismatched Runner release before deployment', async (t) => {
  const missing = createFakeCurl(t, { checksumExit: 22 })
  await assert.rejects(
    verifyRunnerReleaseAssets(VERSION, { curlPath: missing.curlPath, timeoutMs: 5_000 }),
    /checksum request failed/i,
  )

  const mismatched = createFakeCurl(t, { checksum: `${DIGEST}  another-file.tar.gz\n` })
  await assert.rejects(
    verifyRunnerReleaseAssets(VERSION, { curlPath: mismatched.curlPath, timeoutMs: 5_000 }),
    /checksum manifest.*exactly/i,
  )

  // Both preflight arms feed host-side checks that compare against a lowercase `sha256sum`, so
  // an uppercase digest accepted here would fail at first boot instead of on the deployer.
  const upperCase = createFakeCurl(t, { checksum: `${DIGEST.toUpperCase()}  ${TARBALL}\n` })
  await assert.rejects(
    verifyRunnerReleaseAssets(VERSION, { curlPath: upperCase.curlPath, timeoutMs: 5_000 }),
    /must be one '<lowercase sha256>/,
  )

  const missingTarball = createFakeCurl(t, { tarballExit: 22 })
  await assert.rejects(
    verifyRunnerReleaseAssets(VERSION, { curlPath: missingTarball.curlPath, timeoutMs: 5_000 }),
    /tarball request failed/i,
  )
})

test('aborts a pending Runner release preflight', async (t) => {
  const fixture = createFakeCurl(t, { delaySeconds: 10 })
  const controller = new AbortController()
  const verification = verifyRunnerReleaseAssets(VERSION, {
    curlPath: fixture.curlPath,
    signal: controller.signal,
    timeoutMs: 15_000,
  })

  controller.abort(new Error('synthetic interruption'))
  await assert.rejects(verification, /checksum request failed/i)
})
