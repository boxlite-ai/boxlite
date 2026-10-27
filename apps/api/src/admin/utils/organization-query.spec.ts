import { BadRequestException } from '@nestjs/common'
import {
  parseOrganizationSections,
  parseRegistrationQuery,
  registrationAfter,
  registrationCursor,
} from './organization-query'

describe('organization queries', () => {
  it.each([
    () => parseRegistrationQuery({ unknown: 'value' }),
    () => registrationAfter({ limit: 50, cursor: 'not-a-cursor!' }),
    () => parseOrganizationSections({ memberCursor: 'not-a-cursor!' }),
    () => parseOrganizationSections({ boxCursor: 'not-a-cursor!' }),
  ])('identifies invalid organization queries (%#)', (read) => {
    let response: unknown
    try {
      read()
    } catch (error) {
      response = (error as BadRequestException).getResponse()
    }
    expect(response).toEqual({
      statusCode: 400,
      code: 'invalid_organization_query',
      message: 'Invalid organization query',
    })
  })

  it('normalizes timezone offsets and binds a cursor to its filters while allowing page size changes', () => {
    const query = parseRegistrationQuery({ q: ' Acme ', createdFrom: '2026-10-01T08:00:00+08:00', limit: '2' })
    expect(query.createdFrom).toBe('2026-10-01T00:00:00.000Z')
    const row = { id: '00000000-0000-4000-8000-000000000001', createdAt: new Date('2026-10-01T00:00:00.123Z') }
    const cursor = registrationCursor(query, row)
    expect(registrationAfter({ ...query, cursor, limit: 20 })).toEqual({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
    })
    for (const change of [{ query: 'Other' }, { createdFrom: undefined }, { createdTo: '2026-10-02T00:00:00.000Z' }])
      expect(() => registrationAfter({ ...query, ...change, cursor })).toThrow(BadRequestException)
    expect(() => registrationAfter({ ...query, cursor: 'bad-cursor' })).toThrow(BadRequestException)
  })

  it.each([
    { createdFrom: '2026-02-30T00:00:00Z' },
    { createdFrom: '0000-01-01T00:00:00Z' },
    { createdFrom: '2026-10-01T00:00:00.1234Z' },
    { createdTo: '2026-10-01' },
    { createdFrom: '2026-10-02T00:00:00Z', createdTo: '2026-10-01T00:00:00Z' },
    { createdFrom: '2026-10-01T00:00:00Z', createdTo: '2026-10-01T00:00:00Z' },
    { limit: '201' },
    { limit: '0' },
    { limit: '1.1' },
    { q: 'a' },
    { cursor: '' },
    { createdFrom: ['2026-10-01T00:00:00Z'] },
    { include: 'usage' },
  ])('rejects invalid registration query %j', (query) => {
    expect(() => parseRegistrationQuery(query)).toThrow(BadRequestException)
  })

  it('requires explicit usage selection and rejects unrelated partitions', () => {
    expect(parseOrganizationSections({})).toMatchObject({
      includeUsage: false,
      includeActivation: false,
      memberLimit: 50,
      boxLimit: 50,
    })
    expect(parseOrganizationSections({ include: 'usage', sectionLimit: '2' })).toMatchObject({
      includeUsage: true,
      includeActivation: false,
      memberLimit: 2,
    })
    for (const include of ['usage,activation', 'activation,usage'])
      expect(parseOrganizationSections({ include })).toMatchObject({ includeUsage: true, includeActivation: true })
    expect(parseOrganizationSections({ include: 'activation' })).toMatchObject({
      includeUsage: false,
      includeActivation: true,
    })
    for (const query of [
      { include: 'billing' },
      { include: ['usage'] },
      { include: 'usage,usage' },
      { include: 'activation,' },
      { unknown: 'value' },
      { memberCursor: '' },
    ])
      expect(() => parseOrganizationSections(query)).toThrow(BadRequestException)
  })
})
