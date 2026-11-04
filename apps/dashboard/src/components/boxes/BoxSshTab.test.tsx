// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Box, BoxState } from '@boxlite-ai/api-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoxSshTab } from './BoxSshTab'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  generate: vi.fn(),
  organization: 'org-1',
  permitted: true,
}))
vi.mock('@/hooks/useApi', () => {
  const api = { axiosInstance: { get: mocks.get, post: mocks.post, delete: mocks.delete } }
  return { useApi: () => api }
})
vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ apiUrl: 'https://api.example.test', oidc: { issuer: '' } }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: mocks.organization },
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
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}
async function click(label: string) {
  await act(async () => button(label).click())
}
async function render(state = BoxState.STARTED, id = 'box-1') {
  await act(async () => root.render(<BoxSshTab box={{ id, state } as Box} />))
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
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('BoxSshTab', () => {
  it('sets up once, downloads the client key, and reopens details without reconfiguring', async () => {
    await render()
    await click('Setup')
    expect(mocks.post).not.toHaveBeenCalled()
    await click('Set up SSH')
    expect(mocks.post).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh', credentials.config, { timeout: 30_000 })
    expect(document.body.textContent).toContain('box@boxlite-box-1')
    expect(document.body.textContent).toContain('ssh --proxy --')
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
    await render()
    await click('Enable')
    expect(mocks.post).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh/enable', undefined, { timeout: 30_000 })
    expect(host.textContent).toContain('SSH enabled')
    await click('Disable')
    expect(mocks.delete).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh', { timeout: 30_000 })
    expect(host.textContent).toContain('SSH disabled')
    expect(mocks.generate).not.toHaveBeenCalled()
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
