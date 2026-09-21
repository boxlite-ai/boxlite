/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Restores Web Storage to the jsdom tests.
 *
 * Node ships its own experimental `localStorage`/`sessionStorage` globals that
 * resolve to `undefined` unless the process was started with
 * `--localstorage-file`. Vitest's jsdom environment makes `window` and
 * `document.defaultView` the very same object as `globalThis`, so Node's
 * globals shadow jsdom's storage everywhere and any test touching either one
 * dies on `Cannot read properties of undefined`.
 *
 * This setup runs for every spec, not only the jsdom ones: the target's
 * default environment is `node`, which has no Web Storage of its own either,
 * and a spec opts into jsdom through its own docblock.
 *
 * Installing an in-memory Storage is not a downgrade: jsdom's own storage is
 * in-memory too, and it is what a test that clears storage between cases
 * expects.
 */
function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, String(value))
    },
    removeItem: (key) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (globalThis[name]) {
    continue
  }
  Object.defineProperty(globalThis, name, { value: memoryStorage(), configurable: true, writable: true })
}
