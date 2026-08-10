/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash } from 'node:crypto'

/**
 * Wire format version. Part of every event key, so bumping it deliberately
 * re-identifies every event rather than silently re-pricing old ones.
 */
export const USAGE_EXPORT_SCHEMA_VERSION = 1

/**
 * Quantities are allocation counts (vCPU, GiB), never money. This ceiling is a
 * boundary check, not a product limit: a conservative round number below 2^53,
 * where a double stops representing every integer exactly and the encoding
 * below would no longer round-trip the value it was given.
 */
const MAX_QUANTITY = 1e15

/** Digits kept when encoding a quantity. Trailing zeros are stripped. */
const QUANTITY_DECIMALS = 12

/**
 * A closed usage period, in the shape both `BoxUsagePeriod` (once its `endAt`
 * is known) and `BoxUsagePeriodArchive` already have.
 *
 * `endAt` is non-nullable on purpose: only a finalized period has an identity,
 * and requiring the caller to narrow it means an open period cannot reach the
 * exporter by accident.
 */
export interface FinalizedUsagePeriod {
  organizationId: string
  boxId: string
  region: string
  startAt: Date
  endAt: Date
  cpu: number
  gpu: number
  mem: number
  disk: number
}

/**
 * One exported usage fact, exactly as it crosses the wire and exactly as it is
 * stored in the outbox. Self-describing: `schemaVersion` travels with the event
 * rather than on the batch, so a stored payload can always be read back without
 * consulting the row that held it.
 */
export interface UsageEventDto {
  schemaVersion: number
  eventKey: string
  organizationId: string
  boxId: string
  region: string
  startAt: string
  endAt: string
  cpu: string
  gpu: string
  mem: string
  disk: string
}

/**
 * Source data that cannot become an event. Raised only for malformed usage —
 * never for programming or database faults, which must keep failing as
 * themselves.
 */
export class InvalidUsagePeriodError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidUsagePeriodError'
  }
}

/**
 * JSON with recursively sorted object keys.
 *
 * The event key is hashed from this, so a harmless property-order change in a
 * later refactor must not re-identify events that were already exported.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Canonical decimal encoding for a resource quantity.
 *
 * Never `String(value)`: that yields exponent notation for small magnitudes
 * ("1e-7"), and two spellings of one quantity would be two event identities for
 * one usage fact — which is how the same period gets billed twice.
 *
 * Exported so other usage-quantity encodings (e.g. the open-allocation
 * snapshot) share this exact rule rather than growing their own.
 */
export function quantityString(value: number, field: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidUsagePeriodError(`${field} must be a finite number`)
  }
  if (value < 0) {
    throw new InvalidUsagePeriodError(`${field} must not be negative`)
  }
  if (value > MAX_QUANTITY) {
    throw new InvalidUsagePeriodError(`${field} exceeds the maximum encodable quantity`)
  }
  const fixed = value.toFixed(QUANTITY_DECIMALS)
  const encoded = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
  // Below 1e-12 the encoding rounds to "0", which would both drop the usage and
  // hand the period the same identity as a genuinely zero one. Refuse rather
  // than export a quantity that is not the quantity it was given.
  if (value > 0 && Number(encoded) === 0) {
    throw new InvalidUsagePeriodError(`${field} is too small to encode without rounding it away`)
  }
  return encoded
}

export function timestampString(value: Date, field: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvalidUsagePeriodError(`${field} must be a valid timestamp`)
  }
  return value.toISOString()
}

export function identityString(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvalidUsagePeriodError(`${field} must be a non-empty string`)
  }
  return value
}

/**
 * The stable identity of one usage fact.
 *
 * Derived from the interval and what ran in it, never from a row id: archival
 * assigns the archive row a fresh UUID (`BoxUsagePeriodArchive.fromUsagePeriod`
 * does not copy `id`), so the live row and its archived copy share no id and
 * only the interval identifies the usage they both describe.
 */
export function usageEventKey(period: FinalizedUsagePeriod): string {
  return sha256(canonicalJson(keyFields(period)))
}

/** Builds the exact bytes stored in the outbox and sent to Commerce. */
export function toUsageEventDto(period: FinalizedUsagePeriod): UsageEventDto {
  return {
    ...keyFields(period),
    eventKey: usageEventKey(period),
  }
}

/**
 * Identity for a period whose data is malformed. Keyed by the source row so two
 * equally broken rows cannot mask one another; such a row is only ever recorded
 * as blocked, never delivered.
 */
export function blockedUsageEventKey(sourceId: string): string {
  return sha256(
    canonicalJson({
      schemaVersion: USAGE_EXPORT_SCHEMA_VERSION,
      blockedSourceId: String(sourceId),
    }),
  )
}

/**
 * Diagnostic form of a period that failed validation. Values are stringified
 * rather than serialized as JSON numbers because the reason a row is here is
 * usually a value JSON cannot represent — `NaN` becomes `null` otherwise, which
 * hides the very thing the row was kept for.
 */
export function usagePeriodSnapshot(period: {
  id?: string
  organizationId?: unknown
  boxId?: unknown
  region?: unknown
  startAt?: unknown
  endAt?: unknown
  cpu?: unknown
  gpu?: unknown
  mem?: unknown
  disk?: unknown
}): Record<string, string> {
  const stringify = (value: unknown): string =>
    value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : String(value)

  return {
    sourceId: String(period.id),
    organizationId: stringify(period.organizationId),
    boxId: stringify(period.boxId),
    region: stringify(period.region),
    startAt: stringify(period.startAt),
    endAt: stringify(period.endAt),
    cpu: stringify(period.cpu),
    gpu: stringify(period.gpu),
    mem: stringify(period.mem),
    disk: stringify(period.disk),
  }
}

function keyFields(period: FinalizedUsagePeriod): Omit<UsageEventDto, 'eventKey'> {
  const startAt = timestampString(period.startAt, 'startAt')
  const endAt = timestampString(period.endAt, 'endAt')
  if (period.endAt < period.startAt) {
    throw new InvalidUsagePeriodError('a finalized usage period must not end before it starts')
  }

  return {
    schemaVersion: USAGE_EXPORT_SCHEMA_VERSION,
    organizationId: identityString(period.organizationId, 'organizationId'),
    boxId: identityString(period.boxId, 'boxId'),
    region: identityString(period.region, 'region'),
    startAt,
    endAt,
    cpu: quantityString(period.cpu, 'cpu'),
    gpu: quantityString(period.gpu, 'gpu'),
    mem: quantityString(period.mem, 'mem'),
    disk: quantityString(period.disk, 'disk'),
  }
}
