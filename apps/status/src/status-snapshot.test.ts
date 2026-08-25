import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchStatusSnapshot,
  isStatusSnapshotFresh,
  parseStatusSnapshot,
  STATUS_FETCH_TIMEOUT_MS,
} from './status-snapshot'

const NOW = Date.parse('2026-08-25T00:04:00.000Z')

function snapshot(generatedAt = '2026-08-25T00:00:00.000Z') {
  return {
    schemaVersion: 1,
    generatedAt,
    regions: [
      {
        id: 'ap-southeast-1',
        status: 'operational',
        services: [
          { id: 'api', name: 'API', status: 'operational' },
          { id: 'runner', name: 'Runner', status: 'operational' },
          { id: 'proxy', name: 'Proxy', status: 'operational' },
        ],
      },
    ],
  }
}

describe('public status snapshot boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('accepts only the three public services', () => {
    expect(parseStatusSnapshot(snapshot(), NOW).regions[0].services.map((service) => service.id)).toEqual([
      'api',
      'runner',
      'proxy',
    ])
  })

  it('rejects duplicate or missing public services', () => {
    const malformed = snapshot()
    malformed.regions[0].services[2] = { id: 'api', name: 'API', status: 'operational' }
    expect(() => parseStatusSnapshot(malformed, NOW)).toThrow()
  })

  it('rejects duplicate region ids', () => {
    const malformed = snapshot()
    malformed.regions.push(structuredClone(malformed.regions[0]))
    expect(() => parseStatusSnapshot(malformed, NOW)).toThrow(/Duplicate region id/)
  })

  it('fails closed after five minutes and for a timestamp over one minute in the future', () => {
    const fresh = parseStatusSnapshot(snapshot(), NOW)
    expect(isStatusSnapshotFresh(fresh, Date.parse('2026-08-25T00:05:00.000Z'))).toBe(true)
    expect(isStatusSnapshotFresh(fresh, Date.parse('2026-08-25T00:05:00.001Z'))).toBe(false)
    expect(() => parseStatusSnapshot(snapshot('2026-08-25T00:05:00.001Z'), NOW)).toThrow()
  })

  it('aborts a snapshot request that exceeds the bounded fetch timeout', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true })
        })
      }),
    )

    const request = fetchStatusSnapshot('/public-status.json')
    const rejection = expect(request).rejects.toThrow('Public status request timed out')
    await vi.advanceTimersByTimeAsync(STATUS_FETCH_TIMEOUT_MS)

    await rejection
    expect(requestSignal?.aborted).toBe(true)
  })
})
