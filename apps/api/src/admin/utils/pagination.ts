import { BadRequestException } from '@nestjs/common'

export const cursorFor = (value: string): string => Buffer.from(value).toString('base64url')

export const cursorValue = (value?: string): string | null => {
  if (!value) return null
  const decoded = Buffer.from(value, 'base64url').toString('utf8')
  if (!decoded || cursorFor(decoded) !== value) throw new BadRequestException('Invalid cursor')
  return decoded
}

export const uuidCursorValue = (value?: string): string | null => {
  const decoded = cursorValue(value)
  if (decoded !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded)) {
    throw new BadRequestException('Invalid cursor')
  }
  return decoded
}

export const pageOf = <T>(rows: T[], limit: number, id: (row: T) => string) => {
  const items = rows.slice(0, limit)
  return {
    items,
    nextCursor: rows.length > limit && items.length ? cursorFor(id(items[items.length - 1])) : null,
    limit,
  }
}
