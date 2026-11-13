// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Box, BoxState, NetworkMode } from '@boxlite-ai/api-client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { BoxNetworkSection } from './BoxNetworkSection'
import { TunnelRequestError } from '@/api/tunnel'

const mocks = vi.hoisted(() => ({
  api: {
    setBoxInboundMode: vi.fn(),
    prepareBoxTunnel: vi.fn(),
    revokeBoxTunnel: vi.fn(),
    boxApi: { getBox: vi.fn() },
  },
  org: 'org-1',
  success: vi.fn(),
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: mocks.org } }),
}))
vi.mock('./BoxDomainBindings', () => ({ BoxDomainBindings: () => null }))
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: vi.fn() } }))
vi.mock('@/components/CopyButton', () => ({
  CopyButton: ({ value }: { value: string }) => <button data-copy={value}>Copy</button>,
}))
const initialApi = mocks.api
let canManage = true
let root: Root
let client: QueryClient
let box: Box

function network(mode: NetworkMode) {
  return { inbound: { mode, allow_net: [] }, outbound: { mode: NetworkMode.ENABLED, allow_net: [] } }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mocks.org = 'org-1'
  vi.resetAllMocks()
  mocks.api = initialApi
  canManage = true
  Element.prototype.scrollIntoView = vi.fn()
  mocks.api.setBoxInboundMode.mockResolvedValue(undefined)
  mocks.api.prepareBoxTunnel.mockResolvedValue({
    uri: 'https://3000-box.proxy.test',
    isPublic: true,
    token: null,
  })
  mocks.api.revokeBoxTunnel.mockResolvedValue(undefined)
  box = {
    id: 'box-1',
    name: 'web-api',
    state: BoxState.STARTED,
    autoResume: false,
    network: {
      inbound: { mode: NetworkMode.ENABLED, allow_net: [] },
      outbound: { mode: NetworkMode.ENABLED, allow_net: [] },
    },
  } as Box
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  root = createRoot(document.body.appendChild(document.createElement('div')))
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  document.body.innerHTML = ''
})
async function render(children?: ReactNode) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <BoxNetworkSection box={box} canManage={canManage}>
          {children}
        </BoxNetworkSection>
      </QueryClientProvider>,
    ),
  )
}
async function click(text: RegExp, scope: ParentNode = document) {
  const button = [...scope.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''))
  expect(button, `button ${text}`).toBeTruthy()
  await act(async () => button?.click())
}
async function port(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')
  expect(input).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('describes disabling inbound as disabled access, not organization authentication', async () => {
  await render()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Inbound access"]')?.click())
  await vi.waitFor(() => expect(mocks.success).toHaveBeenCalled())
  expect(mocks.success).toHaveBeenLastCalledWith('Inbound access disabled')
})

it('does not leave the previous port URL available while configuring another port', async () => {
  await render()
  await click(/^Create tunnel$/)
  await port('3000')
  await click(/^Create tunnel$/, document.querySelector('[role="dialog"]') as HTMLElement)
  await vi.waitFor(() =>
    expect(document.querySelector('[role="dialog"] a')?.getAttribute('href')).toBe('https://3000-box.proxy.test'),
  )
  await click(/^Create another$/)
  await port('8080')
  expect(document.querySelector('[role="dialog"] a')).toBeNull()
})

async function create() {
  await click(/^Create tunnel$/)
  await port('3000')
  await click(/^Create tunnel$/, document.querySelector('[role="dialog"]') as HTMLElement)
}
async function openRevoke() {
  await click(/^Create tunnel$/)
  await click(/^Revoke by port…$/)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Revoke tunnel')
}

it('does not offer a context-free revoke menu beside Create tunnel', async () => {
  await render()
  expect(document.querySelector('[aria-label="Tunnel actions"]')).toBeNull()
})

it('confirms revocation against the configured port without permitting a different target', async () => {
  await render()
  await create()
  await click(/^Revoke port 3000…$/)
  expect(document.querySelector<HTMLInputElement>('#tunnel-port')?.readOnly).toBe(true)
  expect(document.querySelector<HTMLInputElement>('#tunnel-port')?.value).toBe('3000')
  expect(mocks.api.revokeBoxTunnel).not.toHaveBeenCalled()
  await click(/^Revoke tunnel$/, document.querySelector('[role="dialog"]') as HTMLElement)
  expect(mocks.api.revokeBoxTunnel).toHaveBeenCalledWith('org-1', 'box-1', 3000, expect.any(AbortSignal))
})

it('creates a public tunnel and removes editable fields after success', async () => {
  await render()
  await create()
  expect(mocks.api.prepareBoxTunnel).toHaveBeenCalledWith('org-1', 'box-1', 3000, true, expect.any(AbortSignal))
  expect(document.querySelector('#tunnel-port')).toBeNull()
  expect(document.body.textContent).toContain('Port 3000')
  expect(document.body.textContent).toContain('Tunnel configured')
  expect(document.body.textContent).not.toContain('0.0.0.0')
  expect(document.body.textContent).not.toContain('Connected')
  expect(
    JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.state.data),
    ),
  ).not.toContain('blt_')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')?.click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.body.textContent).not.toContain('blt_')
  expect(mocks.api.revokeBoxTunnel).not.toHaveBeenCalled()
})

it('discloses public access before submission and offers no private choice', async () => {
  await render()
  await click(/^Create tunnel$/)
  expect(document.body.textContent).toContain('Public access. Anyone with the URL')
  expect(document.querySelector('#tunnel-access')).toBeNull()
  expect(mocks.api.prepareBoxTunnel).not.toHaveBeenCalled()
  await port('3000')
  await click(/^Create tunnel$/, document.querySelector('[role="dialog"]') as HTMLElement)
  expect(mocks.api.prepareBoxTunnel).toHaveBeenCalledWith('org-1', 'box-1', 3000, true, expect.any(AbortSignal))
})

it('can revoke an arbitrary port with inbound off and the Box stopped, without prepare', async () => {
  box.state = BoxState.STOPPED
  box = { ...box, network: network(NetworkMode.DISABLED) }
  await render()
  await openRevoke()
  expect(document.querySelector<HTMLInputElement>('#tunnel-port')?.readOnly).toBe(false)
  expect(mocks.api.revokeBoxTunnel).not.toHaveBeenCalled()
  await port('3000')
  await click(/^Revoke tunnel$/, document.querySelector('[role="dialog"]') as HTMLElement)
  expect(mocks.api.revokeBoxTunnel).toHaveBeenCalledWith('org-1', 'box-1', 3000, expect.any(AbortSignal))
  expect(mocks.api.prepareBoxTunnel).not.toHaveBeenCalled()
  expect(mocks.api.setBoxInboundMode).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Tunnel revoked')
})

it('keeps an uncertain creation bound to its port and offers explicit revocation', async () => {
  mocks.api.prepareBoxTunnel.mockRejectedValue(
    new TunnelRequestError('Could not confirm tunnel access. This port may be exposed.', 'unknown'),
  )
  await render()
  await create()
  expect(document.querySelector<HTMLInputElement>('#tunnel-port')?.disabled).toBe(true)
  expect(document.querySelector('[role="dialog"] a')).toBeNull()
  expect(mocks.api.revokeBoxTunnel).not.toHaveBeenCalled()
  await click(/^Revoke this port$/)
  expect(document.querySelector<HTMLInputElement>('#tunnel-port')?.readOnly).toBe(true)
  expect(document.querySelector<HTMLInputElement>('#tunnel-port')?.value).toBe('3000')
  await click(/^Revoke tunnel$/, document.querySelector('[role="dialog"]') as HTMLElement)
  expect(mocks.api.revokeBoxTunnel).toHaveBeenCalledWith('org-1', 'box-1', 3000, expect.any(AbortSignal))
})

it('does not change exposure when the API refuses an access-mode conflict', async () => {
  mocks.api.prepareBoxTunnel.mockRejectedValue(
    new TunnelRequestError('This port already uses a different access mode.'),
  )
  await render()
  await create()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('different access mode')
  expect(mocks.api.revokeBoxTunnel).not.toHaveBeenCalled()
  expect(mocks.api.prepareBoxTunnel).toHaveBeenCalledTimes(1)
})

it('checks inbound before showing port settings and never creates as a side effect of enabling', async () => {
  box = { ...box, network: network(NetworkMode.DISABLED) }
  await render()
  await click(/^Create tunnel$/)
  expect(document.querySelector('#tunnel-port')).toBeNull()
  expect(document.querySelector('#tunnel-access')).toBeNull()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Existing tunnels')
  expect(mocks.api.setBoxInboundMode).not.toHaveBeenCalled()
  await click(/^Enable and continue$/)
  expect(mocks.api.setBoxInboundMode).toHaveBeenCalledWith(
    'org-1',
    'box-1',
    NetworkMode.ENABLED,
    expect.any(AbortSignal),
  )
  expect(mocks.api.prepareBoxTunnel).not.toHaveBeenCalled()
  expect(document.querySelector('#tunnel-port')).toBeNull()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Refresh status')
  box = { ...box, network: network(NetworkMode.ENABLED) }
  await render()
  expect(document.querySelector('#tunnel-port')).not.toBeNull()
  expect(document.querySelector('#tunnel-access')).toBeNull()
  expect(mocks.api.prepareBoxTunnel).not.toHaveBeenCalled()
})

it.each([false, true])('gates a stopped Box create action by auto-resume: %s', async (autoResume) => {
  box.state = BoxState.STOPPED
  box.autoResume = autoResume
  await render()
  await click(/^Create tunnel$/)
  if (autoResume) {
    await port('3000')
    expect(document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')?.disabled).toBe(false)
  } else {
    expect(document.querySelector('#tunnel-port')).toBeNull()
    expect(document.body.textContent).toContain('Start this Box')
    expect(mocks.api.setBoxInboundMode).not.toHaveBeenCalled()
  }
})

it('blocks duplicate submissions and ignores results after an organization change', async () => {
  let resolve!: (value: unknown) => void
  mocks.api.prepareBoxTunnel.mockReturnValue(
    new Promise((r) => {
      resolve = r
    }),
  )
  await render()
  await create()
  await act(async () =>
    document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(mocks.api.prepareBoxTunnel).toHaveBeenCalledTimes(1)
  const signal = mocks.api.prepareBoxTunnel.mock.calls[0][4] as AbortSignal
  mocks.org = 'org-2'
  await render()
  expect(signal.aborted).toBe(true)
  await act(async () => resolve({ uri: 'https://old-org.test', isPublic: false, token: `blt_${'a'.repeat(43)}` }))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await click(/^Create tunnel$/)
  expect(document.body.textContent).not.toContain('old-org.test')
  expect(document.body.textContent).not.toContain('blt_')
})

it.each(['permission', 'client', 'box'])('clears a successful descriptor after changing %s', async (scope) => {
  await render()
  await create()
  if (scope === 'permission') canManage = false
  if (scope === 'client') mocks.api = { ...mocks.api }
  if (scope === 'box') box = { ...box, id: 'box-2' }
  await render()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.body.textContent).not.toContain('blt_')
})

it('refreshes rather than repeating an uncertain inbound write', async () => {
  box = { ...box, network: network(NetworkMode.DISABLED) }
  mocks.api.setBoxInboundMode.mockRejectedValue(new Error('timeout'))
  mocks.api.boxApi.getBox.mockResolvedValue({ data: box })
  await render()
  await click(/^Create tunnel$/)
  await click(/^Enable and continue$/)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Refresh its status')
  expect(document.querySelector('#tunnel-port')).toBeNull()
  await click(/^Refresh status$/)
  expect(mocks.api.boxApi.getBox).toHaveBeenCalledWith('box-1', 'org-1', undefined, {
    signal: expect.any(AbortSignal),
    timeout: 15_000,
  })
  expect(mocks.api.setBoxInboundMode).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('still disabled')
  expect(mocks.api.prepareBoxTunnel).not.toHaveBeenCalled()
})

it('does not enable inbound for an unavailable Box or unknown network state', async () => {
  box.state = BoxState.STOPPED
  box = { ...box, network: network(NetworkMode.DISABLED) }
  await render()
  await click(/^Create tunnel$/)
  expect(document.body.textContent).toContain('Start this Box')
  expect(document.querySelector('#tunnel-port')).toBeNull()
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Enable and continue')
  box = { ...box, state: BoxState.STARTED, network: undefined }
  await render()
  expect(document.body.textContent).toContain('Could not confirm inbound access')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Refresh status')
  expect(mocks.api.setBoxInboundMode).not.toHaveBeenCalled()
})

it('preserves the recovery port when inbound is disabled after an uncertain creation', async () => {
  mocks.api.prepareBoxTunnel.mockRejectedValue(new TunnelRequestError('Could not confirm creation.', 'unknown'))
  await render()
  await create()
  box = {
    ...box,
    state: BoxState.STOPPED,
    network: network(NetworkMode.DISABLED),
  }
  await render()
  expect(document.querySelector<HTMLInputElement>('#tunnel-port')?.value).toBe('3000')
  await click(/^Revoke this port$/)
  await click(/^Revoke tunnel$/, document.querySelector('[role="dialog"]') as HTMLElement)
  expect(mocks.api.revokeBoxTunnel).toHaveBeenCalledWith('org-1', 'box-1', 3000, expect.any(AbortSignal))
})

it('keeps the configured URL copyable but disables opening when inbound is subsequently disabled', async () => {
  await render()
  await create()
  box = { ...box, network: network(NetworkMode.DISABLED) }
  await render()
  expect(document.querySelector('[role="dialog"] a')).toBeNull()
  expect(document.querySelector('[data-copy]')?.getAttribute('data-copy')).toBe('https://3000-box.proxy.test')
  expect(document.body.textContent).toContain('Tunnel access is paused')
})

it('only offers readback when inbound mode is missing from a network record', async () => {
  box = { ...box, network: { ...box.network, inbound: {} } } as Box
  await render()
  await click(/^Create tunnel$/)
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Enable and continue')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Refresh status')
  expect(document.querySelector('#tunnel-port')).toBeNull()
  expect(document.querySelector('[aria-label="Inbound access"]')).toBeNull()
  expect(mocks.api.setBoxInboundMode).not.toHaveBeenCalled()
})

it('does not cache an inbound readback after the authenticated client changes', async () => {
  let resolve!: (value: unknown) => void
  box = { ...box, network: undefined }
  mocks.api.boxApi.getBox.mockReturnValue(
    new Promise((r) => {
      resolve = r
    }),
  )
  await render()
  await click(/^Create tunnel$/)
  await click(/^Refresh status$/)
  const request = mocks.api.boxApi.getBox.mock.calls[0][3]
  mocks.api = { ...mocks.api }
  await render()
  expect(request.signal.aborted).toBe(true)
  await act(async () => resolve({ data: { ...box, network: network(NetworkMode.ENABLED) } }))
  expect(client.getQueryCache().getAll()).toHaveLength(0)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

// SSH keeps its own owner, but its controls belong before tunnel actions in DOM/tab order.
it('places additional network controls after inbound and before tunnel actions', async () => {
  await render(<button>Refresh SSH status</button>)
  const controls = [...document.querySelectorAll('button')]
  const inbound = controls.findIndex((button) => button.getAttribute('aria-label') === 'Inbound access')
  const ssh = controls.findIndex((button) => button.textContent === 'Refresh SSH status')
  const create = controls.findIndex((button) => button.textContent === 'Create tunnel')
  expect(inbound).toBeGreaterThanOrEqual(0)
  expect(ssh).toBeGreaterThan(inbound)
  expect(create).toBeGreaterThan(ssh)
})

it('disables historical revocation while a create request is pending', async () => {
  mocks.api.prepareBoxTunnel.mockReturnValue(new Promise(() => {}))
  await render()
  await create()
  const revoke = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Revoke by port…',
  )
  expect(revoke?.disabled).toBe(true)
  await act(async () => revoke?.click())
  expect(mocks.api.revokeBoxTunnel).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Public access.')
})

it('aborts inbound enablement when the authenticated scope changes', async () => {
  box = { ...box, network: network(NetworkMode.DISABLED) }
  mocks.api.setBoxInboundMode.mockReturnValue(new Promise(() => {}))
  await render()
  await click(/^Create tunnel$/)
  await click(/^Enable and continue$/)
  const signal = mocks.api.setBoxInboundMode.mock.calls[0][3]
  expect(signal).toBeInstanceOf(AbortSignal)
  expect(signal.aborted).toBe(false)
  mocks.api = { ...mocks.api }
  await render()
  expect(signal.aborted).toBe(true)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
