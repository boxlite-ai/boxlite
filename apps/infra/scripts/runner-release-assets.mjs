// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const RELEASE_DOWNLOAD_ROOT = 'https://github.com/boxlite-ai/boxlite/releases/download'
const STABLE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/
const execFileAsync = promisify(execFile)

export function resolveRunnerReleaseAssets(version) {
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`Runner release version '${version}' is not a stable semantic version (expected X.Y.Z)`)
  }

  const tarballName = `boxlite-runner-v${version}-linux-amd64.tar.gz`
  const checksumName = `${tarballName}.sha256`
  const releaseUrl = `${RELEASE_DOWNLOAD_ROOT}/v${version}`
  return {
    tarballName,
    checksumName,
    tarballUrl: `${releaseUrl}/${tarballName}`,
    checksumUrl: `${releaseUrl}/${checksumName}`,
  }
}

async function curlReleaseAsset(curlPath, url, extraArguments, environment, timeoutMs, description) {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000))
  const connectTimeoutSeconds = Math.min(10, timeoutSeconds)
  try {
    const { stdout } = await execFileAsync(
      curlPath,
      [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--connect-timeout',
        String(connectTimeoutSeconds),
        '--max-time',
        String(timeoutSeconds),
        ...extraArguments,
        url,
      ],
      {
        encoding: 'utf8',
        env: environment,
        killSignal: 'SIGTERM',
        maxBuffer: 1024 * 1024,
        timeout: timeoutMs,
      },
    )
    return stdout
  } catch (error) {
    const detail = error.stderr?.trim() || error.message
    throw new Error(`Runner release ${description} request failed for ${url}: ${detail}`, { cause: error })
  }
}

function remainingTimeoutMs(deadline) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('Runner release preflight exceeded its timeout')
  return remaining
}

export async function verifyRunnerReleaseAssets(
  version,
  { curlPath = 'curl', environment = process.env, timeoutMs = 15_000 } = {},
) {
  if (typeof curlPath !== 'string' || curlPath.trim() === '') {
    throw new Error('Runner release preflight requires a curl executable')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Runner release preflight timeout must be a positive integer')
  }

  const assets = resolveRunnerReleaseAssets(version)
  const deadline = Date.now() + timeoutMs

  // curl honors HTTPS_PROXY/NO_PROXY by default. Node's bare fetch does not,
  // which made valid releases unreachable from proxied deployment hosts.
  const checksumContents = (
    await curlReleaseAsset(curlPath, assets.checksumUrl, [], environment, remainingTimeoutMs(deadline), 'checksum')
  ).trim()
  const checksum = checksumContents.match(/^([0-9a-f]{64})[ \t]+\*?([^\r\n]+)$/i)
  if (!checksum || checksum[2] !== assets.tarballName) {
    throw new Error(`Runner release checksum manifest must name exactly '${assets.tarballName}'`)
  }

  await curlReleaseAsset(
    curlPath,
    assets.tarballUrl,
    ['--head', '--output', '/dev/null'],
    environment,
    remainingTimeoutMs(deadline),
    'tarball',
  )
  return assets
}
