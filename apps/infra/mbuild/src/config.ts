/*
 * Reads the two files that say how a repository is built, and where its
 * artifacts are uploaded.
 *
 * mbuild is shared, like mstage: a repository declares its own artifacts and
 * registry here, and the same code publishes any of them. Split by *when* a
 * value is decided rather than by what it describes:
 *
 *   mstage.env.json      what is built, and what the store may hand out  ← here
 *   .mstage.config.json  which stages exist, and where each uploads       ← here
 *
 * A third tool reads the same stage block: `deploy` is mdeploy's declaration of
 * what shape the stage is deployed into, tolerated below and never read.
 *
 * A build names a commit rather than a moment and knows nothing about which
 * stage will run it; a deploy happens later and names the same commit. The
 * registries live here rather than in mdeploy's file so the publishing workflow
 * and the deploy read one declaration.
 *
 * Registries are per stage, because a repository's name may say which stage may
 * pull from it. What is built is not: an artifact present in one stage and not
 * another would make a promotion mean different things depending on where it
 * landed.
 *
 * The region is absent — mstage declares it, and a caller passes it in. So is
 * the tag: it is the commit being built, and therefore an argument.
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Committed: what is built, which does not depend on any account. */
export const ENV_FILENAME = 'mstage.env.json'
/** Not committed, and shared with mstage: where each stage uploads. */
export const STAGE_FILENAME = '.mstage.config.json'

/**
 * The fields the stage file holds for somebody other than mbuild.
 *
 * Three tools read one stage block, so each has to tolerate the others' keys
 * while still refusing a typo in its own. Named rather than skipping the check
 * altogether, because `registy` silently ignored is a stage that publishes
 * nowhere.
 *
 * Listed per owner, so adding a key names the tool that reads it: mstage
 * resolves the stage's coordinates and sign-in, and mdeploy takes `deploy` —
 * what shape the stage is deployed into, which no build has an opinion about.
 */
const MSTAGE_STAGE_KEYS = ['home', 'region', 'project', 'zone', 'roleArn', 'protect', 'login']
const MDEPLOY_STAGE_KEYS = ['deploy']
const BORROWED_STAGE_KEYS = [...MSTAGE_STAGE_KEYS, ...MDEPLOY_STAGE_KEYS]

export class BuildConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuildConfigError'
  }
}

/** Findings that fail a publish. Anything else is recorded and allowed. */
export type ScanSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL' | 'UNDEFINED'

/**
 * How one artifact is built. Both paths are relative to `repository`, not to
 * this file or the caller's cwd, so a publish from apps/infra and one from a
 * workflow build the same bytes.
 */
export type ArtifactConfig = {
  /** Repository-relative path to the Dockerfile. */
  dockerfile: string
  /** Build context, repository-relative. Usually the root, for a workspace. */
  context: string
}

/** Where one stage's artifacts are uploaded. The kind decides the address shape. */
export type RegistryConfig = {
  kind: 'ecr' | 'artifact-registry'
  /** One repository holds every artifact this repository publishes. */
  repository: string
  /** A tag that can be repointed under a running service is not a version. */
  immutableTags: boolean
  scanOnPush: boolean
}

export type StageConfig = {
  /**
   * Where the stage lives, read from the same block rather than from a copy.
   * mbuild used to load mstage's config for these; one shared file makes that
   * a second parse of the same bytes.
   */
  home: 'aws' | 'gcp'
  region: string | null
  /** The project an Artifact Registry address is built from. Null on AWS. */
  project: string | null
  registry: RegistryConfig
  /**
   * What this stage refuses to receive, and how long it waits to find out.
   *
   * Per stage, like the registry it reads: `scanOnPush` is already a property
   * of the repository a stage publishes into, and a threshold that could not
   * differ would make prod no stricter than dev.
   */
  scan: ScanPolicy
}

export type ScanPolicy = {
  blockOn: ScanSeverity[]
  /** How long to wait for a scan to report before giving up on it. */
  timeoutSeconds: number
}

export type BuildConfig = {
  /** The stage file. Every refusal about a stage names this. */
  path: string
  /** The base file. Artifacts and the repository root name this. */
  basePath: string
  /** The directory the base file is in. */
  root: string
  /**
   * The repository root, resolved once here so nothing downstream depends on a
   * working directory. Artifact paths are relative to this, not to this file.
   */
  repository: string
  /** The same everywhere: what is built does not depend on where it lands. */
  artifacts: Record<string, ArtifactConfig>
  stages: Record<string, StageConfig>
}

const REGISTRY_KINDS: RegistryConfig['kind'][] = ['ecr', 'artifact-registry']

const SEVERITIES: ScanSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL', 'UNDEFINED']

/**
 * The intersection of both registries' rules: ECR allows `_ - . /`, Artifact
 * Registry only `-`, so this is what a name usable on both looks like.
 */
const REPOSITORY_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

/** An artifact name becomes part of an image name or tag, depending on the kind. */
const ARTIFACT_NAME = /^[a-z][a-z0-9-]{0,30}$/

/** The same names mstage declares, so one file's stage means the other's. */
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BuildConfigError(`${where} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * Every key accounted for, and every required one present.
 *
 * `borrowed` names keys this parser accepts but does not own — the stage file
 * is shared with mstage — so they are allowed without being demanded.
 */
const assertKeys = (
  block: Record<string, unknown>,
  known: string[],
  where: string,
  borrowed: string[] = [],
): void => {
  const unknown = Object.keys(block).filter((key) => !known.includes(key))
  if (unknown.length > 0) {
    throw new BuildConfigError(`${where} does not take ${unknown.join(', ')}. It takes ${known.join(', ')}`)
  }
  const missing = known.filter((key) => !borrowed.includes(key) && !(key in block))
  if (missing.length > 0) throw new BuildConfigError(`${where} must set ${missing.join(', ')}`)
}

/** A path that stays inside the repository, which is the whole build context. */
const assertContainedPath = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) {
    throw new BuildConfigError(`${where} must be a path inside the repository`)
  }
  if (value.split('/').includes('..')) {
    throw new BuildConfigError(`${where} must not climb out of the repository`)
  }
  return value
}

const parseArtifacts = (raw: unknown, where: string): Record<string, ArtifactConfig> => {
  const block = assertObject(raw, where)
  const names = Object.keys(block)
  if (names.length === 0) throw new BuildConfigError(`${where} must declare at least one artifact`)
  const parsed: Record<string, ArtifactConfig> = {}
  for (const name of names) {
    if (!ARTIFACT_NAME.test(name)) {
      throw new BuildConfigError(`${where}: artifact "${name}" must match ${ARTIFACT_NAME.source}`)
    }
    const artifact = assertObject(block[name], `${where}.${name}`)
    assertKeys(artifact, ['dockerfile', 'context'], `${where}.${name}`)
    parsed[name] = {
      dockerfile: assertContainedPath(artifact.dockerfile, `${where}.${name}.dockerfile`),
      context: assertContainedPath(artifact.context, `${where}.${name}.context`),
    }
  }
  return parsed
}

const parseRegistry = (raw: unknown, where: string): RegistryConfig => {
  const block = assertObject(raw, where)
  assertKeys(block, ['kind', 'repository', 'immutableTags', 'scanOnPush'], where)
  if (!REGISTRY_KINDS.includes(block.kind as RegistryConfig['kind'])) {
    throw new BuildConfigError(`${where}.kind must be one of ${REGISTRY_KINDS.join(', ')}`)
  }
  const kind = block.kind as RegistryConfig['kind']
  if (typeof block.repository !== 'string' || !REPOSITORY_NAME.test(block.repository)) {
    throw new BuildConfigError(`${where}.repository must match ${REPOSITORY_NAME.source}`)
  }
  for (const flag of ['immutableTags', 'scanOnPush'] as const) {
    if (typeof block[flag] !== 'boolean') throw new BuildConfigError(`${where}.${flag} must be true or false`)
  }
  return {
    kind,
    repository: block.repository,
    immutableTags: block.immutableTags as boolean,
    scanOnPush: block.scanOnPush as boolean,
  }
}

const parseStages = (raw: unknown, where: string): Record<string, StageConfig> => {
  const block = assertObject(raw, where)
  const names = Object.keys(block)
  if (names.length === 0) throw new BuildConfigError(`${where} must declare at least one stage`)
  const parsed: Record<string, StageConfig> = {}
  for (const name of names) {
    if (!STAGE_NAME.test(name)) {
      throw new BuildConfigError(`${where}: stage "${name}" may only contain letters, digits and "-"`)
    }
    const stage = assertObject(block[name], `${where}.${name}`)
    assertKeys(stage, ['registry', 'scan', ...BORROWED_STAGE_KEYS], `${where}.${name}`, BORROWED_STAGE_KEYS)
    const registry = parseRegistry(stage.registry, `${where}.${name}.registry`)
    // The cloud a stage lives in and the registry it publishes to are one
    // decision spelled twice in the same block. An `ecr` repository on a stage
    // whose workloads are Cloud Run services is an address nothing in that
    // project can pull, and the deploy that finds out has already built a
    // network.
    if (stage.home !== 'aws' && stage.home !== 'gcp') {
      throw new BuildConfigError(`${where}.${name} must declare home as "aws" or "gcp"`)
    }
    const expected = stage.home === 'gcp' ? 'artifact-registry' : 'ecr'
    if (registry.kind !== expected) {
      throw new BuildConfigError(
        `${where}.${name} lives in ${stage.home} and must publish to ${expected}, not ${registry.kind}`,
      )
    }
    parsed[name] = {
      home: stage.home,
      region: (stage.region as string) ?? null,
      project: (stage.project as string) ?? null,
      registry,
      scan: parseScan(stage.scan, `${where}.${name}.scan`),
    }
  }
  return parsed
}

const parseScan = (raw: unknown, where: string): ScanPolicy => {
  const block = assertObject(raw, where)
  assertKeys(block, ['blockOn', 'timeoutSeconds'], where)
  if (!Array.isArray(block.blockOn) || block.blockOn.length === 0) {
    throw new BuildConfigError(`${where}.blockOn must be a non-empty array`)
  }
  for (const severity of block.blockOn) {
    if (!SEVERITIES.includes(severity as ScanSeverity)) {
      throw new BuildConfigError(`${where}.blockOn must contain only ${SEVERITIES.join(', ')}`)
    }
  }
  const timeout = block.timeoutSeconds
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 3_600) {
    throw new BuildConfigError(`${where}.timeoutSeconds must be a whole number from 1 to 3600`)
  }
  return { blockOn: block.blockOn as ScanSeverity[], timeoutSeconds: timeout }
}

/** One object out of a file, or the refusal naming that file. */
const documentIn = (path: string, contents: string): Record<string, unknown> => {
  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch (error) {
    throw new BuildConfigError(`${path} is not valid JSON: ${(error as Error).message}`)
  }
  return assertObject(raw, path)
}

/** The committed half: what is built, and the tree it is built from. */
export const parseBase = (
  path: string,
  contents: string,
): Pick<BuildConfig, 'root' | 'repository' | 'artifacts'> => {
  const root = documentIn(path, contents)
  // mstage owns the rest of this file, so its keys are borrowed rather than
  // refused — and `root` and `artifacts` are still demanded. `appShort` is
  // mstage's too: the app abbreviated, for names with a length budget.
  assertKeys(root, ['root', 'artifacts', 'app', 'appShort', 'env'], path, ['app', 'appShort', 'env'])
  if (typeof root.root !== 'string' || root.root.trim() === '') {
    throw new BuildConfigError(`${path}: "root" must name the repository root, relative to this file`)
  }
  return {
    root: dirname(path),
    repository: resolve(dirname(path), root.root),
    artifacts: parseArtifacts(root.artifacts, `${path}: "artifacts"`),
  }
}

/** The uncommitted half: where each stage uploads, and what it refuses. */
export const parseBuildStages = (path: string, contents: string): Record<string, StageConfig> =>
  parseStages(documentIn(path, contents).stages, `${path}: "stages"`)

/**
 * Both halves, as one answer. Kept separate as far as here so a refusal names
 * the file that has to be edited.
 */
export const parseBuildConfig = ({
  basePath,
  base,
  stagePath,
  stages,
}: {
  basePath: string
  base: string
  stagePath: string
  stages: string
}): BuildConfig => ({
  path: stagePath,
  basePath,
  ...parseBase(basePath, base),
  stages: parseBuildStages(stagePath, stages),
})

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
  if (!path) throw new BuildConfigError(`Could not find ${filename} in ${cwd} or any parent directory`)
  try {
    return { path, contents: readFileSync(path, 'utf8') }
  } catch (error) {
    throw new BuildConfigError(`Could not read ${path}: ${(error as Error).message}`)
  }
}

/** Both files. The same two mstage reads, and the stage file is literally the same one. */
export const loadBuildConfig = ({
  cwd = process.cwd(),
  environment = process.env,
}: { cwd?: string; environment?: NodeJS.ProcessEnv } = {}): BuildConfig => {
  const base = locate({ cwd, override: environment.MSTAGE_ENV_CONFIG, filename: ENV_FILENAME })
  const stages = locate({ cwd, override: environment.MSTAGE_CONFIG, filename: STAGE_FILENAME })
  return parseBuildConfig({
    basePath: base.path,
    base: base.contents,
    stagePath: stages.path,
    stages: stages.contents,
  })
}

/**
 * One declared stage, or the refusal naming the file that would declare it. An
 * undeclared stage is a typo, not a new environment: publishing into it would
 * create a repository nothing ever pulls from.
 */
export const stageIn = (config: BuildConfig, stage: string): StageConfig => {
  const declared = config.stages[stage]
  if (!declared) {
    throw new BuildConfigError(
      `${config.path} declares no stage "${stage}". Declared: ${Object.keys(config.stages).join(', ')}`,
    )
  }
  return declared
}

/** One stage's registry. */
export const registryFor = (config: BuildConfig, stage: string): RegistryConfig => stageIn(config, stage).registry

/** The region a stage's registry is addressed in, which every address needs. */
export const regionFor = (config: BuildConfig, stage: string): string => {
  const { region } = stageIn(config, stage)
  if (!region) throw new BuildConfigError(`${config.path} gives stage "${stage}" no region`)
  return region
}
