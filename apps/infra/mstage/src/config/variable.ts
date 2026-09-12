/*
 * One stage's declaration, carried outside the repository.
 *
 * `.mstage.config.json` is not committed, so a runner has no copy of it. What
 * a runner does have is the GitHub environment it runs in, and this is the one
 * value mstage keeps there: the same stage block, under a name derived from
 * the app.
 *
 * `put` writes it; `get` reads it back, from the variable where there is one
 * and from the file where there is not. Both halves live here rather than in
 * the command, so the name and the shape are decided once — a writer and a
 * reader that disagreed about either would fail only on a runner, which is the
 * one place neither is easy to look at.
 *
 * Nothing here reaches the network. `put` hands the value to `gh`, which is
 * already how mstage signs in to GitHub.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STAGE_FILENAME } from './load.ts'

export class ConfigVariableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigVariableError'
  }
}

/**
 * Where a stage's declaration lives on GitHub.
 *
 * The app decides the name, so two apps sharing one repository's environments
 * do not overwrite each other. `-` is not legal in an environment variable
 * name, so it becomes `_`; the rest is the app as written, upper-cased.
 */
export const variableNameFor = (app: string): string => {
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(app)) {
    throw new ConfigVariableError(`"${app}" is not an app name a variable can be named after`)
  }
  return `BOXLITE_MSTAGE_${app.toUpperCase().replace(/-/g, '_')}_CONFIG`
}

/**
 * One stage, wrapped in its own name.
 *
 * The wrapper is what makes the value self-describing: a variable read out of
 * the wrong environment says which stage it is for, rather than looking like a
 * stage that happens to have the wrong region in it.
 */
export const blockFor = ({
  stages,
  stage,
  where,
}: {
  stages: Record<string, unknown>
  stage: string
  where: string
}): Record<string, unknown> => {
  const declared = stages[stage]
  if (declared === undefined) {
    const known = Object.keys(stages).join(', ') || '(none)'
    throw new ConfigVariableError(`${where} declares no stage "${stage}". Declared: ${known}`)
  }
  return { [stage]: declared }
}

/** The `stages` map out of a stage-file document, refusing anything else. */
export const stagesIn = (contents: string, where: string): Record<string, unknown> => {
  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch (error) {
    throw new ConfigVariableError(`${where} is not valid JSON: ${(error as Error).message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigVariableError(`${where} must be an object`)
  }
  const stages = (raw as Record<string, unknown>).stages
  if (!stages || typeof stages !== 'object' || Array.isArray(stages)) {
    throw new ConfigVariableError(`${where} must declare "stages"`)
  }
  return stages as Record<string, unknown>
}

export type ConfigSource = { block: Record<string, unknown>; from: string }

/**
 * One stage's block, from the variable if it is set and from the file if not.
 *
 * The order is what makes the same command work in both places: on a runner
 * the variable is the only copy, and locally the file is. An empty variable is
 * read as absent rather than as an empty config, because that is what an
 * unset GitHub variable expands to in a shell.
 *
 * What the variable holds is trusted — `put` is what wrote it — so no block
 * inside it is checked against the stage file's rules. Both sources are still
 * narrowed to the stage asked for: a variable read out of an environment that
 * carries more than one would otherwise hand back a document naming stages
 * this call said nothing about.
 */
export const resolveConfig = ({
  app,
  stage,
  environment,
  cwd,
  readFile = (path: string) => readFileSync(path, 'utf8'),
}: {
  app: string
  stage: string
  environment: NodeJS.ProcessEnv
  cwd: string
  readFile?: (path: string) => string
}): ConfigSource => {
  const name = variableNameFor(app)
  const carried = environment[name]
  if (carried && carried.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(carried)
    } catch (error) {
      throw new ConfigVariableError(`${name} is not valid JSON: ${(error as Error).message}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigVariableError(`${name} must hold an object`)
    }
    const block = parsed as Record<string, unknown>
    if (!(stage in block)) {
      const known = Object.keys(block).join(', ') || '(none)'
      throw new ConfigVariableError(`${name} holds no stage "${stage}". It holds: ${known}`)
    }
    return { block: { [stage]: block[stage] }, from: name }
  }

  const path = join(cwd, STAGE_FILENAME)
  let contents: string
  try {
    contents = readFile(path)
  } catch {
    throw new ConfigVariableError(
      `${name} is not set and ${path} is not there, so there is nothing to read stage "${stage}" from`,
    )
  }
  return { block: blockFor({ stages: stagesIn(contents, path), stage, where: path }), from: path }
}
