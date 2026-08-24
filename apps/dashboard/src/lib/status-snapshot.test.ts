import { describe, expect, it } from 'vitest'

import { parseStatusSnapshot, StaleStatusSnapshotError } from './status-snapshot'

const generatedAt = '2026-08-24T04:00:00.000Z'

function snapshot() {
  return {
    schemaVersion: 1,
    generatedAt,
    regions: [
      {
        id: 'ap-southeast-1',
        name: 'Asia Pacific (Singapore)',
        status: 'operational',
        services: [{ id: 'api', name: 'API', status: 'operational' }],
      },
    ],
  }
}

describe('parseStatusSnapshot', () => {
  it('accepts a fresh version 1 snapshot', () => {
    expect(parseStatusSnapshot(snapshot(), Date.parse(generatedAt) + 60_000)).toMatchObject({
      schemaVersion: 1,
      regions: [{ id: 'ap-southeast-1' }],
    })
  })

  it('rejects a stale snapshot instead of leaving an operational status visible', () => {
    expect(() => parseStatusSnapshot(snapshot(), Date.parse(generatedAt) + 5 * 60_000 + 1)).toThrow(
      StaleStatusSnapshotError,
    )
  })

  it('rejects unknown statuses at the public-data boundary', () => {
    const input = snapshot()
    input.regions[0].services[0].status = 'healthy'

    expect(() => parseStatusSnapshot(input, Date.parse(generatedAt))).toThrow()
  })
})
