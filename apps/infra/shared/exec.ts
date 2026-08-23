// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * How this package runs external commands and stops the children it starts.
 *
 * The two termination primitives had each been written more than once and the copies had started
 * to disagree, which is why they are shared rather than merely tidied:
 *
 *   signalProcessGroup   a detached child's own children outlive a direct kill; of the three
 *                        former copies, two guarded the fallback against an already-exited child
 *                        and one did not.
 *   remainingTimeoutMs   a preflight that makes two calls must budget one deadline across both,
 *                        or it quietly grants twice the timeout its caller asked for.
 *
 * resolveAwsCliPath had only ever had one definition and sits here to keep it beside the AWS
 * wrappers that call it: it honors AWS_CLI_PATH so a test can stub the binary and reach every
 * caller at once, which a caller spelling 'aws' directly escapes — into the real account.
 *
 * The AWS wrappers are synchronous because every caller is a preflight or a post-deploy check
 * with nothing else to do while it waits. The one asynchronous caller (artifacts/runner.ts) owns
 * an abort signal and its own error vocabulary, so it keeps its own runner.
 */

import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

const AWS_CLI_TIMEOUT_MS = 15_000
const STANDARD_AWS_CLI_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
const AWS_LOGIN_SESSION_ARN = /^arn:(?:aws|aws-cn|aws-us-gov):iam::\d{12}:(?:user|role)\/.+$/

type AwsCredentialProcessOutput = {
  Version?: unknown
  AccessKeyId?: unknown
  SecretAccessKey?: unknown
  SessionToken?: unknown
}

export function resolveAwsCliPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredPath = environment.AWS_CLI_PATH?.trim()
  const candidates = configuredPath
    ? [configuredPath]
    : [
        ...(environment.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, 'aws')),
        ...STANDARD_AWS_CLI_DIRECTORIES.map((directory) => join(directory, 'aws')),
      ]

  for (const candidate of new Set(candidates)) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH and standard package-manager locations.
    }
  }

  const detail = configuredPath ? `AWS_CLI_PATH=${configuredPath}` : 'PATH and standard install locations'
  const error = new Error(`AWS CLI not found via ${detail}`) as NodeJS.ErrnoException
  error.code = 'ENOENT'
  throw error
}

/**
 * AWS CLI login sessions are supported by the CLI before they are supported by every SDK bundled
 * into our SST/Pulumi version. Bridge only that credential source into this process, in memory, so
 * the provider receives ordinary temporary environment credentials without a credentials file.
 */
export function materializeAwsLoginCredentials(environment: NodeJS.ProcessEnv = process.env): boolean {
  const hasAccessKey = Boolean(environment.AWS_ACCESS_KEY_ID?.trim())
  const hasSecretKey = Boolean(environment.AWS_SECRET_ACCESS_KEY?.trim())
  if (hasAccessKey !== hasSecretKey) {
    throw new Error('AWS environment credentials are incomplete')
  }
  if (hasAccessKey) {
    // stack/app.ts passes AWS_PROFILE explicitly to Pulumi. Keeping it would make the provider
    // ignore the complete environment credentials in favour of that profile.
    delete environment.AWS_PROFILE
    return false
  }

  const profile = environment.AWS_PROFILE?.trim() || 'default'
  const awsCliPath = resolveAwsCliPath(environment)
  let loginSession: string
  try {
    loginSession = execFileSync(awsCliPath, ['configure', 'get', 'login_session', '--profile', profile], {
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: AWS_CLI_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    }).trim()
  } catch (error: any) {
    // `aws configure get` uses exit 1 for an unset key. Such profiles remain available to the SDK's
    // normal shared-config credential chain and need no bridge.
    if (error.status === 1) return false
    throw new Error(`AWS profile ${profile} login session lookup failed`, { cause: error })
  }
  if (!AWS_LOGIN_SESSION_ARN.test(loginSession)) return false

  let rawCredentials: string
  try {
    rawCredentials = execFileSync(
      awsCliPath,
      ['configure', 'export-credentials', '--format', 'process', '--profile', profile],
      {
        encoding: 'utf8',
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: AWS_CLI_TIMEOUT_MS,
        killSignal: 'SIGTERM',
      },
    )
  } catch (error) {
    throw new Error(`AWS profile ${profile} credential export failed`, { cause: error })
  }

  let credentials: AwsCredentialProcessOutput
  try {
    credentials = JSON.parse(rawCredentials)
  } catch (error) {
    throw new Error(`AWS profile ${profile} credential export returned invalid JSON`, { cause: error })
  }
  if (
    credentials.Version !== 1 ||
    typeof credentials.AccessKeyId !== 'string' ||
    credentials.AccessKeyId.length === 0 ||
    typeof credentials.SecretAccessKey !== 'string' ||
    credentials.SecretAccessKey.length === 0 ||
    (credentials.SessionToken !== undefined && typeof credentials.SessionToken !== 'string')
  ) {
    throw new Error(`AWS profile ${profile} credential export returned an invalid credential shape`)
  }

  environment.AWS_ACCESS_KEY_ID = credentials.AccessKeyId
  environment.AWS_SECRET_ACCESS_KEY = credentials.SecretAccessKey
  if (credentials.SessionToken) environment.AWS_SESSION_TOKEN = credentials.SessionToken
  else delete environment.AWS_SESSION_TOKEN
  delete environment.AWS_PROFILE
  return true
}

export function signalProcessGroup(child: any, signal: any) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // The direct-child fallback below handles platforms without process groups.
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal)
  }
}

export function remainingTimeoutMs(deadline: number, label: string) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error(`${label} exceeded its timeout`)
  return remaining
}

function runAwsCli(args: any, { awsCliPath, region, output }: any) {
  const cli = awsCliPath ?? resolveAwsCliPath()
  // --no-cli-pager: a pager attached to a captured stdout never returns.
  return execFileSync(cli, [...args, '--region', region, '--output', output, '--no-cli-pager'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: AWS_CLI_TIMEOUT_MS,
    killSignal: 'SIGTERM',
  })
}

export function runAwsJson(args: any, { awsCliPath, region }: any) {
  let output
  try {
    output = runAwsCli(args, { awsCliPath, region, output: 'json' })
  } catch (error: any) {
    const detail = error.stderr?.toString().trim() || error.message
    throw new Error(`AWS ${args[0]} ${args[1]} failed: ${detail}`, { cause: error })
  }

  try {
    return JSON.parse(output)
  } catch (error) {
    throw new Error(`AWS ${args[0]} ${args[1]} returned invalid JSON`, { cause: error })
  }
}

// Unwrapped on purpose: the SSM caller distinguishes a missing CLI (ENOENT, from either the
// lookup above or the exec itself) from a failed lookup, and a wrapped error loses `.code`.
export function runAwsText(args: any, { awsCliPath, region }: any) {
  return runAwsCli(args, { awsCliPath, region, output: 'text' }).trim()
}
