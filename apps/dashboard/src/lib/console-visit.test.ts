// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  sessionStorage.clear()
})

it('preserves a visit across same-origin documents and starts a fresh visit on direct entry', async () => {
  const referrer = vi.spyOn(document, 'referrer', 'get')
  referrer.mockReturnValue('https://new-source.example/article')
  vi.resetModules()
  const first = (await import('./console-visit')).currentVisit()
  expect(first?.referring_domain).toBe('new-source.example')
  referrer.mockReturnValue(location.origin + '/dashboard/boxes')
  vi.resetModules()
  expect((await import('./console-visit')).currentVisit()).toEqual(first)
  referrer.mockReturnValue('')
  vi.resetModules()
  const direct = (await import('./console-visit')).currentVisit()
  expect(direct?.referring_domain).toBe('direct/unknown')
  expect(direct?.visit_id).not.toBe(first?.visit_id)
})

it('keeps attribution optional if a visit ID cannot be generated', async () => {
  vi.resetModules()
  vi.doMock('uuid', async (original) => ({
    ...(await original<typeof import('uuid')>()),
    v4: () => {
      throw new Error('Randomness unavailable')
    },
  }))
  try {
    const { currentVisit, restoreVisit } = await import('./console-visit')
    expect(currentVisit()).toBeUndefined()
    expect(() => restoreVisit()).not.toThrow()
  } finally {
    vi.doUnmock('uuid')
    vi.resetModules()
  }
})
