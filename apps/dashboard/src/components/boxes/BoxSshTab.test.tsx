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
  user: 'user-1',
  endpoint: 'https://api.example.test',
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
  useConfig: () => ({ apiUrl: mocks.endpoint, oidc: { issuer: '' } }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: mocks.organization ? { id: mocks.organization } : undefined,
    authenticatedUserOrganizationMember: { userId: mocks.user },
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
  hostPublicKey: status.host_public_key,
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
  mocks.user = 'user-1'
  mocks.endpoint = 'https://api.example.test'
  sessionStorage.clear()
  mocks.permitted = true
  mocks.get.mockResolvedValue({ data: status })
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

const missingConfig = {
  isAxiosError: true,
  response: { status: 400, data: { error: { message: 'SSH configuration is required' } } },
}
function disabledStatus() {
  mocks.get.mockResolvedValue({ data: { ...status, enabled: false, host_public_key: '', host_key_fingerprint: '' } })
}
async function confirmAccess() {
  await click(document.body.textContent?.includes('Enable and continue') ? 'Enable and continue' : 'Continue')
}
async function openConnection() {
  await click('Connect via SSH')
  await confirmAccess()
}
async function firstSetup() {
  disabledStatus()
  mocks.post.mockRejectedValueOnce(missingConfig)
  await render()
  await openConnection()
}
async function toggleSsh() {
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="SSH access"]')!.click())
}
async function fillPath(value: string) {
  const input = document.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function keyPathDescription() {
  const input = document.querySelector('input')!
  return input
    .getAttribute('aria-describedby')!
    .split(/\s+/)
    .map((id) => {
      const description = document.getElementById(id)
      expect(description, `Description reference ${id} must resolve`).not.toBeNull()
      return description!.textContent
    })
    .join(' ')
}

describe('BoxSshTab access and connection', () => {
  it('requires consent before enabling SSH and inbound, then opens only connection steps', async () => {
    disabledStatus()
    await render(BoxState.STARTED, 'box-1', 0, NetworkMode.DISABLED)
    await click('Connect via SSH')
    expect(document.body.textContent).toContain('Enable SSH and inbound access for this box.')
    expect(document.querySelector('input')).toBeNull()
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.inbound).not.toHaveBeenCalled()
    await click('Cancel')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(mocks.post).not.toHaveBeenCalled()
    await openConnection()
    expect(mocks.inbound).toHaveBeenCalledWith('org-1', 'box-1', NetworkMode.ENABLED, undefined)
    expect(mocks.post).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh/enable', undefined, { timeout: 30_000 })
    expect(document.querySelector('input')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Enable SSH')
    expect(mocks.generate).not.toHaveBeenCalled()
    await fillPath('/tmp/key')
    expect(document.body.textContent).not.toContain('box@boxlite-box-1')
    await render()
    expect(document.body.textContent).toContain('box@boxlite-box-1')
  })

  it('rechecks status at confirmation and skips writes when already enabled', async () => {
    disabledStatus()
    await render()
    await click('Connect via SSH')
    mocks.get.mockResolvedValue({ data: status })
    await confirmAccess()
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.inbound).not.toHaveBeenCalled()
    expect(document.querySelector('input')).not.toBeNull()
    expect(document.body.textContent).toContain('curl -fsSL')
  })

  it.each([
    { error: { message: 'SSH configuration is required' } },
    { message: 'SSH has no saved configuration' },
    { error: { message: 'stored SSH configuration is missing' } },
    {
      error: {
        message:
          'invalid state: SSH enable: status: FailedPrecondition, message: "SSH configuration is required", details: [], metadata: MetadataMap { headers: {} }',
      },
    },
    {
      error: {
        message:
          'invalid state: SSH enable: status: FailedPrecondition, message: "SSH configuration is required", details: [], metadata: MetadataMap { headers: {"content-type": "application/grpc"} }',
      },
    },
  ])('creates a configuration only after consent and an exact missing-config response', async (data) => {
    disabledStatus()
    await render()
    await click('Connect via SSH')
    expect(document.body.textContent).toContain('Setup replaces SSH accounts and host identity')
    mocks.post.mockRejectedValueOnce({ isAxiosError: true, response: { status: 400, data } })
    await confirmAccess()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(mocks.post).toHaveBeenLastCalledWith('v1/org-1/boxes/box-1/ssh', credentials.config, { timeout: 30_000 })
    expect(button('Download private key')).toBeDefined()
    expect(document.querySelector('input')!.value).toBe('')
    expect(document.body.textContent).toContain('curl -fsSL')
    expect(document.body.textContent).not.toContain('box@boxlite-box-1')
  })

  it.each([undefined, 401, 403, 409, 503])(
    'never creates keys for an unrelated enable failure (%s)',
    async (httpStatus) => {
      disabledStatus()
      await render()
      await click('Connect via SSH')
      mocks.post.mockRejectedValueOnce(
        httpStatus
          ? {
              isAxiosError: true,
              response: { status: httpStatus, data: { error: { message: 'sensitive backend detail' } } },
            }
          : new Error('network unavailable'),
      )
      await confirmAccess()
      const error = document.querySelector('[role="alert"]')!.textContent
      expect(error).not.toMatch(/Create a key|Reset|sensitive backend detail/)
      expect(document.querySelector('input')).toBeNull()
      expect(mocks.generate).not.toHaveBeenCalled()
      expect(mocks.post).toHaveBeenCalledOnce()
    },
  )

  it('does not enable or generate keys when the fresh status read fails', async () => {
    await render()
    await click('Connect via SSH')
    mocks.get.mockRejectedValueOnce(new Error('offline'))
    await confirmAccess()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.querySelector('input')).toBeNull()
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('enables inbound before SSH and stops when inbound fails', async () => {
    disabledStatus()
    const inbound = deferred<void>()
    mocks.inbound.mockReturnValueOnce(inbound.promise)
    await render(BoxState.STARTED, 'box-1', 0, NetworkMode.DISABLED)
    await openConnection()
    expect(mocks.post).not.toHaveBeenCalled()
    await act(async () => inbound.reject(new Error('private backend detail')))
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(document.querySelector('input')).toBeNull()
    expect(document.body.textContent).not.toContain('private backend detail')
  })

  it('keeps partial inbound success when a subsequent SSH operation fails', async () => {
    disabledStatus()
    mocks.post.mockRejectedValueOnce(new Error('upstream unavailable'))
    await render(BoxState.STARTED, 'box-1', 0, NetworkMode.DISABLED)
    await openConnection()
    expect(mocks.inbound).toHaveBeenCalledOnce()
    expect(mocks.inbound).toHaveBeenCalledWith('org-1', 'box-1', NetworkMode.ENABLED, undefined)
    expect(document.body.textContent).toContain('Any completed changes remain in place')
    expect(document.querySelector('input')).toBeNull()
  })

  it('rechecks failed setup before retrying the same key only when configuration is still missing', async () => {
    disabledStatus()
    mocks.post.mockRejectedValueOnce(missingConfig).mockRejectedValueOnce(new Error('sensitive request body'))
    await render()
    await openConnection()
    expect(document.body.textContent).toContain('SSH setup failed')
    expect(document.body.textContent).not.toContain('sensitive request body')
    expect(button('Download private key')).toBeDefined()
    expect(document.querySelector('input')).toBeNull()
    mocks.post.mockRejectedValueOnce(missingConfig)
    const readsBefore = mocks.get.mock.calls.length
    await confirmAccess()
    expect(mocks.get).toHaveBeenCalledTimes(readsBefore + 1)
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(mocks.post.mock.calls.map(([path]) => path)).toEqual([
      'v1/org-1/boxes/box-1/ssh/enable',
      'v1/org-1/boxes/box-1/ssh',
      'v1/org-1/boxes/box-1/ssh/enable',
      'v1/org-1/boxes/box-1/ssh',
    ])
    expect(mocks.post.mock.calls[1][1]).toBe(mocks.post.mock.calls[3][1])
    await fillPath('./saved-key')
    expect(document.body.textContent).toContain('box@boxlite-box-1')
  })

  it('uses saved configuration when reconnecting after disable and status refresh', async () => {
    await firstSetup()
    await fillPath('/tmp/saved-key')
    await click('Close')
    await toggleSsh()
    disabledStatus()
    await render(BoxState.STARTED, 'box-1', 1)
    const writesBefore = mocks.post.mock.calls.length
    const readsBefore = mocks.get.mock.calls.length
    await openConnection()
    expect(mocks.post.mock.calls.slice(writesBefore).map(([path]) => path)).toEqual(['v1/org-1/boxes/box-1/ssh/enable'])
    expect(mocks.get).toHaveBeenCalledTimes(readsBefore + 1)
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(button('Download private key')).toBeDefined()
    expect(document.querySelector('input')!.value).toBe('/tmp/saved-key')
    expect(document.body.textContent).toContain('box@boxlite-box-1')
  })

  it.each(['refresh', 'confirmation'])(
    'does not overwrite another client configuration observed during %s',
    async (observation) => {
      await firstSetup()
      await fillPath('/tmp/old-key')
      await click('Close')
      mocks.get.mockResolvedValue({ data: { ...status, generation: 5, host_public_key: 'other-client-host' } })
      if (observation === 'refresh') await render(BoxState.STARTED, 'box-1', 1)
      const writesBefore = mocks.post.mock.calls.length
      await openConnection()
      expect(mocks.post.mock.calls.slice(writesBefore)).toHaveLength(0)
      expect(document.body.textContent).not.toContain('Download private key')
      expect(document.querySelector('input')!.value).toBe('')
      expect(document.body.textContent).not.toContain('box@boxlite-box-1')
      await fillPath('/tmp/current-key')
      expect(document.body.textContent).toContain('box@boxlite-box-1')
      expect(document.body.textContent).not.toContain('Enter the private key path for the current configuration')
    },
  )

  it.each(['status', 'enable'])(
    'recovers a persisted failed setup from matching %s without another setup POST',
    async (recovery) => {
      disabledStatus()
      mocks.post.mockRejectedValueOnce(missingConfig).mockRejectedValueOnce(new Error('response lost'))
      await render()
      await openConnection()
      expect(button('Download private key')).toBeDefined()
      if (recovery === 'status') mocks.get.mockResolvedValue({ data: status })
      const writesBefore = mocks.post.mock.calls.length
      await confirmAccess()
      expect(mocks.post.mock.calls.slice(writesBefore).map(([path]) => path)).toEqual(
        recovery === 'status' ? [] : ['v1/org-1/boxes/box-1/ssh/enable'],
      )
      expect(mocks.generate).toHaveBeenCalledOnce()
      expect(button('Download private key')).toBeDefined()
      await fillPath('/tmp/recovered-key')
      expect(document.body.textContent).toContain('box@boxlite-box-1')
    },
  )

  it('does not replay a failed setup over a different current host', async () => {
    disabledStatus()
    mocks.post.mockRejectedValueOnce(missingConfig).mockRejectedValueOnce(new Error('response lost'))
    await render()
    await openConnection()
    mocks.get.mockResolvedValue({ data: { ...status, host_public_key: 'other-client-host' } })
    const writesBefore = mocks.post.mock.calls.length
    await confirmAccess()
    expect(mocks.post.mock.calls.slice(writesBefore)).toHaveLength(0)
    expect(document.body.textContent).not.toContain('Download private key')
    expect(document.querySelector('input')!.value).toBe('')
  })

  it('does not replay a failed setup when retrying Enable fails for another reason', async () => {
    disabledStatus()
    mocks.post.mockRejectedValueOnce(missingConfig).mockRejectedValueOnce(new Error('response lost'))
    await render()
    await openConnection()
    mocks.post.mockRejectedValueOnce(new Error('network unavailable'))
    const writesBefore = mocks.post.mock.calls.length
    await confirmAccess()
    expect(mocks.post.mock.calls.slice(writesBefore).map(([path]) => path)).toEqual(['v1/org-1/boxes/box-1/ssh/enable'])
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(button('Download private key')).toBeDefined()
    expect(document.querySelector('input')).toBeNull()
  })

  it('downloads the client key and preserves it on close without storing private material', async () => {
    await firstSetup()
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('boxlite-box-1-key')
    })
    await click('Download private key')
    const key = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(blobs[0])
    })
    expect(download).toHaveBeenCalledOnce()
    expect(key).toBe(credentials.privateKey)
    expect(document.body.textContent).not.toContain(credentials.privateKey)
    await fillPath('./saved-key')
    const persisted = Object.keys(sessionStorage)
      .map((key) => sessionStorage.getItem(key))
      .join('')
    expect(persisted).toContain('./saved-key')
    expect(persisted).not.toContain(credentials.privateKey)
    expect(persisted).not.toContain(credentials.config.host_private_key)
    await click('Close')
    mocks.get.mockResolvedValue({ data: status })
    await openConnection()
    expect(document.querySelector('input')!.value).toBe('./saved-key')
    expect(button('Download private key')).toBeDefined()
    expect(mocks.post).toHaveBeenCalledTimes(2)
  })

  it('restores the path on return but discards generated credentials on unmount', async () => {
    await firstSetup()
    await fillPath('/tmp/saved-key')
    await click('Hide commands')
    await act(async () => root.render(null))
    mocks.get.mockResolvedValue({ data: status })
    await render()
    await openConnection()
    expect(document.querySelector('input')!.value).toBe('/tmp/saved-key')
    expect(document.body.textContent).toContain('box@boxlite-box-1')
    expect(document.body.textContent).not.toContain('Download private key')
    expect(document.body.textContent).toContain('curl -fsSL')
    expect(document.body.textContent).toContain('Make sure this key is still authorized')
    expect(document.body.textContent).not.toContain('SSH settings changed')
    await fillPath('/tmp/updated-saved-key')
    await render(BoxState.STARTED, 'box-1', 1)
    expect(document.body.textContent).toContain('Make sure this key is still authorized')
    await click('Reset SSH configuration…')
    await click('Reset SSH configuration')
    expect(document.body.textContent).not.toContain('Make sure this key is still authorized')
  })

  it('does not show a restored-key reminder for an empty saved path or a fresh manual path', async () => {
    await render()
    await openConnection()
    await fillPath('/tmp/key')
    expect(document.body.textContent).not.toContain('Make sure this key is still authorized')
    await fillPath('')
    await act(async () => root.render(null))
    await render()
    await openConnection()
    expect(document.body.textContent).not.toContain('Make sure this key is still authorized')
  })

  it.each(['authorization', 'path'])(
    'describes the key input with its active %s notice and validation error',
    async (notice) => {
      await render()
      await openConnection()
      expect(keyPathDescription()).toContain('Find the private key file on your computer')
      await fillPath('/tmp/saved-key')
      await act(async () => root.render(null))
      if (notice === 'path') mocks.get.mockResolvedValue({ data: { ...status, host_public_key: 'other-host' } })
      await render()
      await openConnection()
      const expectedNotice =
        notice === 'authorization'
          ? 'Make sure this key is still authorized'
          : 'Enter the private key path for the current configuration'
      expect(keyPathDescription()).toContain(expectedNotice)
      expect(keyPathDescription()).toContain('Find the private key file on your computer')
      await fillPath('${HOME}/key')
      expect(keyPathDescription()).toContain('Use a file path without control characters')
      expect(document.querySelector('input')!.getAttribute('aria-invalid')).toBe('true')
      if (notice === 'authorization') expect(keyPathDescription()).toContain(expectedNotice)
      else expect(keyPathDescription()).not.toContain(expectedNotice)
      await fillPath('/tmp/current-key')
      expect(keyPathDescription()).not.toContain('Use a file path without control characters')
      expect(document.querySelector('input')!.getAttribute('aria-invalid')).toBe('false')
      await click('Reset SSH configuration…')
      await click('Reset SSH configuration')
      expect(keyPathDescription()).not.toContain(expectedNotice)
      expect(keyPathDescription()).toContain('Find the private key file on your computer')
    },
  )

  it('rejects an invalid key path without replacing the saved path and recovers after correction', async () => {
    await render()
    await openConnection()
    await fillPath('/tmp/saved-key')
    const preferenceKey = Object.keys(sessionStorage).find((key) => key.startsWith('boxlite:ssh:'))!
    const savedPreference = sessionStorage.getItem(preferenceKey)

    await fillPath('${HOME}/key')
    expect(document.querySelector('input')!.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Use a file path')
    expect(keyPathDescription()).toContain('Use a file path without control characters')
    expect(document.body.textContent).not.toContain('box@boxlite-box-1')
    expect(sessionStorage.getItem(preferenceKey)).toBe(savedPreference)

    await fillPath('/tmp/corrected key')
    expect(document.querySelector('input')!.getAttribute('aria-invalid')).toBe('false')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain("ssh -i '/tmp/corrected key'")
    expect(JSON.parse(sessionStorage.getItem(preferenceKey)!).keyPath).toBe('/tmp/corrected key')
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('reports clipboard rejection, retries the displayed command and resets feedback when the path changes', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('clipboard denied')).mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await render()
    await openConnection()
    await fillPath('/tmp/first-key')
    const commandBlock = [...document.querySelectorAll('pre')].find((pre) =>
      pre.textContent?.includes('box@boxlite-box-1'),
    )!.parentElement!
    const copyButton = commandBlock.querySelector('button')!
    const firstCommand = commandBlock.querySelector('pre')!.textContent

    await act(async () => copyButton.click())
    expect(copyButton.textContent).toBe('Copy failed — retry')
    expect(writeText).toHaveBeenLastCalledWith(firstCommand)
    await act(async () => copyButton.click())
    expect(copyButton.textContent).toBe('Copied')
    expect(writeText).toHaveBeenLastCalledWith(firstCommand)

    await fillPath('/tmp/second-key')
    const updatedBlock = [...document.querySelectorAll('pre')].find((pre) =>
      pre.textContent?.includes('box@boxlite-box-1'),
    )!.parentElement!
    const updatedButton = updatedBlock.querySelector('button')!
    expect(updatedButton.textContent).toBe('Copy')
    const updatedCommand = updatedBlock.querySelector('pre')!.textContent
    expect(updatedCommand).not.toBe(firstCommand)
    await act(async () => updatedButton.click())
    expect(writeText).toHaveBeenLastCalledWith(updatedCommand)
    expect(updatedButton.textContent).toBe('Copied')
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('keeps connection paths in memory only when the authenticated user identity is absent', async () => {
    await render()
    await openConnection()
    await fillPath('/tmp/authenticated-key')
    const savedPreferences = Object.fromEntries(
      Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
    )
    await act(async () => root.render(null))
    mocks.user = ''
    const readPreference = vi.spyOn(Storage.prototype, 'getItem')
    const writePreference = vi.spyOn(Storage.prototype, 'setItem')

    await render()
    await openConnection()
    expect(document.querySelector('input')!.value).toBe('')
    await fillPath('/tmp/session-only-key')
    expect(document.body.textContent).toContain("ssh -i '/tmp/session-only-key'")
    expect(readPreference).not.toHaveBeenCalled()
    expect(writePreference).not.toHaveBeenCalled()
    await act(async () => root.render(null))
    await render()
    await openConnection()
    expect(document.querySelector('input')!.value).toBe('')
    expect(writePreference).not.toHaveBeenCalled()
    readPreference.mockRestore()
    expect(Object.fromEntries(Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]))).toEqual(
      savedPreferences,
    )
  })

  it('isolates reset confirmation and preserves the path when cancelled', async () => {
    await render()
    await openConnection()
    await fillPath('/tmp/existing key')
    expect(document.body.textContent).toContain("ssh -i '/tmp/existing key'")
    await click('Reset SSH configuration…')
    expect(document.querySelector('[role="dialog"] ol')).toBeNull()
    expect(document.querySelector('input')).toBeNull()
    expect(document.body.textContent).toContain('disconnects existing clients')
    await click('Cancel')
    expect(document.querySelector('input')!.value).toBe('/tmp/existing key')
    expect(mocks.post).not.toHaveBeenCalled()
    await click('Reset SSH configuration…')
    await click('Reset SSH configuration')
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(document.querySelector('input')!.value).toBe('')
    expect(mocks.post).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh', credentials.config, { timeout: 30_000 })
  })

  it('rechecks the existing configuration after reset cannot enable inbound', async () => {
    await render()
    await openConnection()
    await render(BoxState.STARTED, 'box-1', 0, NetworkMode.DISABLED)
    mocks.generate.mockResolvedValueOnce({ ...credentials, hostPublicKey: 'replacement-host' })
    mocks.inbound.mockRejectedValueOnce(new Error('offline'))
    await click('Reset SSH configuration…')
    await click('Reset SSH configuration')
    expect(document.body.textContent).not.toContain('Download private key')
    expect(document.querySelector('input')).not.toBeNull()
    expect(mocks.post).not.toHaveBeenCalled()
    await click('Review access')
    await confirmAccess()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(mocks.post).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Download private key')
    expect(document.querySelector('input')).not.toBeNull()
  })

  it('retains the usable key and path when replacement generation fails', async () => {
    await firstSetup()
    await fillPath('./saved-key')
    mocks.generate.mockRejectedValueOnce(new Error('crypto unavailable'))
    await click('Reset SSH configuration…')
    await click('Reset SSH configuration')
    expect(button('Download private key')).toBeDefined()
    expect(document.querySelector('input')!.value).toBe('./saved-key')
    expect(document.body.textContent).toContain('box@boxlite-box-1')
    expect(mocks.post).toHaveBeenCalledTimes(2)
  })

  it('renders the shared sidebar switch and changes saved configuration without setup or inbound', async () => {
    disabledStatus()
    const slot = document.createElement('div')
    document.body.append(slot)
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <BoxSshTab box={{ id: 'box-1', state: BoxState.STARTED } as Box} statusContainer={slot} />
          </QueryClientProvider>,
        ),
      )
      expect(slot.querySelector('[aria-label="SSH access"]')).not.toBeNull()
      await toggleSsh()
      expect(mocks.post).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh/enable', undefined, { timeout: 30_000 })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      await toggleSsh()
      expect(mocks.delete).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh', { timeout: 30_000 })
      expect(mocks.generate).not.toHaveBeenCalled()
      expect(mocks.inbound).not.toHaveBeenCalled()
    } finally {
      slot.remove()
    }
  })

  it('opens entry confirmation on sidebar failure without generating keys', async () => {
    disabledStatus()
    await render()
    mocks.post.mockRejectedValueOnce(missingConfig)
    await toggleSsh()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector('input')).toBeNull()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.post).toHaveBeenCalledOnce()
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('recovers confirmed keys after disable, refresh and enable without setup', async () => {
    await firstSetup()
    await fillPath('./saved-key')
    await toggleSsh()
    disabledStatus()
    await render(BoxState.STARTED, 'box-1', 1)
    await toggleSsh()
    expect(document.body.textContent).toContain('box@boxlite-box-1')
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(mocks.post).toHaveBeenCalledTimes(3)
  })

  it('refreshes on focus without interrupting a pending mutation', async () => {
    disabledStatus()
    await render()
    mocks.get.mockResolvedValue({ data: status })
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(document.querySelector('[aria-label="SSH access"]')!.getAttribute('aria-checked')).toBe('true')
    const pending = deferred<{ data: typeof status }>()
    mocks.delete.mockReturnValueOnce(pending.promise)
    await toggleSsh()
    const reads = mocks.get.mock.calls.length
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(mocks.get).toHaveBeenCalledTimes(reads)
    await act(async () => pending.resolve({ data: { ...status, enabled: false } }))
  })

  it('defers a detail refresh until Disable commits and makes the next toggle Enable', async () => {
    await render()
    const pending = deferred<{ data: typeof status }>()
    mocks.delete.mockReturnValueOnce(pending.promise)
    await toggleSsh()
    const readsBefore = mocks.get.mock.calls.length
    await render(BoxState.STARTED, 'box-1', 1)
    expect(mocks.get).toHaveBeenCalledTimes(readsBefore)
    disabledStatus()
    await act(async () => pending.resolve({ data: { ...status, enabled: false, host_public_key: '' } }))
    expect(document.querySelector('[aria-label="SSH access"]')!.getAttribute('aria-checked')).toBe('false')
    expect(mocks.get).toHaveBeenCalledTimes(readsBefore + 1)
    await toggleSsh()
    expect(mocks.delete).toHaveBeenCalledOnce()
    expect(mocks.post).toHaveBeenLastCalledWith('v1/org-1/boxes/box-1/ssh/enable', undefined, { timeout: 30_000 })
  })

  it('retains the current downloadable key and path when Reset fails before configuration submission', async () => {
    await firstSetup()
    await fillPath('/tmp/original-key')
    await render(BoxState.STARTED, 'box-1', 0, NetworkMode.DISABLED)
    mocks.generate.mockResolvedValueOnce({
      ...credentials,
      privateKey: 'replacement-key',
      hostPublicKey: 'replacement-host',
    })
    mocks.inbound.mockRejectedValueOnce(new Error('inbound unavailable'))
    const writesBefore = mocks.post.mock.calls.length
    await click('Reset SSH configuration…')
    await click('Reset SSH configuration')
    expect(mocks.post).toHaveBeenCalledTimes(writesBefore)
    mocks.get.mockResolvedValue({ data: status })
    await act(async () => window.dispatchEvent(new Event('focus')))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    await click('Download private key')
    const downloaded = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(blobs[0])
    })
    expect(downloaded).toBe(credentials.privateKey)
    expect(document.querySelector('input')!.value).toBe('/tmp/original-key')
  })

  it('warns about changed client authorization when an external configuration reuses the host key', async () => {
    await firstSetup()
    await fillPath('/tmp/saved-key')
    mocks.get.mockResolvedValue({ data: { ...status, generation: status.generation + 1 } })
    await render(BoxState.STARTED, 'box-1', 1)
    expect(document.body.textContent).toContain('Make sure this key is still authorized')
    expect(button('Download private key')).toBeDefined()
    expect(document.querySelector('input')!.value).toBe('/tmp/saved-key')
  })

  it('retains an authorization warning observed while disabled through local Enable', async () => {
    await firstSetup()
    await fillPath('/tmp/saved-key')
    mocks.get.mockResolvedValue({
      data: { ...status, enabled: false, generation: 3, host_public_key: '', host_key_fingerprint: '' },
    })
    await render(BoxState.STARTED, 'box-1', 1)
    mocks.post.mockResolvedValueOnce({ data: { ...status, generation: 4 } })
    await toggleSsh()
    expect(document.body.textContent).toContain('Make sure this key is still authorized')
    expect(document.querySelector('input')!.value).toBe('/tmp/saved-key')
  })

  it.each(['old host', 'replacement host'])(
    'retains both keys after rejected Reset until observing %s',
    async (host) => {
      await firstSetup()
      await fillPath('/tmp/original-key')
      const replacement = {
        ...credentials,
        hostPublicKey: 'replacement-host',
        privateKey: 'replacement-client-key',
        config: { ...credentials.config, host_private_key: 'replacement-host-key' },
      }
      mocks.generate.mockResolvedValueOnce(replacement)
      mocks.post.mockRejectedValueOnce(new Error('request rejected or response lost'))
      await click('Reset SSH configuration…')
      await click('Reset SSH configuration')
      const filenames: string[] = []
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        filenames.push(this.download)
      })
      await click('Download private key')
      const readBlob = (blob: Blob) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.readAsText(blob)
        })
      expect(await readBlob(blobs[0])).toBe(credentials.privateKey)
      await click('Download replacement key')
      expect(await readBlob(blobs[1])).toBe(replacement.privateKey)
      expect(filenames).toEqual(['boxlite-box-1-key', 'boxlite-box-1-key-replacement'])
      const writesBefore = mocks.post.mock.calls.length
      mocks.get.mockResolvedValue({
        data: host === 'old host' ? status : { ...status, host_public_key: replacement.hostPublicKey },
      })
      await click('Refresh status')
      await confirmAccess()
      await click('Download private key')
      expect(await readBlob(blobs[2])).toBe(host === 'old host' ? credentials.privateKey : replacement.privateKey)
      expect(document.querySelector('input')!.value).toBe(host === 'old host' ? '/tmp/original-key' : '')
      expect(mocks.post).toHaveBeenCalledTimes(writesBefore)
      if (host === 'old host') {
        expect(button('Download replacement key')).toBeDefined()
        mocks.get.mockResolvedValue({ data: { ...status, host_public_key: replacement.hostPublicKey } })
        await render(BoxState.STARTED, 'box-1', 1)
        await click('Download private key')
        expect(await readBlob(blobs[3])).toBe(replacement.privateKey)
        expect(document.querySelector('input')!.value).toBe('')
      }
    },
  )

  it.each(['confirmed Reset', 'missing configuration'])(
    'reuses the unresolved replacement for %s without generating a third key',
    async (retry) => {
      await firstSetup()
      const replacement = {
        ...credentials,
        hostPublicKey: 'replacement-host',
        privateKey: 'replacement-key',
        config: { ...credentials.config, host_private_key: 'replacement-host-key' },
      }
      mocks.generate.mockResolvedValueOnce(replacement)
      mocks.post.mockRejectedValueOnce(new Error('response lost'))
      await click('Reset SSH configuration…')
      await click('Reset SSH configuration')
      const submittedConfig = mocks.post.mock.calls.at(-1)![1]
      mocks.post.mockResolvedValue({ data: { ...status, host_public_key: replacement.hostPublicKey } })
      if (retry === 'confirmed Reset') {
        await click('Reset SSH configuration…')
        await click('Reset SSH configuration')
      } else {
        disabledStatus()
        mocks.post.mockRejectedValueOnce(missingConfig)
        await click('Refresh status')
        await confirmAccess()
      }
      expect(mocks.generate).toHaveBeenCalledTimes(2)
      expect(mocks.post).toHaveBeenLastCalledWith('v1/org-1/boxes/box-1/ssh', submittedConfig, { timeout: 30_000 })
      expect(button('Download private key')).toBeDefined()
      expect(document.body.textContent).not.toContain('Download replacement key')
      const saved = Object.keys(sessionStorage)
        .map((key) => sessionStorage.getItem(key))
        .join('')
      expect(saved).not.toContain(credentials.privateKey)
      expect(saved).not.toContain(replacement.privateKey)
    },
  )

  it('does not infer an authorization change from its own Disable and Enable', async () => {
    await firstSetup()
    await fillPath('/tmp/saved-key')
    await toggleSsh()
    mocks.post.mockResolvedValueOnce({ data: { ...status, generation: status.generation + 1 } })
    await toggleSsh()
    expect(document.body.textContent).not.toContain('Make sure this key is still authorized')
    expect(document.querySelector('input')!.value).toBe('/tmp/saved-key')
  })

  it.each(['status', 'enable'])(
    'warns that recovered replacement authorization is unverified after %s',
    async (recovery) => {
      await firstSetup()
      const replacement = {
        ...credentials,
        hostPublicKey: 'replacement-host',
        config: { ...credentials.config, host_private_key: 'replacement-host-key' },
      }
      mocks.generate.mockResolvedValueOnce(replacement)
      mocks.post.mockRejectedValueOnce(new Error('response lost'))
      await click('Reset SSH configuration…')
      await click('Reset SSH configuration')
      const recoveredStatus = { ...status, host_public_key: replacement.hostPublicKey, generation: 4 }
      if (recovery === 'status') {
        mocks.get.mockResolvedValue({ data: recoveredStatus })
      } else {
        disabledStatus()
        mocks.post.mockResolvedValueOnce({ data: recoveredStatus })
      }
      const writesBefore = mocks.post.mock.calls.length
      await confirmAccess()
      expect(document.body.textContent).toContain('Make sure this key is still authorized')
      expect(button('Download private key')).toBeDefined()
      expect(document.body.textContent).not.toContain('Download replacement key')
      expect(mocks.post.mock.calls.slice(writesBefore).map(([path]) => path)).toEqual(
        recovery === 'status' ? [] : ['v1/org-1/boxes/box-1/ssh/enable'],
      )
      await fillPath('/tmp/recovered-replacement-key')
      expect(document.body.textContent).toContain('Make sure this key is still authorized')
      mocks.get.mockResolvedValue({ data: recoveredStatus })
      await render(BoxState.STARTED, 'box-1', 1)
      expect(document.body.textContent).toContain('Make sure this key is still authorized')
      mocks.generate.mockResolvedValueOnce({ ...replacement, hostPublicKey: 'acknowledged-host' })
      mocks.post.mockResolvedValueOnce({
        data: { ...status, host_public_key: 'acknowledged-host', generation: 5 },
      })
      await click('Reset SSH configuration…')
      await click('Reset SSH configuration')
      expect(document.body.textContent).not.toContain('Make sure this key is still authorized')
    },
  )

  it('accepts an acknowledged replacement Setup without an unverified-authorization warning', async () => {
    await firstSetup()
    mocks.generate.mockResolvedValueOnce({ ...credentials, hostPublicKey: 'replacement-host' })
    mocks.post.mockResolvedValueOnce({ data: { ...status, host_public_key: 'replacement-host', generation: 2 } })
    await click('Reset SSH configuration…')
    await click('Reset SSH configuration')
    expect(button('Download private key')).toBeDefined()
    expect(document.body.textContent).not.toContain('Make sure this key is still authorized')
  })

  it('offers an explicit confirmed reset after Enable fails without replacing configuration on cancel', async () => {
    disabledStatus()
    await render()
    mocks.post.mockRejectedValueOnce(new Error('listen address in use'))
    await toggleSsh()
    await click('Reset SSH configuration…')
    expect(document.body.textContent).toContain('disconnects existing clients')
    await click('Cancel')
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.post).toHaveBeenCalledOnce()
    await click('Reset SSH configuration…')
    await click('Reset SSH configuration')
    expect(mocks.post).toHaveBeenLastCalledWith('v1/org-1/boxes/box-1/ssh', credentials.config, { timeout: 30_000 })
    expect(button('Download private key')).toBeDefined()
  })

  it.each(['success', 'failure'])('ignores a pending copy %s after the displayed command changes', async (outcome) => {
    const pending = deferred<void>()
    const writeText = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await render()
    await openConnection()
    await fillPath('/tmp/old-key')
    const block = [...document.querySelectorAll('pre')].find((pre) =>
      pre.textContent?.includes('box@boxlite-box-1'),
    )!.parentElement!
    await act(async () => block.querySelector('button')!.click())
    await fillPath('/tmp/new-key')
    await act(async () => (outcome === 'success' ? pending.resolve() : pending.reject(new Error('denied'))))
    const currentBlock = [...document.querySelectorAll('pre')].find((pre) =>
      pre.textContent?.includes('box@boxlite-box-1'),
    )!.parentElement!
    expect(currentBlock.querySelector('button')!.textContent).toBe('Copy')
    await act(async () => currentBlock.querySelector('button')!.click())
    expect(currentBlock.querySelector('button')!.textContent).toBe('Copied')
    expect(writeText).toHaveBeenLastCalledWith(currentBlock.querySelector('pre')!.textContent)
  })

  it.each([
    'stored SSH configuration is missing a host private key',
    'SSH configuration is required for this operation but could not be loaded',
    'SSH has no saved configuration for this account',
    'invalid state: SSH enable: status: FailedPrecondition, message: "stored SSH configuration is missing a host private key", details: [], metadata: MetadataMap { headers: {} }',
    'invalid state: SSH enable: status: FailedPrecondition, message: "stored SSH configuration is missing a host private key", details: [], metadata: MetadataMap { headers: {"content-type": "application/grpc"} }',
  ])('does not replace saved configuration after an ambiguous diagnostic: %s', async (message) => {
    disabledStatus()
    await render()
    mocks.post.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { error: { message } } } })
    await openConnection()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.post).toHaveBeenCalledOnce()
    expect(document.querySelector('input')).toBeNull()
  })

  it.each(['status', 'inbound', 'keys'])('stops preparation if the box stops during %s', async (phase) => {
    disabledStatus()
    const pendingRead = deferred<{ data: typeof status }>()
    const pendingInbound = deferred<void>()
    const pendingKeys = deferred<typeof credentials>()
    await render(BoxState.STARTED, 'box-1', 0, phase === 'inbound' ? NetworkMode.DISABLED : NetworkMode.ENABLED)
    if (phase === 'status') mocks.get.mockReturnValueOnce(pendingRead.promise)
    if (phase === 'inbound') mocks.inbound.mockReturnValueOnce(pendingInbound.promise)
    if (phase === 'keys') {
      mocks.post.mockRejectedValueOnce(missingConfig)
      mocks.generate.mockReturnValueOnce(pendingKeys.promise)
    }
    await openConnection()
    await render(BoxState.STOPPED)
    await act(async () => {
      pendingRead.resolve({ data: status })
      pendingInbound.resolve()
      pendingKeys.resolve(credentials)
    })
    expect(mocks.post.mock.calls.filter(([path]) => !path.endsWith('/enable'))).toHaveLength(0)
    expect(document.body.textContent).toContain('Start the box')
    expect(document.querySelector('input')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[aria-label="SSH access"]')!.disabled).toBe(true)
  })

  it('blocks duplicate confirmation and closing during preparation', async () => {
    const pending = deferred<{ data: typeof status }>()
    await render()
    mocks.get.mockReturnValueOnce(pending.promise)
    await openConnection()
    expect(button('Preparing…').disabled).toBe(true)
    await click('Preparing…')
    await click('Close')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(mocks.get).toHaveBeenCalledTimes(2)
    await act(async () => pending.resolve({ data: status }))
    expect(document.querySelector('input')).not.toBeNull()
    await click('Close')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it.each(['success', 'failure'])('ignores a stale status %s after refresh', async (outcome) => {
    const pending = deferred<{ data: typeof status }>()
    mocks.get.mockReturnValueOnce(pending.promise)
    await render()
    await render(BoxState.STARTED, 'box-1', 1)
    await act(async () =>
      outcome === 'success'
        ? pending.resolve({ data: { ...status, enabled: false } })
        : pending.reject(new Error('stale')),
    )
    expect(document.querySelector('[aria-label="SSH access"]')!.getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it.each(['success', 'failure'])('ignores stale preparation %s after the box stops', async (outcome) => {
    disabledStatus()
    const pending = deferred<{ data: typeof status }>()
    await render()
    mocks.post.mockReturnValueOnce(pending.promise)
    await openConnection()
    await render(BoxState.STOPPED, 'box-1', 1)
    await act(async () =>
      outcome === 'success' ? pending.resolve({ data: status }) : pending.reject(new Error('stale')),
    )
    expect(document.querySelector('[aria-label="SSH access"]')!.getAttribute('aria-checked')).toBe('false')
    expect(document.querySelector('input')).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('does not read without an organization and blocks stopped boxes', async () => {
    mocks.organization = ''
    await render()
    expect(host.textContent).toBe('')
    expect(mocks.get).not.toHaveBeenCalled()
    mocks.organization = 'org-1'
    await render(BoxState.STOPPED)
    await click('Connect via SSH')
    expect(button('Continue').disabled).toBe(true)
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('blocks read-only connection even when SSH and inbound are already enabled', async () => {
    mocks.permitted = false
    await render()
    await click('Connect via SSH')
    const readsBefore = mocks.get.mock.calls.length
    await confirmAccess()
    expect(document.querySelector('input')).toBeNull()
    expect(button('Continue').disabled).toBe(true)
    expect(mocks.get).toHaveBeenCalledTimes(readsBefore)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.inbound).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('hides connection commands when write permission is revoked from an open guide', async () => {
    await render()
    await openConnection()
    await fillPath('/tmp/key')
    expect(document.body.textContent).toContain('box@boxlite-box-1')
    mocks.permitted = false
    await render()
    expect(document.body.textContent).not.toContain('box@boxlite-box-1')
    expect(document.querySelector('input')).toBeNull()
    expect(button('Continue').disabled).toBe(true)
  })

  it('keeps unknown status non-actionable and permits manual refresh', async () => {
    mocks.get.mockRejectedValueOnce(new Error('unavailable'))
    await render()
    await click('Connect via SSH')
    expect(button('Enable and continue').disabled).toBe(true)
    expect(document.body.textContent).toContain('Unable to read SSH status')
    await click('Refresh status')
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(button('Continue').disabled).toBe(false)
  })

  it.each(['organization', 'box', 'user', 'endpoint'])('isolates credentials and paths by %s', async (scope) => {
    await firstSetup()
    await fillPath('/tmp/original-key')
    if (scope === 'organization') mocks.organization = 'org-2'
    if (scope === 'user') mocks.user = 'user-2'
    if (scope === 'endpoint') mocks.endpoint = 'https://other.example.test'
    mocks.get.mockResolvedValue({ data: status })
    await render(BoxState.STARTED, scope === 'box' ? 'box-2' : 'box-1')
    await openConnection()
    expect(document.querySelector('input')!.value).toBe('')
    expect(document.body.textContent).not.toContain('Download private key')
  })

  it('retains paths while disabled, but clears them when the host identity changes', async () => {
    await render()
    await openConnection()
    await fillPath('/tmp/original-key')
    await act(async () => root.render(null))
    disabledStatus()
    await render()
    mocks.post.mockResolvedValueOnce({ data: { ...status, host_public_key: 'different-host' } })
    await openConnection()
    expect(document.querySelector('input')!.value).toBe('')
    expect(document.body.textContent).not.toContain('box@boxlite-box-1')
    expect(document.body.textContent).toContain('Enter the private key path for the current configuration')
    expect(document.body.textContent).not.toContain('Make sure this key is still authorized')
    await fillPath('/tmp/new-key')
    mocks.get.mockResolvedValue({ data: { ...status, host_public_key: 'different-host' } })
    await render(BoxState.STARTED, 'box-1', 1)
    expect(document.querySelector('input')!.value).toBe('/tmp/new-key')
    mocks.get.mockResolvedValue({ data: status })
    await render(BoxState.STARTED, 'box-1', 2)
    expect(document.querySelector('input')!.value).toBe('')
  })

  it('expands CLI on every entry and ignores legacy collapsed preferences', async () => {
    await render()
    await openConnection()
    expect(document.body.textContent).toContain('curl -fsSL')
    await click('Hide commands')
    expect(document.body.textContent).not.toContain('curl -fsSL')
    await render(BoxState.STARTED, 'box-1', 1)
    expect(document.body.textContent).not.toContain('curl -fsSL')
    await click('Close')
    await openConnection()
    expect(document.body.textContent).toContain('curl -fsSL')
    await fillPath('/tmp/saved-key')
    for (const key of Object.keys(sessionStorage)) {
      sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(key)!), cliCollapsed: true }))
    }
    await act(async () => root.render(null))
    await render()
    await openConnection()
    expect(document.body.textContent).toContain('curl -fsSL')
    expect(document.querySelector('input')!.value).toBe('/tmp/saved-key')
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('continues when session storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    await render()
    await openConnection()
    await fillPath('/tmp/existing-key')
    expect(document.body.textContent).toContain('box@boxlite-box-1')
  })
})
