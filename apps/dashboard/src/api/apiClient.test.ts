// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
  headers: Record<string, string> = {},
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
      headers,
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

describe('ApiClient Box API errors', () => {
  it('uses the current access token for Box API requests', async () => {
    const requests: any[] = []
    const api = await makeClient(vi.fn(), 201, { box_id: 'box-1' }, requests)
    api.setAccessToken('renewed-token')
    const cloud = await import('../lib/cloudBox')

    await cloud.createBoxViaBoxApi(api, 'org-1', {})

    expect(requests[0].headers.Authorization).toBe('Bearer renewed-token')
  })

  it('preserves the server reason, status, code and Box ID for create-box failures', async () => {
    const api = await makeClient(vi.fn(), 400, {
      message: 'runner has not declared filestore',
      statusCode: 400,
      code: 'BOX_STATE_TRANSITION_FAILED',
      boxId: 'box-1',
    })
    const cloud = await import('../lib/cloudBox')
    const { BoxliteError } = await import('./errors')

    const error = await cloud.createBoxViaBoxApi(api, 'org-1', {}).catch((failure) => failure)

    expect(error).toBeInstanceOf(BoxliteError)
    expect(error).toMatchObject({
      message: 'runner has not declared filestore',
      statusCode: 400,
      code: 'BOX_STATE_TRANSITION_FAILED',
      boxId: 'box-1',
    })
  })
})

describe('ApiClient registration deadline', () => {
  let api: import('./apiClient').ApiClient
  let send: ReturnType<typeof vi.fn<import('axios').AxiosAdapter>>
  const onUnauthorized = vi.fn()

  beforeAll(async () => {
    vi.resetModules()
    const { default: axios, AxiosError } = await import('axios')
    send = vi.fn<import('axios').AxiosAdapter>(
      (request) =>
        new Promise<never>((_resolve, reject) => {
          if (request.timeout) {
            setTimeout(
              () => reject(new AxiosError(`timeout of ${request.timeout}ms exceeded`, 'ECONNABORTED', request)),
              request.timeout,
            )
          }
        }),
    )
    axios.defaults.adapter = send
    const { ApiClient } = await import('./apiClient')
    api = new ApiClient(config, 'tok', onUnauthorized)
  })

  it('ends a stalled registration after 30 seconds without resending it or restarting authentication', async () => {
    vi.useFakeTimers()
    try {
      const rejected = vi.fn()
      void api.register('challenge-token').catch(rejected)
      await vi.advanceTimersByTimeAsync(29_999)
      expect(rejected).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ message: 'Operation timed out' }))
      expect(send).toHaveBeenCalledTimes(1)
      expect(onUnauthorized).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ApiClient registration', () => {
  it.each([200, 201])('returns the user for HTTP %i using the current access token', async (status) => {
    const user = { id: 'auth0|new-user', name: 'User' }
    const requests: any[] = []
    const api = await makeClient(vi.fn(), status, user, requests)
    api.setAccessToken('renewed-token')
    await expect(api.register('challenge-token')).resolves.toEqual(user)
    expect(requests[0]).toMatchObject({
      method: 'post',
      url: '/auth/register',
      baseURL: 'http://api.test/api',
      data: JSON.stringify({ turnstileToken: 'challenge-token' }),
      headers: { Authorization: 'Bearer renewed-token' },
    })
  })

  it.each([
    [403, 'registration_required'],
    [400, 'turnstile_token_required'],
    [400, 'turnstile_token_invalid'],
    [403, 'turnstile_verification_failed'],
    [503, 'turnstile_unavailable'],
    [503, 'registration_rate_limit_unavailable'],
  ])('preserves %i/%s without restarting authentication', async (status, code) => {
    const onUnauthorized = vi.fn()
    const api = await makeClient(onUnauthorized, Number(status), { code, message: 'Please retry' })
    await expect(api.register('token')).rejects.toMatchObject({ code, message: 'Please retry' })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it.each([
    ['42', 42],
    ['0', undefined],
    ['invalid', undefined],
    ['1.5', undefined],
  ])('preserves a valid Retry-After: %s', async (header, seconds) => {
    const api = await makeClient(vi.fn(), 429, { code: 'registration_rate_limited' }, [], {
      'retry-after': String(header),
    })
    await expect(api.register('token')).rejects.toMatchObject({
      code: 'registration_rate_limited',
      retryAfterSeconds: seconds,
    })
  })
})

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
    await api.getCiRunners('original-org', 2, 25)
    await api.deleteCiConnection('original-org', 'binding-id')
    await api.getCiSettings('original-org')
    await api.setCiCapacity('original-org', null)
    await api.getCiConnectConfiguration('original-org')
    await api.startCiConnect('original-org', {
      account_type: 'User',
      follow_installation: true,
      allow_private_repositories: true,
    })
    await api.completeCiConnect('original-org', 'attempt-id', { code: 'private-code', state: 'private-state' })
    expect(requests.map((request) => request.url)).toEqual([
      '/v1/original-org/ci/runners',
      '/v1/original-org/ci/connections/binding-id',
      '/v1/original-org/ci/settings',
      '/v1/original-org/ci/settings',
      '/v1/original-org/ci/connect/configuration',
      '/v1/original-org/ci/connect/web',
      '/v1/original-org/ci/connect/attempt-id/complete',
    ])
    expect(requests[0].params).toEqual({ page: 2, limit: 25 })
    expect(requests[1].method).toBe('delete')
    expect(requests[1].data).toBeUndefined()
    expect(requests.every((request) => request.headers.Authorization === 'Bearer new-token')).toBe(true)
    expect(JSON.parse(requests[3].data)).toEqual({ max_concurrent_jobs: null })
    expect(JSON.parse(requests[6].data)).toEqual({ code: 'private-code', state: 'private-state' })
  })
  it('adds a normalized literal runner name filter without changing the unfiltered request', async () => {
    const requests: any[] = []
    const api = await makeClient(vi.fn(), 200, {}, requests)
    await api.getCiRunners('org/one', 2, 25)
    await api.getCiRunners('org/one', 1, 25, ' CI-JIT-% ')
    expect(requests.map((request) => request.url)).toEqual(['/v1/org%2Fone/ci/runners', '/v1/org%2Fone/ci/runners'])
    expect(requests[0].params).toEqual({ page: 2, limit: 25 })
    expect(requests[1].params).toEqual({ page: 1, limit: 25, name: 'CI-JIT-%' })
  })
  it('scopes repository pages and account actions to the captured organization and encoded grant', async () => {
    const requests: any[] = []
    const api = await makeClient(vi.fn(), 200, {}, requests)
    const signal = new AbortController().signal
    await api.getCiRepositories('org/one', { kind: 'binding', id: 'binding/id' }, 2, signal)
    await api.getCiRepositories('org/one', { kind: 'grant', id: 'grant/id', account: 37 }, 1, signal)
    await api.getCiConnect('org/one', 'grant/id')
    await api.cancelCiConnect('org/one', 'grant/id')
    await api.selectCiAccount('org/one', 'grant/id', 37, true)
    await api.selectCiConnect('org/one', 'grant/id', 11)
    await api.completeCiInstallation('org/one', 'grant/id', { installation_id: 11, state: 'private-state' })
    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'get', url: '/v1/org%2Fone/ci/connections/binding%2Fid/repositories' },
      { method: 'get', url: '/v1/org%2Fone/ci/connect/grant%2Fid/accounts/37/repositories' },
      { method: 'get', url: '/v1/org%2Fone/ci/connect/grant%2Fid' },
      { method: 'delete', url: '/v1/org%2Fone/ci/connect/grant%2Fid' },
      { method: 'post', url: '/v1/org%2Fone/ci/connect/grant%2Fid/accounts' },
      { method: 'post', url: '/v1/org%2Fone/ci/connect/grant%2Fid/select' },
      { method: 'post', url: '/v1/org%2Fone/ci/connect/grant%2Fid/installation' },
    ])
    expect(requests[0].params).toEqual({ page: 2, limit: 25 })
    expect(requests[1].params).toEqual({ page: 1, limit: 25 })
    expect(requests[0].signal).toBe(signal)
    expect(requests[1].signal).toBe(signal)
    expect(requests.every((request) => request.headers.Authorization === 'Bearer tok')).toBe(true)
    expect(JSON.parse(requests[4].data)).toEqual({ account_id: 37, allow_private_repositories: true })
    expect(JSON.parse(requests[5].data)).toEqual({ installation_id: 11 })
    expect(JSON.parse(requests[6].data)).toEqual({ installation_id: 11, state: 'private-state' })
  })
  it('updates only a connection policy using its captured organization and encoded binding', async () => {
    const requests: any[] = []
    const api = await makeClient(vi.fn(), 200, {}, requests)
    api.setAccessToken('current-token')
    await api.updateCiConnection('org/one', 'binding/id', false)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/v1/org%2Fone/ci/connections/binding%2Fid')
    expect(requests[0].method).toBe('patch')
    expect(requests[0].headers.Authorization).toBe('Bearer current-token')
    expect(JSON.parse(requests[0].data)).toEqual({ allow_private_repositories: false })
  })
  it('CI completion discards Axios request bodies from surfaced errors', async () => {
    const api = await makeClient(vi.fn(), 403, { message: 'private-code private-token' })
    const error = await api
      .completeCiConnect('original-org', 'attempt-id', { code: 'private-code', state: 'private-state' })
      .catch((error) => error)
    expect(error.message).toBe('GitHub authorization could not be completed. Restart connect.')
    expect(error.cause).toBeUndefined()
  })
  it('installation completion discards Axios state and response bodies from surfaced errors', async () => {
    const api = await makeClient(vi.fn(), 403, { message: 'private-state private-token' })
    const error = await api
      .completeCiInstallation('org', 'grant', { installation_id: 11, state: 'private-state' })
      .catch((error) => error)
    expect(error.message).toBe('GitHub installation could not be verified. Restart connect.')
    expect(error.config).toBeUndefined()
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
      { method: 'post', url: '/v1/org%2Fone/boxes', data: { checkpoint_id: 'checkpoint' }, auth: 'Bearer tok' },
      {
        method: 'post',
        url: '/v1/org%2Fone/boxes',
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

describe('ApiClient volume storage capabilities', () => {
  it('discovers volume backend capabilities using the authenticated REST client', async () => {
    const requests: any[] = []
    const capabilities = { object_storage_enabled: true, filestore_enabled: false }
    const api = await makeClient(vi.fn(), 200, { capabilities }, requests)

    await expect(api.getVolumeStorageCapabilities()).resolves.toEqual(capabilities)
    expect(requests[0]).toMatchObject({ method: 'get', url: '/v1/config' })
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

    const controller = new AbortController()
    await api.setBoxInboundMode('org-1', 'box-1', 'enabled', controller.signal)

    expect(requests).toHaveLength(1)
    const [request] = requests
    expect((request as { signal?: AbortSignal }).signal).toBe(controller.signal)
    expect(request.method).toBe('put')
    expect(request.baseURL).toBe('http://api.test/api')
    expect(request.url).toBe('/v1/org-1/boxes/box-1/network/inbound')
    expect(JSON.parse(request.data ?? '')).toEqual({ mode: 'enabled' })
    expect((request.headers as { Authorization?: string }).Authorization).toBe('Bearer tok')
  })
})

describe('ApiClient.prepareBoxTunnel', () => {
  it('asks the /v1 tunnel route for a port, as the SDK does', async () => {
    vi.resetModules()
    const axios = (await import('axios')).default
    const requests: Array<{ method?: string; url?: string; params?: unknown }> = []
    axios.defaults.adapter = (async (cfg: never) => {
      requests.push(cfg)
      return {
        data: { uri: 'https://3000-d-62.proxy.test', isPublic: true, token: null },
        status: 200,
        statusText: '',
        headers: {},
        config: cfg,
      }
    }) as never
    const { ApiClient } = await import('./apiClient')

    const uri = await new ApiClient(config, 'tok').prepareBoxTunnel('org-1', 'box-1', 3000, true)

    expect(uri).toEqual({ uri: 'https://3000-d-62.proxy.test', isPublic: true, token: null })
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
    expect(requests[0].url).toBe('/box/box-1/attach-tickets')
    expect(requests[0].baseURL).toBe('http://api.test/api')
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

describe('tunnel access contract', () => {
  const token = `blt_${'a'.repeat(43)}`
  const descriptor = { uri: 'https://3000-box.proxy.test', isPublic: true, token: null }
  const configReply = { capabilities: { private_tunnels_enabled: true } }

  it('refuses private creation without contacting any server', async () => {
    const requests: any[] = []
    const api = await makeClient(vi.fn(), 200, configReply, requests)
    await expect(api.prepareBoxTunnel('org-1', 'box-1', 3000, false)).rejects.toMatchObject({ outcome: 'refused' })
    expect(requests).toHaveLength(0)
  })

  it('does not submit when the scope is aborted', async () => {
    const requests: any[] = []
    const api = await makeClient(vi.fn(), 200, descriptor, requests)
    const controller = new AbortController()
    controller.abort()
    await expect(api.prepareBoxTunnel('org-1', 'box-1', 3000, true, controller.signal)).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })

  it.each([
    { ...descriptor, isPublic: false },
    { uri: descriptor.uri },
    { ...descriptor, token },
    { ...descriptor, uri: 'javascript:alert(1)' },
    { ...descriptor, uri: [descriptor.uri] },
    { ...descriptor, uri: 'https://user:secret@example.test' },
  ])('reports uncertain creation without retaining the invalid response: %j', async (body) => {
    const api = await makeClient(vi.fn(), 200, (cfg: { url: string }) =>
      cfg.url === '/v1/config' ? configReply : body,
    )
    const error = await api.prepareBoxTunnel('org-1', 'box-1', 3000, true).catch((e) => e)
    expect(error.outcome).toBe('unknown')
    expect(error.message).toContain('may be exposed')
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain(token)
  })

  it('surfaces an access-mode conflict without revoking or retrying', async () => {
    const requests: any[] = []
    const api = await makeClient(
      vi.fn(),
      409,
      { message: 'Tunnel access mode differs; revoke it before recreating' },
      requests,
    )
    await expect(api.prepareBoxTunnel('org-1', 'box-1', 3000, true)).rejects.toThrow('different access mode')
    expect(requests.map((r) => r.method)).toEqual(['post'])
  })

  it('revokes directly, without capabilities, inbound or readiness reads', async () => {
    const requests: any[] = []
    const api = await makeClient(vi.fn(), 204, undefined, requests)
    await api.revokeBoxTunnel('org-1', 'box-1', 3000)
    expect(requests.map((r) => [r.method, r.url, r.params])).toEqual([
      ['delete', '/v1/org-1/boxes/box-1/network/tunnel', { port: 3000 }],
    ])
  })

  it.each([0, 65536, 1.5, NaN])('rejects invalid port %s before any request', async (port) => {
    const requests: any[] = []
    const api = await makeClient(vi.fn(), 200, {}, requests)
    await expect(api.prepareBoxTunnel('org-1', 'box-1', port, false)).rejects.toThrow('1 to 65535')
    await expect(api.revokeBoxTunnel('org-1', 'box-1', port)).rejects.toThrow('1 to 65535')
    expect(requests).toHaveLength(0)
  })
})

describe('tunnel request boundaries', () => {
  it.each([1, 65535])('accepts boundary port %s with explicit public access', async (port) => {
    const requests: any[] = []
    const descriptor = { uri: 'https://port.proxy.test', isPublic: true, token: null }
    const api = await makeClient(vi.fn(), 200, descriptor, requests)
    await expect(api.prepareBoxTunnel('org-1', 'box-1', port, true)).resolves.toEqual(descriptor)
    expect(requests).toHaveLength(1)
    expect(requests[0].params).toEqual({ port })
    expect(JSON.parse(requests[0].data)).toEqual({ isPublic: true })
    expect(requests[0].timeout).toBe(30_000)
  })

  it.each([401, 403, 404, 409, 400])('classifies HTTP %s as refused after authentication recovery', async (status) => {
    // A first 401 intentionally suspends while the shared interceptor redirects.
    // Exercise the rejected response after that existing recovery attempt.
    window.sessionStorage.setItem('boxlite.reauth-attempted', '1')
    const requests: any[] = []
    const api = await makeClient(vi.fn(), status, { message: 'Refused' }, requests)
    await expect(api.prepareBoxTunnel('org-1', 'box-1', 3000, true)).rejects.toMatchObject({ outcome: 'refused' })
    expect(requests).toHaveLength(1)
    window.sessionStorage.removeItem('boxlite.reauth-attempted')
  })

  it('keeps a failed revocation uncertain and does not retry automatically', async () => {
    const requests: any[] = []
    const api = await makeClient(vi.fn(), 502, { message: 'Unavailable' }, requests)
    await expect(api.revokeBoxTunnel('org-1', 'box-1', 3000)).rejects.toMatchObject({
      outcome: 'unknown',
      message: 'Could not confirm revocation. Retry revoking this port.',
    })
    expect(requests).toHaveLength(1)
  })
})
