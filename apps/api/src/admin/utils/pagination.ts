import { BadRequestException } from '@nestjs/common'

export const cursorFor = (value: string): string => Buffer.from(value).toString('base64url')

export const cursorValue = (value?: string): string | null => {
  if (!value) return null
  const decoded = Buffer.from(value, 'base64url').toString('utf8')
  if (!decoded || cursorFor(decoded) !== value) throw new BadRequestException('Invalid cursor')
  return decoded
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const uuidCursorValue = (value?: string): string | null => {
  const decoded = cursorValue(value)
  if (decoded !== null && !UUID.test(decoded)) throw new BadRequestException('Invalid cursor')
  return decoded
}

/**
 * Key text for a page ordered newest-first. A page ordered by a random v4 id can key on
 * that id alone, but one ordered by an instant cannot: the cursor has to carry both sort
 * columns or the tie-break column drops rows sharing a timestamp.
 *
 * A Date resolves to the millisecond, so the query this keys into has to sort by the
 * millisecond too — a cursor cannot seek to a boundary it is unable to name.
 */
export const timeCursorKey = (createdAt: Date, id: string): string => `${createdAt.toISOString()}|${id}`

export const timeCursorValue = (value?: string): { createdAt: string; id: string } | null => {
  const decoded = cursorValue(value)
  if (decoded === null) return null
  const separator = decoded.indexOf('|')
  const createdAt = decoded.slice(0, separator)
  const id = decoded.slice(separator + 1)
  // The round trip is the check, the same way cursorFor guards the encoding above: this
  // half was minted by timeCursorKey, so anything toISOString() would not have written is
  // not a cursor this API handed out. Date.parse alone reads '2026' as a whole year and
  // passes it to a bound parameter Postgres then rejects, turning a 400 into a 500.
  const instant = new Date(createdAt)
  if (separator < 0 || Number.isNaN(instant.getTime()) || instant.toISOString() !== createdAt || !UUID.test(id)) {
    throw new BadRequestException('Invalid cursor')
  }
  return { createdAt, id }
}

export const pageOf = <T>(rows: T[], limit: number, id: (row: T) => string) => {
  const items = rows.slice(0, limit)
  return {
    items,
    nextCursor: rows.length > limit && items.length ? cursorFor(id(items[items.length - 1])) : null,
    limit,
  }
}
