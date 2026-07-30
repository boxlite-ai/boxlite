// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const RELEASE_DOWNLOAD_ROOT = 'https://github.com/boxlite-ai/boxlite/releases/download'
const RELEASE_REQUEST_KILL_GRACE_MS = 1_000
const RELEASE_REQUEST_MAX_BUFFER = 1024 * 1024
const STABLE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/
const execFileAsync = promisify(execFile)

function signalProcessGroup(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {}
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
}

function releaseRequestTerminationError(reason, signal, executionError) {
  const error =
    reason === 'aborted'
      ? Object.assign(new Error('The operation was aborted', { cause: signal.reason }), {
          code: 'ABORT_ERR',
          name: 'AbortError',
        })
      : Object.assign(new Error('The operation timed out'), { code: 'ETIMEDOUT', killed: true })
  error.stdout = executionError?.stdout ?? ''
  error.stderr = executionError?.stderr ?? ''
  return error
}

async function executeReleaseRequest(command, args, { encoding, environment, maxBuffer, signal, timeoutMs }) {
  if (signal?.aborted) throw releaseRequestTerminationError('aborted', signal)

  // AbortSignal makes execFile reject before its child emits close. Own the
  // cancellation so the deploy wrapper waits until the request child is reaped.
  const execution = execFileAsync(command, args, {
    detached: process.platform !== 'win32',
    encoding,
    env: environment,
    maxBuffer,
  })
  const child = execution.child
  let executionError
  let killTimer
  let terminationReason

  const terminate = (reason) => {
    if (terminationReason) return
    terminationReason = reason
    signalProcessGroup(child, 'SIGTERM')
    killTimer = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), RELEASE_REQUEST_KILL_GRACE_MS)
    killTimer.unref()
  }
  const abort = () => terminate('aborted')
  const timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs)
  timeoutTimer.unref()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()

  let result
  try {
    result = await execution
  } catch (error) {
    executionError = error
  } finally {
    clearTimeout(timeoutTimer)
    if (killTimer) clearTimeout(killTimer)
    signal?.removeEventListener('abort', abort)
  }

  if (terminationReason) throw releaseRequestTerminationError(terminationReason, signal, executionError)
  if (executionError) throw executionError
  return result
}

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

async function curlReleaseAsset(curlPath, url, extraArguments, environment, signal, timeoutMs, description) {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000))
  const connectTimeoutSeconds = Math.min(10, timeoutSeconds)
  try {
    const { stdout } = await executeReleaseRequest(
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
        environment,
        maxBuffer: RELEASE_REQUEST_MAX_BUFFER,
        signal,
        timeoutMs,
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
  { curlPath = 'curl', environment = process.env, signal, timeoutMs = 15_000 } = {},
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
    await curlReleaseAsset(
      curlPath,
      assets.checksumUrl,
      [],
      environment,
      signal,
      remainingTimeoutMs(deadline),
      'checksum',
    )
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
    signal,
    remainingTimeoutMs(deadline),
    'tarball',
  )
  return assets
}
