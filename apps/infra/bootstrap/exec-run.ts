/*
 * How the bootstrap runs a cloud CLI, and as which credential.
 *
 * Its own module rather than a helper inside `bootstrap.ts`, because which
 * identity a bootstrap acts as is worth a test and `bootstrap.ts` runs `main()`
 * at import: nothing can load it to ask.
 */

import { execFileSync } from 'node:child_process'

export type ExecResult = { code: number; stdout: string; stderr: string }
export type ExecOptions = { stdin?: string; environment?: NodeJS.ProcessEnv }
export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>

/**
 * The injected `Run` both gcp.ts's `bootstrapGcp` and aws.ts's `bootstrapAws`
 * take: a result to reconcile against, never a thrown error, because absence
 * of a resource is an answer `gcloud`/`aws` give with a non-zero exit, not a
 * fault in this process. Generic over `command` so one implementation serves
 * both clouds instead of two copies drifting apart.
 */
export const execRun: Exec = async (command, args, options = {}) => {
  try {
    const stdout = execFileSync(command, args, {
      input: options.stdin,
      // Inherited unless a caller narrows or adds to it. `runAs` below is what
      // narrows it, and why.
      env: options.environment ?? process.env,
      encoding: 'utf8',
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // Generous: a fresh project enabling a dozen APIs, or a workload identity
      // pool provider settling, both take longer than an IAM call does on AWS.
      timeout: 120_000,
      killSignal: 'SIGTERM',
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error: any) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    }
  }
}

/**
 * The same runner, bound to one credential set instead of this shell's.
 *
 * Replacing the environment rather than merging into it, which is the whole
 * point: mstage's identity produces a complete environment, and it clears the
 * AWS variables on purpose, so a stale key triple in the operator's shell
 * cannot send a GCP bootstrap at the other cloud. Merging would keep them.
 */
export const runAs = (credentials: NodeJS.ProcessEnv, exec: Exec = execRun): Exec => {
  // A complete environment, not a credential map. `childEnvironment` returns
  // one, and this only works because it does: a narrower map would leave the
  // child without PATH, so `gcloud` would be reported as not installed rather
  // than as unauthorised — a failure naming the wrong thing entirely.
  if (!credentials.PATH) {
    throw new Error('runAs needs a whole environment to hand over, and the one it was given has no PATH')
  }
  return (command, args, options = {}) => exec(command, args, { ...options, environment: credentials })
}
