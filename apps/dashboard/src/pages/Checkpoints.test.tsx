// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Checkpoints from './Checkpoints'

const state = vi.hoisted(() => ({
  org: 'org-1',
  canWrite: true,
  navigate: vi.fn(),
  error: vi.fn(),
  api: {
    listCheckpoints: vi.fn(),
    createCheckpoint: vi.fn(),
    removeCheckpoint: vi.fn(),
    createBoxFromCheckpoint: vi.fn(),
    recoverBoxFromCheckpoint: vi.fn(),
  },
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => state.api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: state.org },
    authenticatedUserHasPermission: () => state.canWrite,
  }),
}))
vi.mock('@/lib/error-handling', () => ({ handleApiError: (...args: unknown[]) => state.error(...args) }))
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => state.navigate,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

const ready = {
  id: 'checkpoint-1',
  name: 'base',
  source_box_id: 'deleted-source',
  created_at: '2026-11-06T00:00:00Z',
  size_bytes: 4096,
  state: 'ready',
}
const creating = { ...ready, id: 'checkpoint-2', name: 'building', state: 'creating' }

describe('Checkpoint inventory', () => {
  let root: Root
  let client: QueryClient
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    state.org = 'org-1'
    state.canWrite = true
    state.api.listCheckpoints.mockReset().mockResolvedValue([ready, creating])
    state.api.createCheckpoint.mockReset().mockResolvedValue(creating)
    state.api.removeCheckpoint.mockReset().mockResolvedValue(undefined)
    state.api.createBoxFromCheckpoint.mockReset().mockResolvedValue({ box_id: 'new-box' })
    state.api.recoverBoxFromCheckpoint.mockReset().mockResolvedValue({ box_id: 'target-box' })
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    document.body.innerHTML = ''
    vi.useRealTimers()
  })
  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
  }
  async function render() {
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Checkpoints />
        </QueryClientProvider>,
      ),
    )
    await settle()
  }
  async function click(label: string) {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (element) => (element.getAttribute('aria-label') || element.textContent?.trim()) === label,
    )
    expect(button).toBeDefined()
    await act(async () => button!.click())
    await settle()
  }
  function input(id: string, value: string) {
    act(() => {
      const element = document.getElementById(id)!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function submit() {
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await settle()
  }

  it('lists independent sources and disables actions until ready', async () => {
    await render()
    expect(document.querySelector('table')).not.toBeNull()
    expect(document.body.textContent).toContain('deleted-source')
    const row = Array.from(document.querySelectorAll('tr')).find((element) =>
      element.textContent?.includes('building'),
    )!
    expect(Array.from(row.querySelectorAll('button')).every((button) => button.disabled)).toBe(true)
    await act(async () => {
      state.api.listCheckpoints.mockResolvedValue([ready, { ...creating, state: 'ready' }])
      await vi.advanceTimersByTimeAsync(2001)
    })
    expect(state.api.listCheckpoints).toHaveBeenCalledTimes(2)
    expect((document.querySelector('[aria-label="Create Box from building"]') as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('captures without execution overrides and sends the selected organization', async () => {
    await render()
    await click('Capture checkpoint')
    input('checkpoint-box', 'source-box')
    input('checkpoint-name', 'dev-base')
    await submit()
    expect(state.api.createCheckpoint).toHaveBeenCalledWith('org-1', 'source-box', 'dev-base')
    expect(document.querySelector('form')).toBeNull()
  })

  it('creates a new Box with only the saved checkpoint and optional name', async () => {
    await render()
    await click('Create Box from base')
    input('checkpoint-name', 'worker')
    await submit()
    expect(state.api.createBoxFromCheckpoint).toHaveBeenCalledWith('org-1', 'checkpoint-1', 'worker')
    expect(state.navigate).toHaveBeenCalledWith('/dashboard/boxes/new-box')
  })

  it('confirms replacement of a target without exposing configuration overrides', async () => {
    await render()
    await click('Recover Box from base')
    expect(state.api.recoverBoxFromCheckpoint).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("Replace the target Box's disk and configuration")
    expect(document.querySelectorAll('form input')).toHaveLength(1)
    input('checkpoint-box', 'target-box')
    await submit()
    expect(state.api.recoverBoxFromCheckpoint).toHaveBeenCalledWith('org-1', 'checkpoint-1', 'target-box')
    expect(state.navigate).toHaveBeenCalledWith('/dashboard/boxes/target-box')
  })

  it('retains the row and confirmation when deletion is refused', async () => {
    state.api.removeCheckpoint.mockRejectedValue(new Error('Checkpoint is in use'))
    await render()
    await click('Delete base')
    expect(state.api.removeCheckpoint).not.toHaveBeenCalled()
    await submit()
    expect(state.api.removeCheckpoint).toHaveBeenCalledWith('org-1', 'checkpoint-1')
    expect(document.querySelector('form')).not.toBeNull()
    expect(document.body.textContent).toContain('deleted-source')
    expect(state.error).toHaveBeenCalled()
  })

  it('permits readers to inspect checkpoints without mutation controls', async () => {
    state.canWrite = false
    await render()
    expect(document.body.textContent).toContain('deleted-source')
    expect(
      Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Capture checkpoint'),
    ).toBe(false)
    expect(
      Array.from(document.querySelectorAll('tbody button')).every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true)
  })

  it('keeps an old organization result from navigating the new organization', async () => {
    let resolve!: (result: { box_id: string }) => void
    state.api.createBoxFromCheckpoint.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    await render()
    await click('Create Box from base')
    await submit()
    state.org = 'org-2'
    state.api.listCheckpoints.mockResolvedValue([])
    await render()
    await act(async () => resolve({ box_id: 'old-org-box' }))
    await settle()
    expect(state.navigate).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('deleted-source')
    expect(state.api.listCheckpoints).toHaveBeenLastCalledWith('org-2')
  })
})
