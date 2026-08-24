/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InvalidUsagePeriodError } from './usage-event'
import { OpenAllocation, toOpenAllocationDto } from './open-allocation'

const allocation = (overrides: Partial<OpenAllocation> = {}): OpenAllocation => ({
  organizationId: 'org-1',
  boxId: 'box-1',
  region: 'us',
  startAt: new Date('2026-08-01T00:00:00.000Z'),
  cpu: 2,
  gpu: 0,
  mem: 4,
  disk: 10,
  ...overrides,
})

describe('toOpenAllocationDto', () => {
  it('encodes an open allocation with no end and no event key', () => {
    expect(toOpenAllocationDto(allocation())).toEqual({
      organizationId: 'org-1',
      boxId: 'box-1',
      region: 'us',
      startAt: '2026-08-01T00:00:00.000Z',
      cpu: '2',
      gpu: '0',
      mem: '4',
      disk: '10',
    })
  })

  // String(1e-7) is "1e-7" — the same underflow risk toUsageEventDto guards
  // against applies here, since both share the same quantityString encoder.
  it.each<[number, string]>([
    [0, '0'],
    [2, '2'],
    [0.5, '0.5'],
    [0.0000001, '0.0000001'],
    [1.25, '1.25'],
  ])('encodes quantity %p as %p', (cpu, expected) => {
    expect(toOpenAllocationDto(allocation({ cpu })).cpu).toBe(expected)
  })

  it.each<[string, Partial<OpenAllocation>]>([
    ['a NaN quantity', { cpu: Number.NaN }],
    ['an infinite quantity', { mem: Number.POSITIVE_INFINITY }],
    ['a negative quantity', { disk: -1 }],
    ['a blank organizationId', { organizationId: '  ' }],
    ['a blank boxId', { boxId: '' }],
    ['a region longer than Commerce accepts', { region: 'r'.repeat(201) }],
    ['an invalid startAt', { startAt: new Date('nonsense') }],
    ['a quantity past the encodable ceiling', { mem: 1e16 }],
    ['a quantity that rounds away to zero', { cpu: 1e-13 }],
  ])('rejects %s', (_case, override) => {
    expect(() => toOpenAllocationDto(allocation(override))).toThrow(InvalidUsagePeriodError)
  })

  // Zero is a real quantity — a box holding disk but with cpu momentarily
  // idle-billed at 0 — so the underflow guard must not swallow it.
  it('still encodes a genuine zero', () => {
    expect(toOpenAllocationDto(allocation({ cpu: 0 })).cpu).toBe('0')
  })
})
