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

const status = {
  enabled: true,
  generation: 1,
  listen_address: '0.0.0.0:22',
  host_public_key: 'public-host',
  host_key_fingerprint: 'SHA256:test-fingerprint',
}
let root: Root
let host: HTMLDivElement
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}
async function click(label: string) {
  await act(async () => button(label).click())
}
async function render(state = BoxState.STARTED, id = 'box-1', refreshSignal = 0, statusContainer?: HTMLDivElement) {
  await act(async () =>
    root.render(
      <BoxSshTab box={{ id, state } as Box} refreshSignal={refreshSignal} statusContainer={statusContainer} />,
    ),
  )
}
function deferred<T>() {
  return Promise.withResolvers<T>()
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  mocks.organization = 'org-1'
  mocks.user = 'user-1'
  mocks.endpoint = 'https://api.example.test'
  mocks.permitted = true
  mocks.get.mockReset().mockResolvedValue({ data: status })
  mocks.post.mockReset().mockResolvedValue({ data: status })
  mocks.delete.mockReset().mockResolvedValue({ data: { ...status, enabled: false } })
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

function disabledStatus() {
  mocks.get.mockResolvedValue({ data: { ...status, enabled: false, host_public_key: '', host_key_fingerprint: '' } })
}
async function toggleSsh() {
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="SSH access"]')!.click())
}

describe('SSH BoxSshTab static guide and saved access', () => {
  it('offers direct CLI SSH immediately without configuring SSH in the browser', async () => {
    await render()
    await click('Connect via SSH')
    const commands = [...document.querySelectorAll('pre')].map((node) => node.textContent)
    expect(commands).toEqual([
      'curl -fsSL https://sh.boxlite.ai | sh\nexport PATH="$HOME/.local/bin:$PATH"',
      'boxlite auth login',
      'boxlite ssh box-1',
    ])
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain(
      'Select the API-key method, then enter an API key ↗ for this organization when prompted.',
    )
    expect(dialog.querySelector('a[href="/dashboard/keys"]')).not.toBeNull()
    expect(dialog.textContent).toContain(
      'First setup can replace existing SSH access and disconnect clients. Exiting SSH leaves its public tunnel open.',
    )
    const docs = dialog.querySelectorAll('a[href="https://docs.boxlite.ai/cloud/ssh"]')
    expect(docs).toHaveLength(1)
    expect(docs[0].parentElement!.textContent).toBe(
      'For self-hosted endpoints, other organizations or an existing CLI setup, follow the SSH guide ↗.',
    )
    expect(docs[0].parentElement!.classList.contains('text-meta')).toBe(true)
    expect(docs[0].parentElement!.classList.contains('text-muted-foreground')).toBe(true)
    expect(document.querySelector('input')).toBeNull()
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.inbound).not.toHaveBeenCalled()
  })

  it('copies the displayed connection command, reports failure and permits retry without writes', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await render()
    await click('Connect via SSH')
    const connect = document.querySelectorAll('pre')[2]
    const copy = connect.parentElement!.querySelector('button')!
    await act(async () => copy.click())
    expect(copy.textContent).toBe('Copy failed — retry')
    await act(async () => copy.click())
    expect(writeText).toHaveBeenLastCalledWith(connect.textContent)
    expect(copy.textContent).toBe('Copied')
    await click('Close')
    await click('Connect via SSH')
    expect(document.querySelectorAll('pre')[2].parentElement!.querySelector('button')!.textContent).toBe('Copy')
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.delete).not.toHaveBeenCalled()
    expect(mocks.inbound).not.toHaveBeenCalled()
  })

  it('keeps static guidance readable when the Box stops or write permission is revoked', async () => {
    await render()
    await click('Connect via SSH')
    const guide = document.querySelector('[role="dialog"]')!.textContent
    mocks.permitted = false
    await render(BoxState.STOPPED)
    expect(document.querySelector('[role="dialog"]')!.textContent).toBe(guide)
    expect(document.querySelector('[aria-label="SSH access"]')).toBeNull()
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('keeps unknown status non-actionable without blocking the static guide', async () => {
    mocks.get.mockRejectedValueOnce(new Error('unavailable'))
    await render()
    await click('Connect via SSH')
    expect(document.querySelector<HTMLButtonElement>('[aria-label="SSH access"]')!.disabled).toBe(true)
    expect(document.querySelectorAll('pre')[2].textContent).toContain('ssh box-1')
    await act(async () => document.querySelector<HTMLButtonElement>('[title="Refresh SSH status"]')!.click())
    expect(document.querySelector<HTMLButtonElement>('[aria-label="SSH access"]')!.disabled).toBe(false)
  })

  it('renders the shared sidebar switch and changes saved configuration without setup or inbound', async () => {
    disabledStatus()
    const slot = document.createElement('div')
    document.body.append(slot)
    try {
      await render(BoxState.STARTED, 'box-1', 0, slot)
      expect(slot.querySelector('[aria-label="SSH access"]')).not.toBeNull()
      await toggleSsh()
      expect(mocks.post).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh/enable', undefined, { timeout: 30_000 })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      await toggleSsh()
      expect(mocks.delete).toHaveBeenCalledWith('v1/org-1/boxes/box-1/ssh', { timeout: 30_000 })
      expect(mocks.inbound).not.toHaveBeenCalled()
    } finally {
      slot.remove()
    }
  })

  it.each([{ message: 'SSH has no saved configuration' }, { error: { message: 'SSH configuration is required' } }])(
    'opens CLI guidance for missing configuration without configuring keys',
    async (data) => {
      disabledStatus()
      await render()
      mocks.post.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data } })
      await toggleSsh()
      expect(document.querySelectorAll('pre')[2].textContent).toContain('ssh box-1')
      expect(mocks.post).toHaveBeenCalledOnce()
      expect(document.querySelector('input')).toBeNull()
      await act(async () => window.dispatchEvent(new Event('focus')))
      expect(document.querySelector('[role="alert"]')).not.toBeNull()
    },
  )

  it.each([401, 403, 503])('retains an enable error without opening setup for HTTP %s', async (httpStatus) => {
    disabledStatus()
    await render()
    mocks.post.mockRejectedValueOnce({ isAxiosError: true, response: { status: httpStatus } })
    await toggleSsh()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(mocks.post).toHaveBeenCalledOnce()
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

  it.each(['success', 'failure'])('ignores a stale mutation %s after the Box stops', async (outcome) => {
    await render()
    const pending = deferred<{ data: typeof status }>()
    mocks.delete.mockReturnValueOnce(pending.promise)
    await toggleSsh()
    disabledStatus()
    await render(BoxState.STOPPED, 'box-1', 1)
    await act(async () =>
      outcome === 'success' ? pending.resolve({ data: status }) : pending.reject(new Error('stale')),
    )
    expect(document.querySelector('[aria-label="SSH access"]')!.getAttribute('aria-checked')).toBe('false')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[aria-label="SSH access"]')!.disabled).toBe(true)
  })

  it.each(['organization', 'box', 'user', 'endpoint'])('discards an open guide when %s changes', async (scope) => {
    await render()
    await click('Connect via SSH')
    if (scope === 'organization') mocks.organization = 'org-2'
    if (scope === 'user') mocks.user = 'user-2'
    if (scope === 'endpoint') mocks.endpoint = 'https://other.example.test'
    await render(BoxState.STARTED, scope === 'box' ? 'box-2' : 'box-1')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click('Connect via SSH')
    expect(document.querySelectorAll('pre')[1].textContent).toBe('boxlite auth login')
    expect(document.querySelectorAll('pre')[2].textContent).toBe(
      scope === 'box' ? 'boxlite ssh box-2' : 'boxlite ssh box-1',
    )
    expect(mocks.get).toHaveBeenLastCalledWith(
      `v1/${mocks.organization}/boxes/${scope === 'box' ? 'box-2' : 'box-1'}/ssh`,
      { timeout: 30_000 },
    )
  })

  it('does not read without an organization and blocks mutations for stopped Boxes', async () => {
    mocks.organization = ''
    await render()
    expect(host.textContent).toBe('')
    expect(mocks.get).not.toHaveBeenCalled()
    mocks.organization = 'org-1'
    await render(BoxState.STOPPED)
    await toggleSsh()
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.delete).not.toHaveBeenCalled()
  })
})
