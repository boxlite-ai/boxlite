/**
 * `mstage config` — a stage's declaration, to and from the GitHub environment.
 *
 * `.mstage.config.json` is not committed, so a runner has no copy. `put` sends
 * one stage's block to the GitHub environment of the same name, and `get`
 * prints it back — from the variable where there is one, from the file where
 * there is not. A script downstream calls `get` and reads JSON, without
 * knowing or caring which of the two it came from.
 *
 * `put` goes through `gh`, which is already how mstage signs in to GitHub, so
 * there is no second notion of a token here. The repository is `gh`'s to work
 * out from the checkout, for the same reason: mstage does not hold one.
 */

import { spawnSync } from 'node:child_process'
import { ConfigVariableError, resolveConfig, variableNameFor } from '../../config/variable.ts'
import { readRedirect } from '../prompt.ts'
import type { Log } from '../run.ts'

export type RunCommand = (command: string, args: string[], options: any) => any

/** Long enough for a round trip to GitHub, short enough not to hang a step. */
const GH_TIMEOUT_MS = 30_000

/**
 * `mstage config put` — this stage's block, into its GitHub environment.
 *
 * The value arrives on stdin when something piped it and is read from
 * `.mstage.config.json` when nothing did, so `put --stage=dev` on a
 * workstation needs no redirect and a pipeline can still supply its own.
 *
 * Sent through `gh`'s own stdin rather than as an argument: the block runs to
 * a few hundred bytes and argv is visible in the process table. No flag says
 * so — `gh variable set` reads the value from stdin exactly when `--body` is
 * absent, and there is no file variant of it to name instead.
 */
export const put = async ({
  app,
  stage,
  // Taken and ignored on purpose: `put` is the writer, so it reads the file
  // rather than the variable it is about to set. Named here so the handler's
  // shape stays the one `run.ts` hands every command, and underscored so a
  // consumer compiling this with `noUnusedParameters` — or with a TypeScript
  // new enough to count a destructured binding as a local — still builds.
  environment: _environment,
  cwd,
  log,
  readInput = readRedirect,
  runCommand = spawnSync as RunCommand,
}: {
  app: string
  stage: string
  environment: NodeJS.ProcessEnv
  cwd: string
  log: Log
  readInput?: () => Promise<string>
  runCommand?: RunCommand
}): Promise<number> => {
  const name = variableNameFor(app)
  // A redirect, not a prompt: `put` reads stdin only when something piped a
  // document, and falls back to the file when nothing did. Read as the whole
  // stage file rather than one block, because `<` supplies exactly that.
  const piped = (await readInput()).trim()
  const resolved = piped
    ? resolveConfig({ app, stage, environment: {}, cwd, readFile: () => piped })
    : resolveConfig({ app, stage, environment: {}, cwd })
  const { block } = resolved
  /*
   * Named here rather than taken from `resolveConfig`, which reports the path
   * it would have read: injecting the document leaves that path untouched, so
   * the one line describing this write would send a reader to a file whose
   * contents are not what was written.
   */
  const from = piped ? 'stdin' : resolved.from

  const value = JSON.stringify(block)
  log(`${name} ← ${from} (${value.length} bytes) into environment ${stage}`)
  const written = runCommand('gh', ['variable', 'set', name, '--env', stage], {
    input: value,
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
  })
  if (written.error) {
    const missing = (written.error as NodeJS.ErrnoException).code === 'ENOENT'
    throw new ConfigVariableError(
      missing ? 'gh is not installed. Install it with: brew install gh' : written.error.message,
    )
  }
  if (written.status !== 0) {
    // gh's own words: it is the thing that knows whether this is a missing
    // environment, a missing repository or a token without the scope.
    const said = [written.stderr, written.stdout].map((stream) => String(stream ?? '').trim()).find(Boolean)
    throw new ConfigVariableError(`Could not set ${name} on environment ${stage}: ${said ?? `gh exited ${written.status}`}`)
  }
  log(`${name} is set on environment ${stage}`)
  return 0
}

/**
 * `mstage config get` — the same block, printed as JSON.
 *
 * The variable first and the file second, which is what makes one command
 * work in both places. Printed to stdout alone, with everything else on the
 * log, so `$(mstage config get --stage=dev)` is the whole value.
 */
export const get = async ({
  app,
  stage,
  environment,
  cwd,
  log,
}: {
  app: string
  stage: string
  environment: NodeJS.ProcessEnv
  cwd: string
  log: Log
}): Promise<number> => {
  const { block } = resolveConfig({ app, stage, environment, cwd })
  // One line, unindented: this is read by `$(…)` and by `jq`, not by a person.
  log(JSON.stringify(block))
  return 0
}
