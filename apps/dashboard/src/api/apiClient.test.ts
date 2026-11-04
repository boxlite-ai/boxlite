// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const config = { apiUrl: 'http://api.test/api' } as never

describe('ApiClient domains', () => {
  it('uses authenticated organization-scoped list and short-name claim requests', async () => {
    const requests: any[] = []
    const result = { hostname: 'my-app.apps.test', url: 'https://my-app.apps.test', target: null }
    const api = await makeClient(vi.fn(), 201, result, requests)
    await api.listDomains('org/one')
    await expect(api.claimDomain('org/one', 'my-app')).resolves.toEqual(result)
    expect(
      requests.map(({ method, url, baseURL, data, headers }) => ({
        method,
        url,
        baseURL,
        data,
        auth: headers.Authorization,
      })),
    ).toEqual([
      {
        method: 'get',
        url: '/v1/org%2Fone/domains',
        baseURL: 'http://api.test/api',
        data: undefined,
        auth: 'Bearer tok',
      },
      {
        method: 'post',
        url: '/v1/org%2Fone/domains',
        baseURL: 'http://api.test/api',
        data: JSON.stringify({ name: 'my-app' }),
        auth: 'Bearer tok',
      },
    ])
  })

  it('keeps claim refusal messages through the shared interceptor', async () => {
    const api = await makeClient(vi.fn(), 409, { message: 'my-app.apps.test is not available.' })
    await expect(api.claimDomain('org-1', 'my-app')).rejects.toThrow('my-app.apps.test is not available.')
  })
})

it('sends the dashboard activity source without inventing an SDK version', async () => {
  vi.resetModules()
  const axios = (await import('axios')).default
  const requests: Array<{ url?: string; headers: Record<string, unknown> }> = []
  axios.defaults.adapter = async (request) => {
    requests.push({ url: request.url, headers: request.headers.toJSON() })
    return { data: [], status: 200, statusText: 'OK', headers: {}, config: request }
  }
  const { ApiClient } = await import('./apiClient')
  const api = new ApiClient(config, 'test-token')
  const cloud = await import('../lib/cloudBox')
  await api.organizationsApi.listOrganizations()
  await cloud.createBoxViaBoxApi(api, 'org-1', {})
  await cloud.startBoxViaBoxApi(api, 'org-1', 'box-1')
  await cloud.stopBoxViaBoxApi(api, 'org-1', 'box-1')
  await cloud.deleteBoxViaBoxApi(api, 'org-1', 'box-1')
  await api.webhookRequest('POST', '/webhooks', {})
  expect(requests).toHaveLength(6)
  for (const request of requests) {
    expect(request.headers['X-BoxLite-Source'], request.url).toBe('dashboard')
    expect(request.headers['X-BoxLite-SDK-Version']).toBeUndefined()
    expect(request.headers.Authorization).toBe('Bearer test-token')
  }
})

// Fresh module per test so the module-level `isHandlingUnauthorized` guard
// doesn't leak across cases. A custom axios adapter makes every request resolve
// to `status` with an empty body, so the response interceptor sees the 401.
async function makeClient(
  onUnauthorized: () => Promise<void> | void,
  status = 401,
  body: unknown = {},
  requests: any[] = [],
) {
  vi.resetModules()
  const axios = (await import('axios')).default
  // A custom adapter must settle the response itself (axios doesn't re-apply
  // validateStatus to a custom adapter's return), so reject non-2xx with an
  // AxiosError carrying `.response`, exactly like the built-in adapters.
  axios.defaults.adapter = (async (cfg: unknown) => {
    requests.push(cfg)
    const response = {
      data: typeof body === 'function' ? body(cfg) : body,
      status,
      statusText: '',
      headers: {},
      config: cfg,
    }
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
  it('CI methods use the explicitly supplied original organization, current token and REST paths', async () => {
    const requests: any[] = []
    const api = await makeClient(vi.fn(), 200, { status: 'connected' }, requests)
    api.setAccessToken('new-token')
    await api.getCiSettings('original-org')
    await api.setCiCapacity('original-org', null)
    await api.getCiConnectConfiguration('original-org')
    await api.startCiConnect('original-org', {
      github_account: 'alice',
      follow_installation: true,
      allow_public_repositories: true,
    })
    await api.completeCiConnect('original-org', 'attempt-id', { code: 'private-code', state: 'private-state' })
    expect(requests.map((request) => request.url)).toEqual([
      '/v1/original-org/ci/settings',
      '/v1/original-org/ci/settings',
      '/v1/original-org/ci/connect/configuration',
      '/v1/original-org/ci/connect/web',
      '/v1/original-org/ci/connect/attempt-id/complete',
    ])
    expect(requests.every((request) => request.headers.Authorization === 'Bearer new-token')).toBe(true)
    expect(JSON.parse(requests[1].data)).toEqual({ max_concurrent_jobs: null })
    expect(JSON.parse(requests[4].data)).toEqual({ code: 'private-code', state: 'private-state' })
  })
  it('CI completion discards Axios request bodies from surfaced errors', async () => {
    const api = await makeClient(vi.fn(), 403, { message: 'private-code private-token' })
    const error = await api
      .completeCiConnect('original-org', 'attempt-id', { code: 'private-code', state: 'private-state' })
      .catch((error) => error)
    expect(error.message).toBe('GitHub authorization could not be completed. Restart connect.')
    expect(error.cause).toBeUndefined()
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

  // A 403 is not an authentication failure, so none of the recovery machinery
  // above may engage: the token is valid and re-logging in cannot change the
  // account state the API is objecting to.
  it.each([
    { status: 403, code: 'disposable_email' },
    { status: 403, code: 'email_required' },
    { status: 400, code: 'invalid_email' },
  ])('preserves registration email rejection $status/$code without re-login', async ({ status, code }) => {
    const onUnauthorized = vi.fn(() => Promise.resolve())
    const api = await makeClient(onUnauthorized, status, { message: 'Account creation refused', code })

    const error = await api.organizationsApi.listOrganizations().catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code, message: 'Account creation refused' })
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem('boxlite.reauth-attempted')).toBeNull()
  })

  it('an uncoded error stays a plain BoxliteError', async () => {
    const onUnauthorized = vi.fn(() => Promise.resolve())
    const api = await makeClient(onUnauthorized, 403, { message: 'Forbidden' })

    // Imported after makeClient's vi.resetModules() so these are the same class
    // objects the freshly-imported apiClient constructs.
    const { BoxliteError, RegistrationEmailError } = await import('./errors')

    const error = await api.organizationsApi.listOrganizations().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BoxliteError)
    expect(error).not.toBeInstanceOf(RegistrationEmailError)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  // The catalog's delete refusal is only useful for the box ids in its message;
  // an image client built outside the shared instance would hand the page a
  // raw axios error and the toast would fall back to a generic line.
  it('image requests share the error handling: a 409 refusal keeps the box ids', async () => {
    const refusal = "Image 'quay.io/acme/app' cannot be removed while 2 box(es) can still boot from it: box-1, box-2"
    const onUnauthorized = vi.fn(() => Promise.resolve())
    const api = await makeClient(onUnauthorized, 409, { statusCode: 409, error: 'Conflict', message: refusal })

    const { BoxliteError } = await import('./errors')

    const error = await api.imageApi.deleteImage('img-1', 'org-1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BoxliteError)
    expect((error as Error).message).toBe(refusal)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('a rejecting onUnauthorized resets state and surfaces an error (no hang)', async () => {
    const onUnauthorized = vi.fn(() => Promise.reject(new Error('redirect start failed')))
    const api = await makeClient(onUnauthorized)
    await expect(api.organizationsApi.listOrganizations()).rejects.toBeTruthy()
    // Marker cleared so a later genuine 401 still gets its one recovery attempt.
    expect(window.sessionStorage.getItem('boxlite.reauth-attempted')).toBeNull()
  })

  it('registry requests preserve removal refusals through the shared interceptor', async () => {
    const refusal = 'Cannot remove login while box-1 pulls through it'
    const onUnauthorized = vi.fn()
    const api = await makeClient(onUnauthorized, 409, { message: refusal })
    const { BoxliteError } = await import('./errors')

    const error = await api.registriesApi.deleteRegistryCredential('credential-1', 'org-1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BoxliteError)
    expect((error as Error).message).toBe(refusal)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe('ApiClient checkpoints', () => {
  it('discovers checkpoint capability using the authenticated REST client', async () => {
    const requests: any[] = []
    const api = await makeClient(vi.fn(), 200, { capabilities: { checkpoints_enabled: true } }, requests)
    await expect(api.getCheckpointCapabilities()).resolves.toEqual({ checkpoints_enabled: true })
    expect(requests[0]).toMatchObject({ method: 'get', url: '/v1/config', headers: { Authorization: 'Bearer tok' } })
  })
  it('uses scoped authenticated requests and omits execution overrides and absent names', async () => {
    const requests: any[] = []
    const api = await makeClient(vi.fn(), 200, { box_id: 'target' }, requests)
    await api.createCheckpoint('org/one', 'source')
    await api.createCheckpoint('org/one', 'source', 'base')
    await api.createBoxFromCheckpoint('org/one', 'checkpoint')
    await api.createBoxFromCheckpoint('org/one', 'checkpoint', 'worker')
    await api.removeCheckpoint('org/one', 'base/name')
    expect(
      requests.map(({ method, url, data, headers }) => ({
        method,
        url,
        data: data && JSON.parse(data),
        auth: headers.Authorization,
      })),
    ).toEqual([
      { method: 'post', url: '/v1/org%2Fone/checkpoints', data: { source_box_id: 'source' }, auth: 'Bearer tok' },
      {
        method: 'post',
        url: '/v1/org%2Fone/checkpoints',
        data: { source_box_id: 'source', name: 'base' },
        auth: 'Bearer tok',
      },
      { method: 'post', url: '/v1/org%2Fone/boxes/import', data: { checkpoint_id: 'checkpoint' }, auth: 'Bearer tok' },
      {
        method: 'post',
        url: '/v1/org%2Fone/boxes/import',
        data: { checkpoint_id: 'checkpoint', name: 'worker' },
        auth: 'Bearer tok',
      },
      { method: 'delete', url: '/v1/org%2Fone/checkpoints/base%2Fname', data: undefined, auth: 'Bearer tok' },
    ])
  })

  it('reads every page and refuses repeated continuation tokens', async () => {
    const requests: any[] = []
    const api = await makeClient(
      vi.fn(),
      200,
      (cfg: any) =>
        cfg.params?.page_token
          ? { checkpoints: [{ id: 'second' }] }
          : { checkpoints: [{ id: 'first' }], next_page_token: 'next /+' },
      requests,
    )
    await expect(api.listCheckpoints('org-1')).resolves.toEqual([{ id: 'first' }, { id: 'second' }])
    expect(requests[0].params).toBeUndefined()
    expect(requests[1].params).toEqual({ page_token: 'next /+' })
    const looping = await makeClient(vi.fn(), 200, { checkpoints: [], next_page_token: 'same' })
    await expect(looping.listCheckpoints('org-1')).rejects.toThrow('repeated a pagination token')
  })
})

describe('ApiClient.setBoxInboundMode', () => {
  it('sends the mode to the /v1 inbound route of the selected organization', async () => {
    vi.resetModules()
    const axios = (await import('axios')).default
    const requests: Array<{ method?: string; url?: string; baseURL?: string; data?: string; headers?: unknown }> = []
    axios.defaults.adapter = (async (cfg: never) => {
      requests.push(cfg)
      return { data: {}, status: 200, statusText: '', headers: {}, config: cfg }
    }) as never
    const { ApiClient } = await import('./apiClient')
    const api = new ApiClient(config, 'tok')

    await api.setBoxInboundMode('org-1', 'box-1', 'enabled')

    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request.method).toBe('put')
    expect(request.baseURL).toBe('http://api.test/api')
    expect(request.url).toBe('/v1/org-1/boxes/box-1/network/inbound')
    expect(JSON.parse(request.data ?? '')).toEqual({ mode: 'enabled' })
    expect((request.headers as { Authorization?: string }).Authorization).toBe('Bearer tok')
  })
})

describe('ApiClient.getTunnelUrl', () => {
  it('asks the /v1 tunnel route for a port, as the SDK does', async () => {
    vi.resetModules()
    const axios = (await import('axios')).default
    const requests: Array<{ method?: string; url?: string; params?: unknown }> = []
    axios.defaults.adapter = (async (cfg: never) => {
      requests.push(cfg)
      return { data: { uri: 'https://3000-d-62.proxy.test' }, status: 200, statusText: '', headers: {}, config: cfg }
    }) as never
    const { ApiClient } = await import('./apiClient')

    const uri = await new ApiClient(config, 'tok').getTunnelUrl('org-1', 'box-1', 3000)

    expect(uri).toBe('https://3000-d-62.proxy.test')
    expect(requests[0].method).toBe('post')
    expect(requests[0].url).toBe('/v1/org-1/boxes/box-1/network/tunnel')
    expect(requests[0].params).toEqual({ port: 3000 })
  })
})

describe('ApiClient terminal session', () => {
  async function clientRecording(responses: Record<string, unknown>) {
    vi.resetModules()
    const axios = (await import('axios')).default
    const requests: Array<{ method?: string; url?: string; data?: string }> = []
    axios.defaults.adapter = (async (cfg: { method?: string; url?: string; data?: string }) => {
      requests.push(cfg)
      const data = Object.entries(responses).find(([suffix]) => cfg.url?.endsWith(suffix))?.[1] ?? {}
      return { data, status: 200, statusText: '', headers: {}, config: cfg }
    }) as never
    const { ApiClient } = await import('./apiClient')
    return { api: new ApiClient(config, 'tok'), requests }
  }

  it('starts a login shell on a pseudo-terminal', async () => {
    const { api, requests } = await clientRecording({ '/exec': { execution_id: 'exec-1' } })

    await expect(api.startTerminalExec('org-1', 'box-1')).resolves.toBe('exec-1')

    expect(requests[0].method).toBe('post')
    expect(requests[0].url).toBe('/v1/org-1/boxes/box-1/exec')
    expect(JSON.parse(requests[0].data ?? '')).toMatchObject({ command: '/bin/sh', tty: true })
  })

  // The ticket rides in the URL because a browser WebSocket carries no
  // Authorization header; the bearer only ever goes to the ticket route.
  it('buys a ticket with the bearer and puts it in the attach WebSocket URL', async () => {
    const { api, requests } = await clientRecording({ '/attach-tickets': { ticket: 'tkt-1' } })

    const url = await api.terminalAttachUrl('org-1', 'box-1', 'exec-1')

    expect(requests[0].method).toBe('post')
    expect(requests[0].url).toBe('http://api.test/api/box/box-1/attach-tickets')
    expect(JSON.parse(requests[0].data ?? '')).toEqual({ executionId: 'exec-1' })
    expect(url).toBe('ws://api.test/api/v1/org-1/boxes/box-1/executions/exec-1/attach?ticket=tkt-1')
    expect(url).not.toContain('tok')
  })

  // Ends the shell a terminal leaves behind, so it does not wait for the
  // runner's idle reaper.
  it('kills a terminal execution', async () => {
    const { api, requests } = await clientRecording({})

    await api.killTerminalExec('org-1', 'box-1', 'exec-1')

    expect(requests[0].method).toBe('delete')
    expect(requests[0].url).toBe('/v1/org-1/boxes/box-1/executions/exec-1')
  })
})

it('sends organization-scoped onboarding requests with revisions and no generated credentials', async () => {
  const requests: any[] = []
  const result = { text: 'Build a dashboard', revision: 2 }
  const api = await makeClient(vi.fn(), 200, result, requests)
  await expect(api.getOrganizationOnboarding('org/one')).resolves.toEqual(result)
  await api.saveOrganizationOnboarding('org/one', { useCase: 'long-running-agent', note: 'Nightly jobs' })
  await api.getPromptDraft('org/one')
  await expect(api.savePromptDraft('org/one', 'Build a dashboard', 1)).resolves.toEqual(result)
  await api.preparePromptHandoff('org/one', 'Build a dashboard', 'request-1')
  await api.markPromptCopied('org/one', 'request/1')
  expect(requests.map(({ method, url }) => [method, url])).toEqual([
    ['get', '/organizations/org%2Fone/onboarding'],
    ['put', '/organizations/org%2Fone/onboarding'],
    ['get', '/organizations/org%2Fone/quickstart/prompt'],
    ['put', '/organizations/org%2Fone/quickstart/prompt'],
    ['post', '/organizations/org%2Fone/quickstart/handoffs'],
    ['patch', '/organizations/org%2Fone/quickstart/handoffs/request%2F1/copied'],
  ])
  expect(JSON.parse(requests[3].data)).toEqual({ text: 'Build a dashboard', revision: 1 })
  expect(JSON.parse(requests[4].data)).toEqual({ text: 'Build a dashboard', requestId: 'request-1' })
  expect(requests.every((r) => r.baseURL === 'http://api.test/api')).toBe(true)
})
