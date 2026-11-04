// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Box, BoxState, NetworkMode } from '@boxlite-ai/api-client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoxSshTab } from './BoxSshTab'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  generate: vi.fn(),
  inbound: vi.fn(),
  organization: 'org-1',
  permitted: true,
}))
vi.mock('@/hooks/useApi', () => {
  const api = {
    axiosInstance: { get: mocks.get, post: mocks.post, delete: mocks.delete },
    setBoxInboundMode: mocks.inbound,
  }
  return { useApi: () => api }
})
vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ apiUrl: 'https://api.example.test', oidc: { issuer: '' } }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: mocks.organization ? { id: mocks.organization } : undefined,
    authenticatedUserHasPermission: () => mocks.permitted,
  }),
}))
vi.mock('@/lib/ssh', async (original) => ({ ...(await original<object>()), generateSshCredentials: mocks.generate }))

const status = {
  enabled: true,
  generation: 1,
  listen_address: '0.0.0.0:22',
  host_public_key: 'public-host',
  host_key_fingerprint: 'SHA256:test-fingerprint',
}
const credentials = {
  privateKey: 'test-client-key',
  config: {
    listen_address: '0.0.0.0:22',
    host_private_key: 'test-host-key',
    accounts: [{ login: 'box', authorized_keys: ['test-client-public'] }],
  },
}
let root: Root
let host: HTMLDivElement
let blobs: Blob[]
let queryClient: QueryClient
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}
async function click(label: string) {
  await act(async () => button(label).click())
}
async function render(state = BoxState.STARTED, id = 'box-1', refreshSignal = 0, inbound = NetworkMode.ENABLED) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <BoxSshTab box={{ id, state, network: { inbound: { mode: inbound } } } as Box} refreshSignal={refreshSignal} />
      </QueryClientProvider>,
    ),
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  mocks.organization = 'org-1'
  mocks.permitted = true
  mocks.get.mockResolvedValue({ data: { ...status, enabled: false } })
  mocks.post.mockResolvedValue({ data: status })
  mocks.delete.mockResolvedValue({ data: { ...status, enabled: false } })
  mocks.generate.mockResolvedValue(credentials)
  mocks.inbound.mockReset().mockResolvedValue(undefined)
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  blobs = []
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL(blob: Blob) {
        blobs.push(blob)
        return 'blob:test-key'
      }
      static revokeObjectURL = vi.fn()
    },
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  queryClient.clear()
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('BoxSshTab', () => {
  it('enables disabled inbound before configuring SSH', async () => {
    const inbound = deferred<void>()
    mocks.inbound.mockReturnValueOnce(inbound.promise)
    await render(BoxState.STARTED, 'box-1', 0, NetworkMode.DISABLED)
    await click('Setup')
    expect(mocks.inbound).not.toHaveBeenCalled()
    await click('Set up SSH')
    expect(mocks.inbound).toHaveBeenCalledWith('org-1', 'box-1', NetworkMode.ENABLED)
    expect(mocks.post).not.toHaveBeenCalled()
    await act(async () => inbound.resolve())
    expect(mocks.post).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh', credentials.config, { timeout: 30_000 })
    expect(document.body.textContent).toContain('SSH connection details')
  })

  it('keeps the key and stops setup when enabling inbound fails', async () => {
    mocks.inbound.mockRejectedValueOnce(new Error('private server details'))
    await render(BoxState.STARTED, 'box-1', 0, NetworkMode.DISABLED)
    await click('Setup')
    await click('Set up SSH')
    expect(document.body.textContent).toContain('Unable to enable inbound access')
    expect(document.body.textContent).not.toContain('private server details')
    expect(mocks.post).not.toHaveBeenCalled()
    expect(button('Download private key')).toBeDefined()
    await click('Set up SSH')
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(mocks.post).toHaveBeenCalledOnce()
  })

  it('does not configure SSH if the box stops while enabling inbound', async () => {
    const inbound = deferred<void>()
    mocks.inbound.mockReturnValueOnce(inbound.promise)
    await render(BoxState.STARTED, 'box-1', 0, NetworkMode.DISABLED)
    await click('Setup')
    await click('Set up SSH')
    expect(mocks.inbound).toHaveBeenCalledOnce()
    await render(BoxState.STOPPED)
    await act(async () => inbound.resolve())
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('does not read SSH without a selected organization', async () => {
    mocks.organization = ''
    await render()
    expect(host.textContent).toBe('')
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'])('ignores a stale status %s after refresh', async (outcome) => {
    const stale = deferred<{ data: typeof status }>()
    mocks.get.mockReturnValueOnce(stale.promise)
    await render()
    expect(button('Setup').disabled).toBe(true)

    await render(BoxState.STARTED, 'box-1', 1)
    expect(host.textContent).toContain('SSH disabled')
    await act(async () => {
      if (outcome === 'success') stale.resolve({ data: status })
      else stale.reject(new Error('outdated status request'))
    })

    expect(host.textContent).toContain('SSH disabled')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(button('Setup').disabled).toBe(false)
  })

  it('does not configure SSH if the box stops during key generation', async () => {
    const keys = deferred<typeof credentials>()
    mocks.generate.mockReturnValueOnce(keys.promise)
    await render()
    await click('Setup')
    await click('Set up SSH')
    await render(BoxState.STOPPED)
    await act(async () => keys.resolve(credentials))

    expect(mocks.post).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Download private key')
    expect(button('Set up SSH').disabled).toBe(true)
  })

  it.each(['success', 'failure'])('ignores a stale mutation %s after refresh', async (outcome) => {
    const stale = deferred<{ data: typeof status }>()
    await render()
    mocks.post.mockReturnValueOnce(stale.promise)
    await click('Enable')
    await render(BoxState.STARTED, 'box-1', 1)

    await act(async () => {
      if (outcome === 'success') stale.resolve({ data: status })
      else stale.reject(new Error('outdated enable request'))
    })

    expect(host.textContent).toContain('SSH disabled')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(button('Enable').disabled).toBe(false)
  })

  it('keeps the setup dialog open until key generation and configuration finish', async () => {
    const keys = deferred<typeof credentials>()
    mocks.generate.mockReturnValueOnce(keys.promise)
    await render()
    await click('Setup')
    await click('Set up SSH')
    await click('Close')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    await act(async () => keys.resolve(credentials))
    expect(button('Download private key')).toBeDefined()
    await click('Close')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('reports an enable failure without changing the observed status or retrying', async () => {
    await render()
    mocks.post.mockRejectedValueOnce(new Error('private server details'))
    await click('Enable')
    expect(host.textContent).toContain('Unable to enable SSH')
    expect(host.textContent).toContain('SSH disabled')
    expect(host.textContent).not.toContain('private server details')
    expect(mocks.post).toHaveBeenCalledOnce()
    expect(button('Enable').disabled).toBe(false)
  })

  it('sets up once, downloads the client key, and reopens details without reconfiguring', async () => {
    await render()
    await click('Setup')
    expect(mocks.post).not.toHaveBeenCalled()
    await click('Set up SSH')
    expect(mocks.post).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh', credentials.config, { timeout: 30_000 })
    expect(mocks.inbound).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('box@boxlite-box-1')
    expect(document.body.textContent).toContain('ssh --proxy --')
    expect(document.body.textContent).toContain('--context=YOUR_CONTEXT')
    expect(document.body.textContent).toContain('boxlite context ls')
    expect(document.body.textContent).toContain('Replace YOUR_CONTEXT')
    expect(document.body.textContent).toContain('https://api.example.test')
    expect(document.body.textContent).not.toContain('--url')
    expect(document.body.textContent).not.toContain('another terminal')
    expect(document.body.textContent).toContain('SHA256:test-fingerprint')
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('boxlite-box-1-key')
    })
    await click('Download private key')
    expect(download).toHaveBeenCalledOnce()
    const key = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(blobs[0])
    })
    expect(key).toBe(credentials.privateKey)
    expect(document.body.textContent).not.toContain(credentials.privateKey)
    await click('Close')
    await click('Setup')
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(mocks.post).toHaveBeenCalledOnce()
  })

  it('enables and disables saved configuration without generating keys', async () => {
    await render(BoxState.STARTED, 'box-1', 0, NetworkMode.DISABLED)
    await click('Enable')
    expect(mocks.post).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh/enable', undefined, { timeout: 30_000 })
    expect(host.textContent).toContain('SSH enabled')
    await click('Disable')
    expect(mocks.delete).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh', { timeout: 30_000 })
    expect(host.textContent).toContain('SSH disabled')
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.inbound).not.toHaveBeenCalled()
  })

  it('keeps credentials on failure for a manual retry and does not render server secrets', async () => {
    await render()
    mocks.post.mockRejectedValueOnce(new Error('sensitive request body'))
    await click('Setup')
    await click('Set up SSH')
    expect(document.body.textContent).toContain('SSH setup failed')
    expect(document.body.textContent).not.toContain('sensitive request body')
    expect(button('Download private key')).toBeDefined()
    expect(mocks.post).toHaveBeenCalledOnce()
    await click('Set up SSH')
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(mocks.post).toHaveBeenCalledTimes(2)
  })

  it('blocks overlapping actions until the mutation finishes', async () => {
    await render()
    let finish!: (result: unknown) => void
    mocks.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await click('Enable')
    expect(button('Setup').disabled).toBe(true)
    expect(button('Disable').disabled).toBe(true)
    await act(async () => finish({ data: status }))
    expect(button('Setup').disabled).toBe(false)
  })

  it.each([BoxState.STOPPED, BoxState.STARTING])('blocks actions for %s boxes', async (state) => {
    await render(state)
    for (const label of ['Setup', 'Enable', 'Disable']) expect(button(label).disabled).toBe(true)
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('blocks actions for read-only members and reports status failures', async () => {
    mocks.permitted = false
    mocks.get.mockRejectedValueOnce(new Error('unavailable'))
    await render()
    for (const label of ['Setup', 'Enable', 'Disable']) expect(button(label).disabled).toBe(true)
    expect(host.textContent).toContain('Unable to read SSH status')
  })

  it.each(['organization', 'box'])('discards credentials when the %s changes', async (scope) => {
    await render()
    await click('Setup')
    await click('Set up SSH')
    if (scope === 'organization') mocks.organization = 'org-2'
    await render(BoxState.STARTED, scope === 'box' ? 'box-2' : 'box-1')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click('Setup')
    expect(document.body.textContent).not.toContain('Download private key')
  })
})
