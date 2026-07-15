import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumeJustLoggedOut, markJustLoggedOut } from './auth-session'

// Minimal in-memory Storage so the test exercises the real set/get/remove
// branching of auth-session against an actual sessionStorage-shaped object.
function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k, v) => {
      store.set(k, String(v))
    },
    removeItem: (k) => {
      store.delete(k)
    },
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

describe('auth-session logout flag', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('consumes a marked logout exactly once', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    markJustLoggedOut()
    expect(consumeJustLoggedOut()).toBe(true) // first read sees the mark
    expect(consumeJustLoggedOut()).toBe(false) // and clears it, so the next read is false
  })

  it('returns false when no logout was marked', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    expect(consumeJustLoggedOut()).toBe(false)
  })

  it('degrades to false (and does not throw) when sessionStorage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('sessionStorage unavailable')
      },
      setItem: () => {
        throw new Error('sessionStorage unavailable')
      },
      removeItem: () => {
        throw new Error('sessionStorage unavailable')
      },
    } as unknown as Storage)
    expect(() => markJustLoggedOut()).not.toThrow()
    expect(consumeJustLoggedOut()).toBe(false)
  })
})
