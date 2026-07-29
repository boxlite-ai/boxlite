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

type CapturedRequest = {
  url?: string
  baseURL?: string
  authorization?: string
}

function getAuthorizationHeader(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined
  }

  const headerBag = headers as {
    get?: (name: string) => unknown
    Authorization?: unknown
    authorization?: unknown
  }
  const value = headerBag.get?.('Authorization') ?? headerBag.Authorization ?? headerBag.authorization
  return typeof value === 'string' ? value : undefined
}

async function makeTokenRefreshClient(
  requests: CapturedRequest[],
  accessToken = 'stale-token',
  analyticsApiUrl: string | null = 'http://analytics.test',
) {
  vi.resetModules()
  const axios = (await import('axios')).default
  axios.defaults.adapter = (async (request: { url?: string; baseURL?: string; headers?: unknown }) => {
    requests.push({
      url: request.url,
      baseURL: request.baseURL,
      authorization: getAuthorizationHeader(request.headers),
    })
    return { data: {}, status: 200, statusText: '', headers: {}, config: request }
  }) as never
  const { ApiClient } = await import('./apiClient')
  return new ApiClient(
    {
      apiUrl: 'http://api.test/api',
      billingApiUrl: 'http://billing.test',
      analyticsApiUrl: analyticsApiUrl ?? undefined,
    } as never,
    accessToken,
  )
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

describe('ApiClient access-token refresh', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the core API for built-in analytics when no external analytics URL is configured', async () => {
    const requests: CapturedRequest[] = []
    const api = await makeTokenRefreshClient(requests, 'access-token', null)

    expect(api.analyticsUsageApi).not.toBeNull()
    expect(api.analyticsTelemetryApi).toBeNull()
    await api.analyticsUsageApi?.organizationOrganizationIdUsageAggregatedGet(
      'org-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    )

    expect(requests).toEqual([
      expect.objectContaining({
        url: expect.stringMatching(/^http:\/\/api\.test\/api\/organization\/org-1\/usage\/aggregated\?/),
        authorization: 'Bearer access-token',
      }),
    ])
  })

  it('uses a directly refreshed token for subsequent billing requests', async () => {
    const requests: CapturedRequest[] = []
    const api = await makeTokenRefreshClient(requests)

    await api.billingApi.getOrganizationUsage('org-1')
    api.billingApi.setAccessToken('billing-token')
    await api.billingApi.getOrganizationUsage('org-1')

    expect(requests.map(({ authorization }) => authorization)).toEqual(['Bearer stale-token', 'Bearer billing-token'])
  })

  it('propagates a refreshed token to core, billing, and analytics clients', async () => {
    const requests: CapturedRequest[] = []
    const api = await makeTokenRefreshClient(requests)

    api.setAccessToken('refreshed-token')
    await api.organizationsApi.listOrganizations()
    await api.billingApi.getOrganizationUsage('org-1')
    await api.analyticsUsageApi?.organizationOrganizationIdBoxBoxIdUsageGet(
      'org-1',
      'box-1',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    )

    expect(requests).toHaveLength(3)
    expect(requests.map(({ authorization }) => authorization)).toEqual([
      'Bearer refreshed-token',
      'Bearer refreshed-token',
      'Bearer refreshed-token',
    ])
  })
})
