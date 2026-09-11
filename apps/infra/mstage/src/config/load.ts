/**
 * Reads the two files that describe what mstage may touch.
 *
 *   mstage.env.json    what the repository is, and what its store holds
 *   .mstage.config.json  the stages that exist, and what each one costs to reach
 *
 * The split is by whether a value names an account. `mstage.env.json` is
 * committed and reviewed: the app name, and which subsets of the store may
 * leave it. `.mstage.config.json` is not committed, because a stage names a
 * cloud, a project and a region — the coordinates of somebody's account, which
 * differ per checkout and are nobody else's to inherit.
 *
 * A stage is the unit that decides. It says which cloud it lives in and what
 * has to be signed in to reach it, so nothing above composes a repository-wide
 * default with a per-stage override. An undeclared stage is a typo, not a new
 * environment, and is refused rather than opening a secret namespace under the
 * misspelling.
 *
 * The tenant is absent on AWS — the account is whatever the resolved
 * credentials reach, read back from STS. GCP clients cannot be built without a
 * project, so a GCP stage declares one and nothing else does.
 *
 * How a stage is deployed still belongs to mdeploy. The stage block carries a
 * `deploy` block for it, because a stage is declared once and `config put`
 * carries the whole block to a runner — but nothing here reads inside it.
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { SECRET_GROUP } from '../env/secret-address.ts'

/** Committed: what the repository is, independent of any account. */
export const ENV_FILENAME = 'mstage.env.json'
/** Not committed: the stages, which name somebody's cloud coordinates. */
export const STAGE_FILENAME = '.mstage.config.json'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Which cloud a stage lives in. Declared per stage; there is no default. */
export type Cloud = 'aws' | 'gcp'

export type StageConfig = {
  region: string | null
  /**
   * Which cloud this stage lives in. Declared, never defaulted: a repository
   * with stages in two clouds has no one answer, and making the stage say so
   * is what lets both be deployable from one checkout.
   */
  home: Cloud
  /**
   * What has to be signed in to reach this stage, provider by provider.
   *
   * Per stage rather than per repository, because a stage in one cloud needs
   * no credential for the other — read repository-wide, an expired AWS session
   * refused a GCP deploy on a machine that needed no AWS credential for it.
   * GitHub and Auth0 are not a cloud, and a stage that needs them says so.
   */
  login: Record<string, LoginRequirement>
  /** The GCP project this stage lives in. Null on AWS, which reads it from STS. */
  project: string | null
  /**
   * The zone inside the region this stage's machines are created in, or null
   * for the region's first.
   *
   * Declarable because that default is not always available: machine families
   * are stocked per zone, and a region's first zone answering `stockout` for
   * the family a runner needs is ordinary. Nothing on AWS reads it — there a
   * subnet carries the zone.
   */
  zone: string | null
  roleArn: string | null
  protect: boolean
  /**
   * mdeploy's half of the same stage block: what shape this stage is deployed
   * into. Carried, never read here.
   *
   * It lives in the stage block rather than in a file of mdeploy's own for the
   * reason `registry` does: a stage is declared once, and `config put` carries
   * the whole block to a runner in one variable — a second file would need a
   * second way of getting there. mstage checks only that it is an object, so
   * every key inside it stays mdeploy's to name and to refuse.
   *
   * `{}` when the stage does not declare one, so a consumer reads the same
   * shape whether or not it is written out.
   */
  deploy: Record<string, unknown>
}

export type LoginRequirement = { required: boolean }

/**
 * Named subsets of the store that may leave it.
 *
 * Everything needing part of the store asks for a group by name rather than the
 * whole thing, so adding a key is a reviewable edit to this file — the only
 * reason exporting is safe at all.
 *
 * One group name means more than the rest: `secret` says its keys hold the
 * *address* of a secret rather than the secret, which is what lets a workload be
 * handed one by reference (`env/secret-address.ts`).
 *
 * Holds every key a group names; `envOptional` below is what tells required
 * from optional.
 */
export type EnvExports = Record<string, string[]>

/**
 * A group may be written two ways: an array, meaning every key is required, or
 * `{ required, optional }`.
 *
 * The object form exists because "the store must hold this" and "this stage may
 * not have set this" are different statements. A missing required key is the
 * failure `valuesOfGroup` refuses on purpose; a missing optional one is a
 * feature this stage did not configure, which the consumer already handles.
 * Without it, saying nothing costs a row of empty strings per stage.
 */
export type EnvGroupDeclaration = string[] | { required?: string[]; optional?: string[] }

/**
 * Which key holds the fingerprint of which group. Absent means this repository
 * does not fingerprint its configuration, and `--digest` has nothing to write.
 */
export type EnvDigest = { key: string; group: string }

export type MstageConfig = {
  /** The stage file. Everything about a stage is refused in its name. */
  path: string
  /** The base file. `app` and every env group is refused in its name. */
  basePath: string
  root: string
  app: string
  /**
   * The app, abbreviated, for names with a length budget.
   *
   * A GCP service account id takes 30 characters, and a name that has to carry
   * the app, the stage, the workload and what it may do does not fit an app
   * spelled out. Declared rather than derived: `boxlite-backoffice` shortens to
   * `bl-bo` by the initials of the words inside each word, and nothing can read
   * that out of the string — `box`+`lite` and `back`+`office` are splits a
   * person knows and an algorithm does not.
   *
   * Defaults to `app`, so a repository whose app is already short declares
   * nothing and reads the same field either way.
   */
  appShort: string
  /** Every key each group names, required and optional together. */
  envSelectGroup: EnvExports
  /**
   * The subset of each group whose keys the store need not hold. A separate map
   * rather than a richer `envSelectGroup`, because almost every consumer asks
   * only which keys a group names.
   */
  envOptional: EnvExports
  envDigest: EnvDigest | null
  stages: Record<string, StageConfig>
}

const STAGE_NAME = /^[a-zA-Z0-9-]+$/

const findUp = (from: string, filename: string): string | null => {
  let directory = resolve(from)
  for (;;) {
    const candidate = join(directory, filename)
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      const parent = dirname(directory)
      if (parent === directory) return null
      directory = parent
    }
  }
}

const assertObject = (value: unknown, where: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`${where} must be an object`)
  return value as Record<string, unknown>
}

const assertNonEmptyString = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(`${where} must be a non-empty string`)
  return value
}

/** The same shape SST requires of a name it can set (cmd/sst/secret.go:363). */
const ENV_KEY = /^[A-Z][a-zA-Z0-9_]*$/

/**
 * A marked key belongs to some group that delivers it.
 *
 * `secret` names no consumer — it marks which keys hold an address rather than
 * a value, and some other group decides who receives it. A key marked and
 * delivered nowhere is invisible until someone wonders why the secret never
 * arrived.
 */
const assertMarkedKeysAreDelivered = (groups: EnvExports, path: string): void => {
  const marked = groups[SECRET_GROUP]
  if (!marked) return
  const delivered = new Set(
    Object.entries(groups)
      .filter(([group]) => group !== SECRET_GROUP)
      .flatMap(([, keys]) => keys),
  )
  const orphans = marked.filter((key) => !delivered.has(key))
  if (orphans.length > 0) {
    throw new ConfigError(
      `${path}: "env.selectGroup.${SECRET_GROUP}" marks ${orphans.join(', ')}, which no other group names; ` +
        'the mark says a key holds an address, and some group has to say who reads it',
    )
  }
}

/** One list of key names, checked for shape and for repeats. */
const parseKeyList = (keys: unknown, where: string): string[] => {
  // Empty is a state, not a mistake: a consumer with one service per group
  // needs to say "this service reads nothing yet". Refusing that forces a
  // placeholder key, or no declaration at all — which hides the service.
  if (!Array.isArray(keys)) throw new ConfigError(`${where} must be an array of key names`)
  for (const key of keys) {
    if (typeof key !== 'string' || !ENV_KEY.test(key)) {
      throw new ConfigError(`${where} contains ${JSON.stringify(key)}, which is not a key name`)
    }
  }
  const duplicates = (keys as string[]).filter((key, index) => keys.indexOf(key) !== index)
  if (duplicates.length > 0) {
    throw new ConfigError(`${where} repeats ${[...new Set(duplicates)].join(', ')}`)
  }
  return [...(keys as string[])]
}

/**
 * Both forms of a group. Returns the union and the optional half separately,
 * because those are the two questions consumers ask.
 */
const parseEnvSelectGroup = (raw: unknown, path: string): { all: EnvExports; optional: EnvExports } => {
  if (raw === undefined) return { all: {}, optional: {} }
  const env = assertObject(raw, `${path}: "env"`)
  if (env.selectGroup === undefined) return { all: {}, optional: {} }
  const show = assertObject(env.selectGroup, `${path}: "env.selectGroup"`)

  const all: EnvExports = {}
  const optional: EnvExports = {}
  for (const [group, declared] of Object.entries(show)) {
    const where = `${path}: "env.selectGroup.${group}"`
    if (Array.isArray(declared)) {
      all[group] = parseKeyList(declared, where)
      optional[group] = []
      continue
    }
    if (!declared || typeof declared !== 'object') {
      // Named here rather than left to `assertObject`, so the refusal names
      // both accepted shapes rather than only the one tried last.
      throw new ConfigError(`${where} must be an array of key names, or an object with required and optional`)
    }
    const block = assertObject(declared, where)
    const unknown = Object.keys(block).filter((key) => key !== 'required' && key !== 'optional')
    if (unknown.length > 0) {
      throw new ConfigError(`${where} does not take ${unknown.join(', ')}. It takes required, optional`)
    }
    const required = parseKeyList(block.required ?? [], `${where}.required`)
    const mayBeAbsent = parseKeyList(block.optional ?? [], `${where}.optional`)
    const both = required.filter((key) => mayBeAbsent.includes(key))
    if (both.length > 0) {
      // Left in, the required list would win and the optional list would read
      // as a promise the store never made.
      throw new ConfigError(`${where} names ${both.join(', ')} as both required and optional`)
    }
    all[group] = [...required, ...mayBeAbsent]
    optional[group] = mayBeAbsent
  }
  assertMarkedKeysAreDelivered(all, path)
  return { all, optional }
}

const parseEnvDigest = (
  raw: unknown,
  groups: EnvExports,
  optional: EnvExports,
  path: string,
): EnvDigest | null => {
  if (raw === undefined) return null
  const env = assertObject(raw, `${path}: "env"`)
  if (env.digest === undefined) return null
  const digest = assertObject(env.digest, `${path}: "env.digest"`)
  const key = assertNonEmptyString(digest.key, `${path}: "env.digest.key"`)
  if (!ENV_KEY.test(key)) throw new ConfigError(`${path}: "env.digest.key" ${JSON.stringify(key)} is not a key name`)
  const group = (digest.group as string) ?? 'deploy'
  if (!groups[group]) {
    const known = Object.keys(groups).join(', ') || '(none)'
    throw new ConfigError(`${path}: "env.digest.group" names "${group}", which env.selectGroup does not declare: ${known}`)
  }
  if (!groups[group].includes(key)) {
    // The digest travels with the group it describes, so a consumer that reads
    // the group has it without a second lookup.
    throw new ConfigError(`${path}: env.selectGroup.${group} must include ${key}, the key its digest is written to`)
  }
  if ((optional[group] ?? []).includes(key)) {
    // An optional fingerprint is no fingerprint: the check would pass on
    // every stage that never wrote one.
    throw new ConfigError(`${path}: ${key} is the digest of env.selectGroup.${group} and cannot be optional`)
  }
  return { key, group }
}

const parseLogin = (raw: unknown, where: string): Record<string, LoginRequirement> => {
  if (raw === undefined) return {}
  const login = assertObject(raw, `${where} login`)
  return Object.fromEntries(
    Object.entries(login).map(([provider, value]) => {
      const entry = assertObject(value, `${where} login "${provider}"`)
      if (entry.required !== undefined && typeof entry.required !== 'boolean') {
        throw new ConfigError(`${where} login "${provider}" required must be true or false`)
      }
      return [provider, { required: (entry.required as boolean) ?? true }]
    }),
  )
}

const parseStage = (name: string, raw: unknown, path: string): StageConfig => {
  // SST's own constraint (pkg/project/project.go:115). mstage reads and writes the
  // same S3 keys, so a name SST would reject must never reach the bucket.
  if (!STAGE_NAME.test(name)) {
    throw new ConfigError(`${path}: stage "${name}" may only contain letters, digits and "-"`)
  }
  const stage = assertObject(raw, `${path}: stage "${name}"`)
  for (const key of ['region', 'project', 'zone', 'roleArn'] as const) {
    if (stage[key] !== undefined) assertNonEmptyString(stage[key], `${path}: stage "${name}" ${key}`)
  }
  if (stage.protect !== undefined && typeof stage.protect !== 'boolean') {
    throw new ConfigError(`${path}: stage "${name}" protect must be true or false`)
  }
  if (stage.home !== 'aws' && stage.home !== 'gcp') {
    throw new ConfigError(
      `${path}: stage "${name}" must declare home as "aws" or "gcp"; ` +
        "a stage says which cloud it lives in, and there is no repository-wide default",
    )
  }
  const home: Cloud = stage.home
  // Refused here rather than where the clients are built: a GCP stage's
  // Storage and Secret Manager clients cannot exist without a project, and
  // this file is the only thing that can supply one.
  if (home === 'gcp' && stage.project === undefined) {
    throw new ConfigError(
      `${path}: stage "${name}" lives in gcp and must declare a project; ` +
        'a GCP client cannot be built without one',
    )
  }
  return {
    region: (stage.region as string) ?? null,
    home,
    login: parseLogin(stage.login, `${path}: stage "${name}"`),
    project: (stage.project as string) ?? null,
    zone: (stage.zone as string) ?? null,
    roleArn: (stage.roleArn as string) ?? null,
    protect: (stage.protect as boolean) ?? false,
    // Checked for shape and nothing else: the keys are mdeploy's, and a list
    // of them here would be a second copy to keep in step. An empty block is
    // the ordinary state of a stage mdeploy has not been pointed at yet.
    deploy: stage.deploy === undefined ? {} : assertObject(stage.deploy, `${path}: stage "${name}" deploy`),
  }
}

/**
 * The shape a name may be built from: what both clouds accept in the first
 * segment of a resource name, which is a letter and then letters, digits or
 * `-`. How short it has to be is not asked here — mstage names nothing that has
 * a budget, and the tool that does refuses what will not fit.
 */
const APP_SHORT = /^[a-z][a-z0-9-]*$/

const parseAppShort = (root: Record<string, unknown>, path: string): string => {
  if (root.appShort === undefined) return root.app as string
  const short = assertNonEmptyString(root.appShort, `${path}: "appShort"`)
  if (!APP_SHORT.test(short)) {
    throw new ConfigError(`${path}: "appShort" ${JSON.stringify(short)} must match ${APP_SHORT.source}`)
  }
  return short
}

/** The committed half: what the repository is, and what its store may hand out. */
export const parseBase = (
  path: string,
  contents: string,
): Pick<MstageConfig, 'app' | 'appShort' | 'envSelectGroup' | 'envOptional' | 'envDigest'> => {
  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`)
  }
  const root = assertObject(raw, path)
  assertNonEmptyString(root.app, `${path}: "app"`)
  const { all: envSelectGroup, optional: envOptional } = parseEnvSelectGroup(root.env, path)
  return {
    app: root.app as string,
    appShort: parseAppShort(root, path),
    envSelectGroup,
    envOptional,
    envDigest: parseEnvDigest(root.env, envSelectGroup, envOptional, path),
  }
}

/** The uncommitted half: which stages exist, and what each one costs to reach. */
export const parseStages = (path: string, contents: string): Record<string, StageConfig> => {
  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`)
  }
  const root = assertObject(raw, path)
  const stages = assertObject(root.stages, `${path}: "stages"`)
  const names = Object.keys(stages)
  if (names.length === 0) throw new ConfigError(`${path}: "stages" must declare at least one stage`)
  return Object.fromEntries(names.map((name) => [name, parseStage(name, stages[name], path)]))
}

/**
 * Both halves, as one answer.
 *
 * Kept separate as far as here so each refusal names the file that has to be
 * edited: an env group is `mstage.env.json`'s to fix and a stage is not, and
 * the two are not even edited by the same person.
 */
export const parseConfig = ({
  basePath,
  base,
  stagePath,
  stages,
}: {
  basePath: string
  base: string
  stagePath: string
  stages: string
}): MstageConfig => ({
  path: stagePath,
  basePath,
  root: dirname(basePath),
  ...parseBase(basePath, base),
  stages: parseStages(stagePath, stages),
})

/**
 * One declared stage, or the refusal naming the file that would declare it.
 * Shared, so every caller reports an unknown stage the same way.
 */
export const stageIn = (config: Pick<MstageConfig, 'stages' | 'path'>, stage: string): StageConfig => {
  const declared = config.stages[stage]
  if (!declared) {
    const known = Object.keys(config.stages).join(', ')
    throw new ConfigError(`${config.path} declares no stage "${stage}". Declared: ${known}`)
  }
  return declared
}

/**
 * Which cloud one stage lives in.
 *
 * A lookup rather than a fallback, now that the stage is the only thing that
 * declares it. Everything downstream — store backend, identity, provider
 * bundle, registry kind — follows from this one answer.
 */
export const homeFor = (config: Pick<MstageConfig, 'stages' | 'path'>, stage: string): Cloud =>
  stageIn(config, stage).home

/** One file, named outright or found by walking up. */
const locate = ({
  cwd,
  override,
  filename,
}: {
  cwd: string
  override: string | undefined
  filename: string
}): { path: string; contents: string } => {
  const path = override ? (isAbsolute(override) ? override : resolve(cwd, override)) : findUp(cwd, filename)
  if (!path) throw new ConfigError(`Could not find ${filename} in ${cwd} or any parent directory`)
  try {
    return { path, contents: readFileSync(path, 'utf8') }
  } catch (error) {
    throw new ConfigError(`Could not read ${path}: ${(error as Error).message}`)
  }
}

/**
 * The committed half alone, for a caller that has no stage file.
 *
 * `config get` is that caller: on a runner the stages arrive as an environment
 * variable and `.mstage.config.json` is not there at all, but the app name —
 * which says which variable to read — is committed and always is.
 */
export const loadEnvFile = ({
  cwd = process.cwd(),
  environment = process.env,
}: { cwd?: string; environment?: NodeJS.ProcessEnv } = {}): Pick<
  MstageConfig,
  'app' | 'appShort' | 'envSelectGroup' | 'envOptional' | 'envDigest'
> & { path: string } => {
  const base = locate({ cwd, override: environment.MSTAGE_ENV_CONFIG, filename: ENV_FILENAME })
  return { path: base.path, ...parseBase(base.path, base.contents) }
}

/**
 * Both files, each found on its own.
 *
 * Separately rather than as one lookup, because they need not sit together:
 * `mstage.env.json` is committed beside the code, and `.mstage.config.json`
 * is whatever this machine or this runner put where it could be found. A
 * missing stage file is the ordinary state of a fresh checkout, and the
 * refusal names it so the reader knows which of the two to write.
 */
export const loadConfig = ({
  cwd = process.cwd(),
  environment = process.env,
}: { cwd?: string; environment?: NodeJS.ProcessEnv } = {}): MstageConfig => {
  const base = locate({ cwd, override: environment.MSTAGE_ENV_CONFIG, filename: ENV_FILENAME })
  const stages = locate({ cwd, override: environment.MSTAGE_CONFIG, filename: STAGE_FILENAME })
  return parseConfig({
    basePath: base.path,
    base: base.contents,
    stagePath: stages.path,
    stages: stages.contents,
  })
}
