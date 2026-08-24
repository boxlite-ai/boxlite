// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { spawn } from 'node:child_process'

import { signalProcessGroup } from '../shared/exec.js'
// eslint-disable-next-line @nx/enforce-module-boundaries -- Pulumi loads the shared Runner model through a CommonJS package boundary.
import runnerStateBaseline from './model/state-baseline.js'

const { createRunnerStateBaseline } = runnerStateBaseline
const MAX_STATE_EXPORT_BYTES = 64 * 1024 * 1024
const STATE_EXPORT_TIMEOUT_MS = 5 * 60_000
const STATE_EXPORT_KILL_GRACE_MS = 5_000
const MAX_SERIALIZED_RUNNER_BASELINE_BYTES = 32 * 1024
const STATE_NOT_FOUND_LOG = /\berr="state not found"(?:\s|$)/

function abortedExecutionError(signal: any, stdout: any, stderr: any): any {
  const error: any = new Error('The operation was aborted', { cause: signal.reason })
  error.name = 'AbortError'
  error.stdout = stdout
  error.stderr = stderr
  return error
}

export function executeStateExportProcess(command: any, args: any, options: any) {
  const {
    encoding = 'utf8',
    killGraceMs = STATE_EXPORT_KILL_GRACE_MS,
    maxBuffer = MAX_STATE_EXPORT_BYTES,
    signal,
    timeout,
    ...childOptions
  } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedExecutionError(signal, '', ''))
      return
    }

    const stdoutChunks: any[] = []
    const stderrChunks: any[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminationReason: any
    let killTimer: any
    let timeoutTimer: any
    let spawnError: any
    const child = spawn(command, args, {
      ...childOptions,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    function terminateReadOnlyExport(reason: any) {
      if (terminationReason) return
      terminationReason = reason
      signalProcessGroup(child, 'SIGINT')
      killTimer = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), killGraceMs)
      killTimer.unref()
    }

    function abort() {
      terminateReadOnlyExport('aborted')
    }

    function collectOutput(chunks: any, chunk: any, streamBytes: any) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
      if (streamBytes + buffer.length > maxBuffer) {
        terminateReadOnlyExport('maxBuffer')
        return streamBytes
      }
      chunks.push(buffer)
      return streamBytes + buffer.length
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes = collectOutput(stdoutChunks, chunk, stdoutBytes)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes = collectOutput(stderrChunks, chunk, stderrBytes)
    })
    child.on('error', (error) => {
      spawnError = error
    })
    child.on('close', (code, childSignal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)

      const stdout = Buffer.concat(stdoutChunks).toString(encoding)
      const stderr = Buffer.concat(stderrChunks).toString(encoding)
      if (terminationReason === 'aborted') {
        reject(abortedExecutionError(signal, stdout, stderr))
      } else if (terminationReason === 'timeout') {
        const error: any = new Error('The operation timed out')
        error.killed = true
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else if (terminationReason === 'maxBuffer') {
        const error: any = new Error('State export output exceeded the configured buffer limit')
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        error.killed = true
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else if (spawnError) {
        spawnError.stdout = stdout
        spawnError.stderr = stderr
        reject(spawnError)
      } else if (code !== 0) {
        const error: any = new Error(`State export process exited with status ${code ?? `signal ${childSignal}`}`)
        error.code = code
        error.signal = childSignal
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    })

    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()

    if (timeout > 0) {
      timeoutTimer = setTimeout(() => {
        terminateReadOnlyExport('timeout')
      }, timeout)
      timeoutTimer.unref()
    }
  })
}

function forwardedConfigArguments(sstArgs: any) {
  const configArguments = []
  for (let index = 1; index < sstArgs.length; index += 1) {
    const argument = sstArgs[index]
    if (argument === '--config') {
      const value = sstArgs[index + 1]
      if (!value || value.startsWith('--')) throw new Error('SST --config requires a path')
      configArguments.push('--config', value)
      index += 1
    } else if (argument.startsWith('--config=')) {
      const value = argument.slice('--config='.length)
      if (!value) throw new Error('SST --config requires a path')
      configArguments.push('--config', value)
    }
  }
  if (configArguments.length > 2) throw new Error('SST --config must be specified exactly once')
  return configArguments
}

function stateExportFailureReason(error: any) {
  if (error?.code === 'ENOENT') return 'the sst executable was not found on PATH'
  if (error?.name === 'AbortError') return 'the state export was interrupted'
  if (error instanceof SyntaxError) return 'sst returned invalid checkpoint JSON'
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return `sst exceeded the ${MAX_STATE_EXPORT_BYTES / (1024 * 1024)} MiB output limit`
  }
  if (error?.killed) return `sst exceeded the ${STATE_EXPORT_TIMEOUT_MS / 1_000}-second timeout`
  if (Number.isInteger(error?.code)) return `sst exited with status ${error.code}`
  return 'sst did not complete successfully'
}

function isMissingStateExport(error: any) {
  const wasInterrupted =
    error?.name === 'AbortError' ||
    error?.killed === true ||
    error?.code === 'ETIMEDOUT' ||
    error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    typeof error?.signal === 'string'
  return (
    !wasInterrupted &&
    Number.isInteger(error?.code) &&
    error.code !== 0 &&
    typeof error?.stderr === 'string' &&
    STATE_NOT_FOUND_LOG.test(error.stderr)
  )
}

export async function readRunnerStateBaseline({
  stage,
  sstPath = 'sst',
  sstArgs,
  environment = process.env,
  signal,
  execute = executeStateExportProcess,
}: any) {
  let exportedState
  try {
    const result = await execute(
      sstPath,
      ['state', 'export', '--stage', stage, '--print-logs', ...forwardedConfigArguments(sstArgs)],
      {
        encoding: 'utf8',
        env: environment,
        signal,
        timeout: STATE_EXPORT_TIMEOUT_MS,
        // The native SST process gets a grace period to cancel and await its
        // detached Pulumi child. State export is read-only, so a stuck export
        // is force-stopped after that grace period.
        killGraceMs: STATE_EXPORT_KILL_GRACE_MS,
        maxBuffer: MAX_STATE_EXPORT_BYTES,
      },
    )
    exportedState = JSON.parse(typeof result === 'string' ? result : (result as any).stdout)
  } catch (error) {
    if (isMissingStateExport(error)) {
      exportedState = { latest: { resources: [] } }
    } else {
      throw new Error(`failed to export the current SST state: ${stateExportFailureReason(error)}`, { cause: error })
    }
  }

  let serializedBaseline
  try {
    serializedBaseline = JSON.stringify(createRunnerStateBaseline(exportedState))
  } catch (error) {
    throw new Error(`failed to create the Runner state baseline: ${(error as Error).message}`, { cause: error })
  }
  if (Buffer.byteLength(serializedBaseline, 'utf8') > MAX_SERIALIZED_RUNNER_BASELINE_BYTES) {
    throw new Error('Runner state baseline exceeds the 32 KiB environment handoff limit')
  }
  return serializedBaseline
}
