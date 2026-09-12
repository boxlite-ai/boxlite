/*
 * Reads one stage's `deploy` block — the shape that stage is deployed into.
 *
 * The block lives in `.mstage.config.json`, inside the stage it belongs to, and
 * mstage hands it over without reading inside it. That is the division: mstage
 * says which stages exist, where they live and what the store may hand out, and
 * the keys below say how big the database is, how long its backups are kept,
 * and whether the stage refuses deletion. A value belongs here when changing it
 * changes the infrastructure, and in mstage's own keys when changing it changes
 * what configuration a running thing reads.
 *
 * That line is worth stating for the two BoxLite values that look like they
 * could go either way. `STACK_DOMAIN` is in mstage's file: it is the hostname a
 * running API serves and a running dashboard calls, and moving a stage to
 * another domain changes no resource shape. `runners.size` is here: it decides
 * which machine family a host is created from, and on GCP it decides whether
 * nested virtualization is available at all.
 *
 * Neither file holds a secret, and neither holds anything a single deploy
 * decides — an image tag comes from the invocation, because it is different
 * every time, and the runner binary's version comes from the checkout, because
 * it belongs to the commit rather than to a stage.
 *
 * Each stage carries a complete block rather than an override of shared
 * defaults. A stage is declared once and `mstage config put` sends the whole of
 * it to a runner, so a block that meant nothing without defaults kept somewhere
 * else would arrive there incomplete.
 */

import { dirname } from 'node:path'
import { loadConfig as loadMstageConfig, stageIn } from 'mstage/config'
import type { AlarmRequest, AlarmThreshold } from '../stack/alarms.ts'
import type { CacheRequest, CacheSize } from '../stack/cache.ts'
import type { ClickHouseMode, ClickHouseRequest } from '../stack/clickhouse.ts'
import type { DatabaseRequest, DatabaseSize } from '../stack/database.ts'
import type { RunnerRequest, RunnerSize } from '../stack/runners.ts'
import type { StorageRequest } from '../stack/storage.ts'

export class DeployConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeployConfigError'
  }
}

/** The runner settings a config file decides. The fleet and the binary do not. */
export type RunnerSettings = Pick<RunnerRequest, 'size' | 'rootDiskGb'>

export type DeployConfig = {
  /** The stage file the block was read out of. */
  path: string
  /** The directory holding the committed base file, which is mstage's answer. */
  root: string
  database: DatabaseRequest
  cache: CacheRequest
  storage: StorageRequest
  clickhouse: ClickHouseRequest
  runners: RunnerSettings
  alarms: AlarmRequest
}

const SECTIONS = ['database', 'cache', 'storage', 'clickhouse', 'runners', 'alarms'] as const

/** What PostgreSQL and ClickHouse both accept unquoted, which is the only form worth using. */
const UNQUOTED_NAME = /^[a-z][a-z0-9_]*$/

/**
 * A bucket-name prefix, in the intersection of what S3 and Cloud Storage allow.
 *
 * Stricter than either on purpose: this prefix is a security boundary — the
 * API's bucket-lifecycle grant is written against `<prefix>-*` — so a value
 * that could be read two ways by two clouds is not one to accept.
 */
const BUCKET_PREFIX = /^[a-z0-9][a-z0-9-]{1,40}$/

const DATABASE_SIZES: DatabaseSize[] = ['small', 'medium']
const CACHE_SIZES: CacheSize[] = ['small', 'medium']
const RUNNER_SIZES: RunnerSize[] = ['small', 'medium', 'large']
const CLICKHOUSE_MODES: ClickHouseMode[] = ['self-hosted', 'managed', 'disabled']

/** RDS keeps at most 35 days of automated backups; below one means none. */
const MAX_BACKUP_RETENTION_DAYS = 35

/** A root disk small enough to hold no box image is not worth deploying. */
const DISK_BOUNDS = { min: 20, max: 4_000 }

const ALARM_NAMES: (keyof AlarmRequest)[] = ['apiServerErrors', 'proxyUnhealthyTargets', 'runnersUnreachable']

const assertObject = (value: unknown, where: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeployConfigError(`${where} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * Every key is known, and — outside a stage override — every key is present.
 *
 * The second half is what makes the defaults complete. A stage says only what
 * differs, so a missing key there is the whole point; a missing key in the
 * defaults is a value nothing supplies, and the resource it belongs to would be
 * created from whatever the provider's own default happened to be.
 */
const assertKeys = (
  block: Record<string, unknown>,
  known: readonly string[],
  where: string,
  { partial }: { partial: boolean },
): void => {
  const unknown = Object.keys(block).filter((key) => !known.includes(key))
  if (unknown.length > 0) {
    throw new DeployConfigError(`${where} does not take ${unknown.join(', ')}. It takes ${known.join(', ')}`)
  }
  if (partial) return
  const missing = known.filter((key) => !(key in block))
  if (missing.length > 0) throw new DeployConfigError(`${where} must set ${missing.join(', ')}`)
}

const assertBoolean = (value: unknown, where: string): boolean => {
  if (typeof value !== 'boolean') throw new DeployConfigError(`${where} must be true or false`)
  return value
}

const assertWholeNumber = (value: unknown, where: string, { min, max }: { min: number; max: number }): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new DeployConfigError(`${where} must be a whole number from ${min} to ${max}`)
  }
  return value
}

const assertOneOf = <T extends string>(value: unknown, allowed: readonly T[], where: string): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new DeployConfigError(`${where} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

const assertPattern = (value: unknown, pattern: RegExp, where: string): string => {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new DeployConfigError(`${where} must match ${pattern.source}`)
  }
  return value
}

const parseDatabase = (raw: unknown, where: string, { partial }: { partial: boolean }): Partial<DatabaseRequest> => {
  const block = assertObject(raw, where)
  const known = ['name', 'size', 'highlyAvailable', 'backupRetentionDays', 'protected'] as const
  assertKeys(block, known, where, { partial })
  const parsed: Partial<DatabaseRequest> = {}
  if ('name' in block) parsed.name = assertPattern(block.name, UNQUOTED_NAME, `${where}.name`)
  if ('size' in block) parsed.size = assertOneOf(block.size, DATABASE_SIZES, `${where}.size`)
  if ('highlyAvailable' in block) {
    parsed.highlyAvailable = assertBoolean(block.highlyAvailable, `${where}.highlyAvailable`)
  }
  if ('backupRetentionDays' in block) {
    parsed.backupRetentionDays = assertWholeNumber(block.backupRetentionDays, `${where}.backupRetentionDays`, {
      min: 0,
      max: MAX_BACKUP_RETENTION_DAYS,
    })
  }
  if ('protected' in block) parsed.protected = assertBoolean(block.protected, `${where}.protected`)
  return parsed
}

const parseCache = (raw: unknown, where: string, { partial }: { partial: boolean }): Partial<CacheRequest> => {
  const block = assertObject(raw, where)
  assertKeys(block, ['size', 'clustered', 'encryptInTransit'] as const, where, { partial })
  const parsed: Partial<CacheRequest> = {}
  if ('size' in block) parsed.size = assertOneOf(block.size, CACHE_SIZES, `${where}.size`)
  if ('clustered' in block) parsed.clustered = assertBoolean(block.clustered, `${where}.clustered`)
  if ('encryptInTransit' in block) {
    const encrypted = assertBoolean(block.encryptInTransit, `${where}.encryptInTransit`)
    // Refused rather than accepted and ignored. The cache carries session state
    // and box credentials across a network shared with every other workload, so
    // "off" is not a trade-off this repository offers — and a setting that was
    // read, disallowed, and silently overridden would read as if it worked.
    if (!encrypted) throw new DeployConfigError(`${where}.encryptInTransit cannot be false; the cache holds sessions`)
    parsed.encryptInTransit = encrypted
  }
  return parsed
}

const parseStorage = (raw: unknown, where: string, { partial }: { partial: boolean }): Partial<StorageRequest> => {
  const block = assertObject(raw, where)
  assertKeys(block, ['volumePrefix', 'versioning'] as const, where, { partial })
  const parsed: Partial<StorageRequest> = {}
  if ('volumePrefix' in block) {
    parsed.volumePrefix = assertPattern(block.volumePrefix, BUCKET_PREFIX, `${where}.volumePrefix`)
  }
  if ('versioning' in block) parsed.versioning = assertBoolean(block.versioning, `${where}.versioning`)
  return parsed
}

const parseClickHouse = (
  raw: unknown,
  where: string,
  { partial }: { partial: boolean },
): Partial<ClickHouseRequest> => {
  const block = assertObject(raw, where)
  const known = ['mode', 'database', 'writerUsername', 'readerUsername', 'instanceSize', 'dataGb'] as const
  assertKeys(block, known, where, { partial })
  const parsed: Partial<ClickHouseRequest> = {}
  if ('mode' in block) parsed.mode = assertOneOf(block.mode, CLICKHOUSE_MODES, `${where}.mode`)
  for (const key of ['database', 'writerUsername', 'readerUsername'] as const) {
    if (key in block) parsed[key] = assertPattern(block[key], UNQUOTED_NAME, `${where}.${key}`)
  }
  if ('instanceSize' in block) {
    parsed.instanceSize = assertOneOf(block.instanceSize, ['small', 'medium'] as const, `${where}.instanceSize`)
  }
  if ('dataGb' in block) parsed.dataGb = assertWholeNumber(block.dataGb, `${where}.dataGb`, DISK_BOUNDS)
  if (parsed.writerUsername && parsed.writerUsername === parsed.readerUsername) {
    // One credential for both would mean a compromised read path could rewrite
    // the history it is reading, which is the whole reason there are two.
    throw new DeployConfigError(`${where}: writerUsername and readerUsername must differ`)
  }
  return parsed
}

const parseRunners = (raw: unknown, where: string, { partial }: { partial: boolean }): Partial<RunnerSettings> => {
  const block = assertObject(raw, where)
  assertKeys(block, ['size', 'rootDiskGb'] as const, where, { partial })
  const parsed: Partial<RunnerSettings> = {}
  if ('size' in block) parsed.size = assertOneOf(block.size, RUNNER_SIZES, `${where}.size`)
  if ('rootDiskGb' in block) parsed.rootDiskGb = assertWholeNumber(block.rootDiskGb, `${where}.rootDiskGb`, DISK_BOUNDS)
  return parsed
}

const parseAlarms = (raw: unknown, where: string, { partial }: { partial: boolean }): Partial<AlarmRequest> => {
  const block = assertObject(raw, where)
  assertKeys(block, ALARM_NAMES, where, { partial })
  const parsed: Partial<AlarmRequest> = {}
  for (const name of ALARM_NAMES) {
    if (!(name in block)) continue
    const alarm = assertObject(block[name], `${where}.${name}`)
    assertKeys(alarm, ['threshold', 'periods'] as const, `${where}.${name}`, { partial: false })
    parsed[name] = {
      threshold: assertWholeNumber(alarm.threshold, `${where}.${name}.threshold`, { min: 1, max: 1_000_000 }),
      periods: assertWholeNumber(alarm.periods, `${where}.${name}.periods`, { min: 1, max: 100 }),
    } satisfies AlarmThreshold
  }
  return parsed
}

const PARSERS = {
  database: parseDatabase,
  cache: parseCache,
  storage: parseStorage,
  clickhouse: parseClickHouse,
  runners: parseRunners,
  alarms: parseAlarms,
} as const

export const parseDeployConfig = (path: string, contents: string): DeployConfig => {
  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch (error) {
    throw new DeployConfigError(`${path} is not valid JSON: ${(error as Error).message}`)
  }
  const root = assertObject(raw, path)
  assertKeys(root, [...SECTIONS], path, { partial: true })
  const defaults = Object.fromEntries(
    SECTIONS.map((section) => [section, PARSERS[section](root[section], `${path}: "${section}"`, { partial: false })]),
  ) as Pick<DeployConfig, (typeof SECTIONS)[number]>

  return { path, root: dirname(path), ...defaults }
}

/**
 * Where the committed files sit, for a caller that wants only that.
 *
 * Its own function because the two questions are different: this one is
 * answerable without naming a stage, and the tools that ask it — the runner
 * build and the roll — want a directory to anchor a path against, not a
 * database size.
 */
export const deployRoot = ({
  cwd = process.cwd(),
  environment = process.env,
}: { cwd?: string; environment?: NodeJS.ProcessEnv } = {}): string => loadMstageConfig({ cwd, environment }).root

/**
 * One stage's deploy block, parsed.
 *
 * The stage is required and not defaulted: every section below decides a
 * resource, and there is no repository-wide answer to fall back on now that a
 * block is complete. A stage mstage does not declare is refused by mstage.
 */
export const loadDeployConfig = ({
  cwd = process.cwd(),
  environment = process.env,
  stage,
}: { cwd?: string; environment?: NodeJS.ProcessEnv; stage: string }): DeployConfig => {
  const mstage = loadMstageConfig({ cwd, environment })
  const declared = stageIn(mstage, stage)
  const where = `${mstage.path}: stage "${stage}" deploy`
  if (Object.keys(declared.deploy).length === 0) {
    throw new DeployConfigError(
      `${where} is empty. Every resource this stage creates is sized here, and there are no ` +
        'repository-wide defaults to fall back on — copy the block from .mstage.config.example.json',
    )
  }
  return { ...parseDeployConfig(where, JSON.stringify(declared.deploy)), path: mstage.path, root: mstage.root }
}
