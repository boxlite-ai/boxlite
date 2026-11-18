import { BadRequestException } from '@nestjs/common'
import type { OutboundPrecondition } from '../box/services/outbound-policy.coordinator'

/** Parse the entire HTTP entity-tag list; only strong tags can match a persisted Box revision. */
export function outboundPrecondition(header: string | undefined): OutboundPrecondition | undefined {
  if (header === undefined) return undefined
  if (header.length > 8192) throw new BadRequestException('Invalid If-Match header')
  const value = header.replace(/^[ \t]+|[ \t]+$/g, '')
  if (value === '*') return () => true
  const tags: string[] = []
  let index = 0
  for (;;) {
    while (value[index] === ' ' || value[index] === '\t') index++
    if (index === value.length) break
    if (value[index] === ',') {
      index++
      continue
    }
    const weak = value.startsWith('W/', index)
    if (weak) index += 2
    if (value[index++] !== '"') throw new BadRequestException('Invalid If-Match header')
    const start = index
    while (index < value.length && value[index] !== '"') {
      const code = value.charCodeAt(index++)
      if (code !== 0x21 && !(code >= 0x23 && code <= 0x7e) && !(code >= 0x80 && code <= 0xff)) {
        throw new BadRequestException('Invalid If-Match header')
      }
    }
    if (value[index] !== '"') throw new BadRequestException('Invalid If-Match header')
    if (!weak) tags.push(value.slice(start, index))
    index++
    while (value[index] === ' ' || value[index] === '\t') index++
    if (index === value.length) break
    if (value[index++] !== ',') throw new BadRequestException('Invalid If-Match header')
  }
  return (revision) => tags.includes(revision)
}
