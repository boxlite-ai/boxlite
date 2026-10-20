import { HttpException } from '@nestjs/common'
import { isISO8601, isUUID } from 'class-validator'

export const USAGE_METRICS = ['computeVcpuSeconds', 'storageByteSeconds', 'memoryGibSeconds'] as const
export const USAGE_DIMENSIONS = ['organizationId', 'regionId', 'boxId'] as const
export const USAGE_GRANULARITIES = ['window', 'hour', 'day'] as const
export const USAGE_DEFINITION = 'resource-usage-v1'
export const USAGE_MAX_PERIODS = 200_000
export const USAGE_MAX_ITEMS = 5_000
export const USAGE_MAX_BYTES = 2 * 1024 * 1024
export const USAGE_TTL_SECONDS = 900
export type UsageMetric = (typeof USAGE_METRICS)[number]
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number]
export type UsageGranularity = (typeof USAGE_GRANULARITIES)[number]
export type UsageQuery = {
  from: string
  to: string
  granularity: UsageGranularity
  metrics: UsageMetric[]
  groupBy: UsageDimension[]
  organizationId?: string
  regionId?: string
  boxId?: string
}
export type UsageRequest = { query: UsageQuery; limit: number; cursor?: string }

const errors = {
  400: ['invalid_usage_query', 'Invalid usage query'],
  410: ['usage_query_expired', 'Usage query expired'],
  422: ['usage_query_too_large', 'Usage query too large'],
  503: ['usage_source_unavailable', 'Usage source unavailable'],
} as const
export const usageError = (status: keyof typeof errors): HttpException =>
  new HttpException({ statusCode: status, code: errors[status][0], message: errors[status][1] }, status)
const invalid = (): never => {
  throw usageError(400)
}

const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value || value.length > max) return invalid()
  return value
}
const instant = (value: unknown): string => {
  const raw = text(value, 35)
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(raw) ||
    !isISO8601(raw, { strict: true, strictSeparator: true })
  )
    return invalid()
  const date = new Date(raw)
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return invalid()
  return date.toISOString()
}
const selection = <T extends string>(raw: unknown, allowed: readonly T[], fallback: T[], max = allowed.length): T[] => {
  if (raw === undefined) return fallback
  const values = text(raw, 128).split(',')
  if (new Set(values).size !== values.length || values.length > max || values.some((v) => !allowed.includes(v as T)))
    return invalid()
  return allowed.filter((v) => values.includes(v))
}
const identifier = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  const raw = text(value, 128)
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw) ? raw : invalid()
}

export const parseUsageRequest = (raw: Record<string, unknown>, now = Date.now()): UsageRequest => {
  const allowed = ['from', 'to', 'granularity', 'metrics', 'groupBy', ...USAGE_DIMENSIONS, 'limit', 'cursor']
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return invalid()
  const from = instant(raw.from)
  const to = instant(raw.to)
  const granularity = raw.granularity === undefined ? 'window' : text(raw.granularity, 10)
  if (!USAGE_GRANULARITIES.includes(granularity as UsageGranularity)) return invalid()
  const duration = Date.parse(to) - Date.parse(from)
  if (duration <= 0 || Date.parse(to) > now || duration > (granularity === 'hour' ? 7 : 90) * 86_400_000)
    return invalid()
  const organizationId = raw.organizationId === undefined ? undefined : text(raw.organizationId, 36).toLowerCase()
  if (organizationId !== undefined && !isUUID(organizationId)) return invalid()
  const regionId = identifier(raw.regionId)
  const boxId = identifier(raw.boxId)
  const limit = raw.limit === undefined ? 50 : Number(text(raw.limit, 3))
  if (
    (raw.limit !== undefined && !/^\d+$/.test(raw.limit as string)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    return invalid()
  return {
    query: {
      from,
      to,
      granularity: granularity as UsageGranularity,
      metrics: selection(raw.metrics, USAGE_METRICS, ['computeVcpuSeconds', 'storageByteSeconds']),
      groupBy: selection(raw.groupBy, USAGE_DIMENSIONS, ['organizationId'], 2),
      ...(organizationId === undefined ? {} : { organizationId }),
      ...(regionId === undefined ? {} : { regionId }),
      ...(boxId === undefined ? {} : { boxId }),
    },
    limit,
    ...(raw.cursor === undefined ? {} : { cursor: text(raw.cursor, 2048) }),
  }
}

export const parseUsageOwner = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : invalid()
}

export const usageCursor = (queryId: string, offset: number): string =>
  Buffer.from(JSON.stringify([queryId, offset])).toString('base64url')

export const usageCursorValue = (cursor: string): { queryId: string; offset: number } => {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return invalid()
    const decoded = Buffer.from(cursor, 'base64url')
    if (decoded.toString('base64url') !== cursor) return invalid()
    const value = JSON.parse(decoded.toString('utf8'))
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== 'string' ||
      !isUUID(value[0], '4') ||
      !Number.isInteger(value[1]) ||
      value[1] < 1 ||
      value[1] >= USAGE_MAX_ITEMS
    )
      return invalid()
    return { queryId: value[0], offset: value[1] }
  } catch {
    return invalid()
  }
}
