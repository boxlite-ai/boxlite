// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const config = { apiUrl: 'http://api.test/api' } as never

// Fresh module per test so the module-level `isHandlingUnauthorized` guard
// doesn't leak across cases. A custom axios adapter makes every request resolve
// to `status` with an empty body, so the response interceptor sees the 401.
async function makeClient(onUnauthorized: () => Promise<void> | void, status = 401, body: unknown = {}) {
  vi.resetModules()
  const axios = (await import('axios')).default
  // A custom adapter must settle the response itself (axios doesn't re-apply
  // validateStatus to a custom adapter's return), so reject non-2xx with an
  // AxiosError carrying `.response`, exactly like the built-in adapters.
  axios.defaults.adapter = (async (cfg: unknown) => {
    const response = { data: body, status, statusText: '', headers: {}, config: cfg }
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

  // A 403 is not an authentication failure, so none of the recovery machinery
  // above may engage: the token is valid and re-logging in cannot change the
  // account state the API is objecting to.
  it('a coded 403 becomes a typed error and never triggers re-login', async () => {
    const onUnauthorized = vi.fn(() => Promise.resolve())
    const api = await makeClient(onUnauthorized, 403, {
      message: 'Email verification required',
      code: 'email_verification_required',
    })

    // Imported after makeClient's vi.resetModules() so these are the same class
    // objects the freshly-imported apiClient constructs.
    const { EmailVerificationRequiredError } = await import('./errors')

    await expect(api.organizationsApi.listOrganizations()).rejects.toBeInstanceOf(EmailVerificationRequiredError)
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem('boxlite.reauth-attempted')).toBeNull()
  })

  it('an uncoded error stays a plain BoxliteError', async () => {
    const onUnauthorized = vi.fn(() => Promise.resolve())
    const api = await makeClient(onUnauthorized, 403, { message: 'Forbidden' })

    const { BoxliteError, EmailVerificationRequiredError } = await import('./errors')

    const error = await api.organizationsApi.listOrganizations().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BoxliteError)
    expect(error).not.toBeInstanceOf(EmailVerificationRequiredError)
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
