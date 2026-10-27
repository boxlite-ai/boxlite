import { BadRequestException } from '@nestjs/common'
import { isISO8601 } from 'class-validator'
import { createHash } from 'crypto'
import { cursorFor, cursorValue, timeCursorKey, timeCursorValue } from './pagination'

export type RegistrationQuery = {
  query?: string
  cursor?: string
  createdFrom?: string
  createdTo?: string
  limit: number
}

export const organizationQueryError = () =>
  new BadRequestException({
    statusCode: 400,
    code: 'invalid_organization_query',
    message: 'Invalid organization query',
  })
const invalid = (): never => {
  throw organizationQueryError()
}
const text = (value: unknown, max: number): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > max) return invalid()
  return value.trim()
}
const limit = (value: unknown): number => {
  if (value === undefined) return 50
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return invalid()
  const parsed = Number(value)
  return parsed >= 1 && parsed <= 200 ? parsed : invalid()
}
const instant = (value: unknown): string | undefined => {
  const raw = text(value, 35)
  if (raw === undefined) return undefined
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(raw) ||
    !isISO8601(raw, { strict: true, strictSeparator: true })
  )
    return invalid()
  const date = new Date(raw)
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return invalid()
  return date.toISOString()
}
const allow = (query: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(query).some((key) => !keys.includes(key))) invalid()
}

export const parseRegistrationQuery = (query: Record<string, unknown>): RegistrationQuery => {
  allow(query, ['q', 'cursor', 'limit', 'createdFrom', 'createdTo'])
  const search = text(query.q, 200)
  const createdFrom = instant(query.createdFrom)
  const createdTo = instant(query.createdTo)
  if ((search && search.length < 2) || (createdFrom && createdTo && createdFrom >= createdTo)) return invalid()
  return { query: search, cursor: text(query.cursor, 2048), limit: limit(query.limit), createdFrom, createdTo }
}

export const parseOrganizationSections = (query: Record<string, unknown>) => {
  allow(query, ['memberCursor', 'boxCursor', 'sectionLimit', 'include'])
  const include = text(query.include, 32)?.split(',') ?? []
  if (include.some((section) => !['usage', 'activation'].includes(section)) || new Set(include).size !== include.length)
    return invalid()
  const sectionLimit = limit(query.sectionLimit)
  const memberCursor = text(query.memberCursor, 2048)
  const boxCursor = text(query.boxCursor, 2048)
  try {
    cursorValue(memberCursor)
    cursorValue(boxCursor)
  } catch {
    return invalid()
  }
  return {
    memberCursor,
    boxCursor,
    memberLimit: sectionLimit,
    boxLimit: sectionLimit,
    includeUsage: include.includes('usage'),
    includeActivation: include.includes('activation'),
  }
}

const filterHash = (query: RegistrationQuery) =>
  createHash('sha256')
    .update(JSON.stringify([query.query ?? null, query.createdFrom ?? null, query.createdTo ?? null]))
    .digest('hex')

export const registrationCursor = (query: RegistrationQuery, row: { id: string; createdAt: Date }): string =>
  cursorFor(JSON.stringify({ v: 1, filter: filterHash(query), after: cursorFor(timeCursorKey(row.createdAt, row.id)) }))

export const registrationAfter = (query: RegistrationQuery) => {
  if (!query.cursor) return null
  try {
    const decoded = cursorValue(query.cursor)
    if (decoded === null) return invalid()
    const value = JSON.parse(decoded)
    if (
      !value ||
      value.v !== 1 ||
      value.filter !== filterHash(query) ||
      typeof value.after !== 'string' ||
      !value.after ||
      Object.keys(value).sort().join(',') !== 'after,filter,v'
    )
      return invalid()
    return timeCursorValue(value.after)
  } catch {
    return invalid()
  }
}
