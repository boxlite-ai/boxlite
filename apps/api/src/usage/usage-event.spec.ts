/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxUsagePeriodArchive } from './entities/box-usage-period-archive.entity'
import { BoxUsagePeriod } from './entities/box-usage-period.entity'
import {
  blockedUsageEventKey,
  canonicalJson,
  FinalizedUsagePeriod,
  InvalidUsagePeriodError,
  toUsageEventDto,
  usageEventKey,
  usagePeriodSnapshot,
} from './usage-event'

const period = (overrides: Partial<FinalizedUsagePeriod> = {}): FinalizedUsagePeriod => ({
  organizationId: 'org-1',
  boxId: 'box-1',
  region: 'us',
  startAt: new Date('2026-08-01T00:00:00.000Z'),
  endAt: new Date('2026-08-01T01:00:00.000Z'),
  cpu: 2,
  gpu: 0,
  mem: 4,
  disk: 10,
  ...overrides,
})

const livePeriod = (overrides: Partial<BoxUsagePeriod> = {}): BoxUsagePeriod =>
  Object.assign(new BoxUsagePeriod(), period(), overrides)

// Pinned by hand from a single run, not recomputed here: a test that derives its
// own expectation would pass no matter how the derivation changed, and the whole
// point of this key is that it never changes for usage already exported.
const GOLDEN_KEY = '168c53bcd9790ed6c8a73a3845353e082d1099839ea13f3a1714d83382e26668'

describe('usageEventKey', () => {
  it('produces the pinned key for a known period', () => {
    expect(usageEventKey(period())).toBe(GOLDEN_KEY)
  })

  it('does not depend on property order', () => {
    const reordered: FinalizedUsagePeriod = {
      disk: 10,
      mem: 4,
      gpu: 0,
      cpu: 2,
      endAt: new Date('2026-08-01T01:00:00.000Z'),
      startAt: new Date('2026-08-01T00:00:00.000Z'),
      region: 'us',
      boxId: 'box-1',
      organizationId: 'org-1',
    }

    expect(usageEventKey(reordered)).toBe(GOLDEN_KEY)
  })

  it.each<[string, Partial<FinalizedUsagePeriod>]>([
    ['organizationId', { organizationId: 'org-2' }],
    ['boxId', { boxId: 'box-2' }],
    ['region', { region: 'eu' }],
    ['startAt', { startAt: new Date('2026-08-01T00:00:00.001Z') }],
    ['endAt', { endAt: new Date('2026-08-01T01:00:00.001Z') }],
    ['cpu', { cpu: 4 }],
    ['gpu', { gpu: 1 }],
    ['mem', { mem: 8 }],
    ['disk', { disk: 20 }],
  ])('changes when %s changes', (_field, override) => {
    expect(usageEventKey(period(override))).not.toBe(GOLDEN_KEY)
  })

  // The live row and its archived copy share no id — fromUsagePeriod does not
  // copy it — so identity has to come from the interval. If these two ever
  // disagree, the live enqueue and the archive backfill would each export the
  // same usage under a different key and the customer would be billed twice.
  it('agrees between a live period and its archived copy', () => {
    const live = livePeriod()
    live.id = 'live-row-id'
    const archived = BoxUsagePeriodArchive.fromUsagePeriod(live)
    archived.id = 'archive-row-id'

    expect(usageEventKey(archived)).toBe(usageEventKey(live as FinalizedUsagePeriod))
  })
})

describe('toUsageEventDto', () => {
  it('carries the key alongside the canonical field encoding', () => {
    expect(toUsageEventDto(period())).toEqual({
      schemaVersion: 1,
      eventKey: GOLDEN_KEY,
      organizationId: 'org-1',
      boxId: 'box-1',
      region: 'us',
      startAt: '2026-08-01T00:00:00.000Z',
      endAt: '2026-08-01T01:00:00.000Z',
      cpu: '2',
      gpu: '0',
      mem: '4',
      disk: '10',
    })
  })

  // String(1e-7) is "1e-7". Two spellings of one quantity would be two
  // identities for one usage fact, so the encoding must never reach exponent
  // notation.
  it.each<[number, string]>([
    [0, '0'],
    [2, '2'],
    [0.5, '0.5'],
    [0.0000001, '0.0000001'],
    [1.25, '1.25'],
  ])('encodes quantity %p as %p', (cpu, expected) => {
    expect(toUsageEventDto(period({ cpu })).cpu).toBe(expected)
  })
})

// The event key is a hash of this string, so any change in what it emits
// re-identifies every event ever exported.
describe('canonicalJson', () => {
  it('sorts object keys regardless of insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('sorts nested objects too', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}')
  })

  // Arrays are ordered data, not a bag of keys: reordering them must change the
  // result, or two different sequences would share one identity.
  it('preserves array order', () => {
    expect(canonicalJson([1, 2])).toBe('[1,2]')
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]))
  })

  it('escapes keys and values through JSON', () => {
    expect(canonicalJson({ 'a"b': 'c\nd' })).toBe('{"a\\"b":"c\\nd"}')
  })
})

describe('blockedUsageEventKey', () => {
  // Two equally malformed rows must not collapse into one, or repairing the
  // first would hide that the second was ever rejected.
  it('separates malformed rows by source id', () => {
    expect(blockedUsageEventKey('row-a')).not.toBe(blockedUsageEventKey('row-b'))
  })

  it('is stable for one source id', () => {
    expect(blockedUsageEventKey('row-a')).toBe(blockedUsageEventKey('row-a'))
  })

  it('never collides with a well-formed event key', () => {
    expect(blockedUsageEventKey('row-a')).not.toBe(usageEventKey(period()))
  })
})

describe('usagePeriodSnapshot', () => {
  // The reason a row lands here is usually a value JSON cannot carry, so the
  // diagnostic form has to stringify rather than serialize.
  it('records values JSON would turn into null', () => {
    const snapshot = usagePeriodSnapshot({
      id: 'row-1',
      organizationId: 'org-1',
      boxId: 'box-1',
      region: 'us',
      startAt: new Date('2026-08-01T00:00:00.000Z'),
      endAt: new Date('nonsense'),
      cpu: Number.NaN,
      gpu: Number.POSITIVE_INFINITY,
      mem: 4,
      disk: 10,
    })

    expect(snapshot).toEqual({
      sourceId: 'row-1',
      organizationId: 'org-1',
      boxId: 'box-1',
      region: 'us',
      startAt: '2026-08-01T00:00:00.000Z',
      endAt: 'Invalid Date',
      cpu: 'NaN',
      gpu: 'Infinity',
      mem: '4',
      disk: '10',
    })
    expect(JSON.parse(JSON.stringify(snapshot)).cpu).toBe('NaN')
  })
})

describe('usage period validation', () => {
  it.each<[string, Partial<FinalizedUsagePeriod>]>([
    ['a NaN quantity', { cpu: Number.NaN }],
    ['an infinite quantity', { mem: Number.POSITIVE_INFINITY }],
    ['a negative quantity', { disk: -1 }],
    ['a blank organizationId', { organizationId: '  ' }],
    ['a blank boxId', { boxId: '' }],
    ['an invalid startAt', { startAt: new Date('nonsense') }],
    ['an end before the start', { endAt: new Date('2026-07-01T00:00:00.000Z') }],
    ['a quantity past the encodable ceiling', { mem: 1e16 }],
  ])('rejects %s', (_case, override) => {
    expect(() => usageEventKey(period(override))).toThrow(InvalidUsagePeriodError)
  })

  it('accepts a quantity at the ceiling', () => {
    expect(() => usageEventKey(period({ mem: 1e15 }))).not.toThrow()
  })
})
