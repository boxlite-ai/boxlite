// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('ApiClient billing authentication', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the same bounded re-login recovery for a first billing 401', async () => {
    const onUnauthorized = vi.fn(() => Promise.resolve())
    const api = await makeClient(onUnauthorized)
    let settled = false

    void api.billingApi.getOrganizationUsage('org-1').then(
      () => (settled = true),
      () => (settled = true),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
  })

  it('surfaces a billing 401 after re-login instead of redirecting again', async () => {
    window.sessionStorage.setItem('boxlite.reauth-attempted', '1')
    const onUnauthorized = vi.fn(() => Promise.resolve())
    const api = await makeClient(onUnauthorized)

    await expect(api.billingApi.getOrganizationUsage('org-1')).rejects.toThrow(
      'Authentication failed after re-login. Please sign in again.',
    )
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('uses a refreshed access token for billing requests', async () => {
    vi.resetModules()
    const axios = (await import('axios')).default
    let authorization: string | undefined
    axios.defaults.adapter = (async (requestConfig: {
      headers?: { get?: (name: string) => string | undefined; Authorization?: string }
    }) => {
      authorization = requestConfig.headers?.get?.('Authorization') ?? requestConfig.headers?.Authorization
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config: requestConfig }
    }) as never

    const { ApiClient } = await import('./apiClient')
    const api = new ApiClient(
      { apiUrl: 'http://api.test/api', billingApiUrl: 'http://billing.test' } as never,
      'initial-token',
    )

    api.setAccessToken('refreshed-token')
    await api.billingApi.getOrganizationUsage('org-1')

    expect(authorization).toBe('Bearer refreshed-token')
  })

  it('sends the logical operation key and refreshed token for a manual wallet top-up', async () => {
    vi.resetModules()
    const axios = (await import('axios')).default
    const idempotencyKey = '11111111-1111-4111-8111-111111111111'
    let authorization: string | undefined
    let sentIdempotencyKey: string | undefined
    axios.defaults.adapter = (async (requestConfig: {
      headers?: { get?: (name: string) => string | undefined; Authorization?: string }
    }) => {
      authorization = requestConfig.headers?.get?.('Authorization') ?? requestConfig.headers?.Authorization
      sentIdempotencyKey = requestConfig.headers?.get?.('Idempotency-Key')
      return {
        data: { url: 'https://checkout.test' },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: requestConfig,
      }
    }) as never

    const { ApiClient } = await import('./apiClient')
    const api = new ApiClient(
      { apiUrl: 'http://api.test/api', billingApiUrl: 'http://billing.test' } as never,
      'initial-token',
    )

    api.setAccessToken('refreshed-token')
    await api.billingApi.topUpWallet('org-1', 5_000, idempotencyKey)

    expect(sentIdempotencyKey).toBe(idempotencyKey)
    expect(authorization).toBe('Bearer refreshed-token')
  })

  it('sends the logical operation key and refreshed token for coupon redemption', async () => {
    vi.resetModules()
    const axios = (await import('axios')).default
    const idempotencyKey = '22222222-2222-4222-8222-222222222222'
    let authorization: string | undefined
    let sentIdempotencyKey: string | undefined
    axios.defaults.adapter = (async (requestConfig: {
      headers?: { get?: (name: string) => string | undefined; Authorization?: string }
    }) => {
      authorization = requestConfig.headers?.get?.('Authorization') ?? requestConfig.headers?.Authorization
      sentIdempotencyKey = requestConfig.headers?.get?.('Idempotency-Key')
      return { data: { message: 'Coupon redeemed' }, status: 200, statusText: 'OK', headers: {}, config: requestConfig }
    }) as never

    const { ApiClient } = await import('./apiClient')
    const api = new ApiClient(
      { apiUrl: 'http://api.test/api', billingApiUrl: 'http://billing.test' } as never,
      'initial-token',
    )

    api.setAccessToken('refreshed-token')
    await api.billingApi.redeemCoupon('org-1', 'SAVE10', idempotencyKey)

    expect(sentIdempotencyKey).toBe(idempotencyKey)
    expect(authorization).toBe('Bearer refreshed-token')
  })
})
