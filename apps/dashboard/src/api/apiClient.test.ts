// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AxiosRequestConfig } from 'axios'

const config = { apiUrl: 'http://api.test/api' } as never

// Fresh module per test so the module-level `isHandlingUnauthorized` guard
// doesn't leak across cases. A custom axios adapter makes every request resolve
// to `status` with an empty body, so the response interceptor sees the 401.
async function makeClient(onUnauthorized: () => Promise<void> | void, status = 401) {
  vi.resetModules()
  const axios = (await import('axios')).default
  // A custom adapter must settle the response itself (axios doesn't re-apply
  // validateStatus to a custom adapter's return), so reject non-2xx with an
  // AxiosError carrying `.response`, exactly like the built-in adapters.
  axios.defaults.adapter = (async (cfg: unknown) => {
    const response = { data: {}, status, statusText: '', headers: {}, config: cfg }
    if (status >= 200 && status < 300) return response
    const err = new Error(`Request failed with status code ${status}`) as Error & Record<string, unknown>
    err.response = response
    err.config = cfg
    err.isAxiosError = true
    throw err
  }) as never
  const { ApiClient } = await import('./apiClient')
  return new ApiClient(config, 'tok', onUnauthorized)
}

describe('ApiClient 401 -> bounded re-login recovery', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('first 401 triggers onUnauthorized once and suspends the caller (no error flash)', async () => {
    const onUnauthorized = vi.fn(() => Promise.resolve())
    const api = await makeClient(onUnauthorized)
    let settled = false
    void api.organizationsApi.listOrganizations().then(
      () => (settled = true),
      () => (settled = true),
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    // Never-settling while the redirect navigates the page away — not an error.
    expect(settled).toBe(false)
  })

  it('a 401 that persists after a re-auth attempt rejects instead of bouncing forever', async () => {
    window.sessionStorage.setItem('boxlite.reauth-attempted', '1')
    const onUnauthorized = vi.fn(() => Promise.resolve())
    const api = await makeClient(onUnauthorized)
    await expect(api.organizationsApi.listOrganizations()).rejects.toBeTruthy()
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('a rejecting onUnauthorized resets state and surfaces an error (no hang)', async () => {
    const onUnauthorized = vi.fn(() => Promise.reject(new Error('redirect start failed')))
    const api = await makeClient(onUnauthorized)
    await expect(api.organizationsApi.listOrganizations()).rejects.toBeTruthy()
    // Marker cleared so a later genuine 401 still gets its one recovery attempt.
    expect(window.sessionStorage.getItem('boxlite.reauth-attempted')).toBeNull()
  })
})

describe('ApiClient usage requests', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends the selected organization header for usage reads', async () => {
    vi.resetModules()
    const axios = (await import('axios')).default
    const requests: AxiosRequestConfig[] = []
    axios.defaults.adapter = (async (cfg: AxiosRequestConfig) => {
      requests.push(cfg)
      return { data: cfg.url?.endsWith('/periods') ? [] : {}, status: 200, statusText: '', headers: {}, config: cfg }
    }) as never

    const { ApiClient } = await import('./apiClient')
    const api = new ApiClient(config, 'tok')
    await api.getBoxUsage('box-1', 'org-1')
    await api.getBoxUsagePeriods('box-1', 'org-1')

    expect(requests.map((request) => request.headers?.['X-BoxLite-Organization-ID'])).toEqual(['org-1', 'org-1'])
  })
})
