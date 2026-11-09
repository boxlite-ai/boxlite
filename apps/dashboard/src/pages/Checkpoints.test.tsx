// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Checkpoints from './Checkpoints'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import { CheckpointCreateDialog } from '@/components/CheckpointCreateDialog'
import type { Box } from '@boxlite-ai/api-client'

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
    getCheckpointCapabilities: vi.fn(),
    boxApi: { listBoxesPaginated: vi.fn(), getBox: vi.fn() },
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
const source = { id: 'source-box', name: 'source-name', state: 'stopped', desiredState: 'stopped', disk: 10 }
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
    state.api.getCheckpointCapabilities.mockReset().mockResolvedValue({ checkpoints_enabled: true })
    state.api.boxApi.listBoxesPaginated.mockReset().mockResolvedValue({ data: { items: [source], totalPages: 1 } })
    state.api.boxApi.getBox.mockReset().mockResolvedValue({ data: source })
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
  async function render(content = <Checkpoints />) {
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <TooltipProvider>{content}</TooltipProvider>
          </MemoryRouter>
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
      const labels: Record<string, string> = { 'checkpoint-box': 'Source box', 'checkpoint-name': 'Checkpoint name' }
      const element = document.getElementById(id) ?? document.querySelector(`[aria-label="${labels[id] ?? id}"]`)
      expect(element).not.toBeNull()
      const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
      element!.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    })
  }
  async function submit() {
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await settle()
  }

  it('checkpoint restoration removes the recovery action', async () => {
    await render()
    expect(document.querySelector('[aria-label="Recover Box from base"]')).toBeNull()
  })

  it('checkpoint restoration selects a source instead of asking for its identifier', async () => {
    await render()
    const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      /Capture checkpoint|New Checkpoint/.test(button.textContent ?? ''),
    )!
    expect(trigger).toBeDefined()
    await act(async () => trigger.click())
    await settle()
    expect(document.querySelector('select[aria-label="Source box"]')).not.toBeNull()
  })

  it('checkpoint restoration requires typing the exact name before deletion', async () => {
    await render()
    await click('Delete base')
    expect(document.querySelector('input[aria-label="Confirm checkpoint name"]')).not.toBeNull()
    expect(state.api.removeCheckpoint).not.toHaveBeenCalled()
  })

  it('requires an exact name and permits retry after a deletion refusal', async () => {
    await render()
    await click('Delete base')
    input('Confirm checkpoint name', 'Base')
    await click('Delete')
    expect(state.api.removeCheckpoint).not.toHaveBeenCalled()
    input('Confirm checkpoint name', 'base')
    state.api.removeCheckpoint.mockRejectedValueOnce(new Error('Archive cleanup failed'))
    await click('Delete')
    expect(document.body.textContent).toContain('Archive cleanup failed')
    expect((document.querySelector('[aria-label="Confirm checkpoint name"]') as HTMLInputElement).value).toBe('base')
    await click('Delete')
    expect(state.api.removeCheckpoint).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('loads all candidate pages and excludes transitional or volume sources', async () => {
    state.api.boxApi.listBoxesPaginated.mockImplementation(async (_org, page, _size, id) => ({
      data: {
        items: id
          ? []
          : page === 1
            ? [source, { ...source, id: 'transition', desiredState: 'started' }]
            : [
                { ...source, id: 'running', state: 'started', desiredState: 'started' },
                { ...source, id: 'mounted', volumes: [{}] },
              ],
        totalPages: id ? 1 : 2,
      },
    }))
    await render()
    await click('New Checkpoint')
    const options = Array.from(document.querySelectorAll<HTMLOptionElement>('select[aria-label="Source box"] option'))
    expect(options.map((option) => option.value)).toEqual(['', 'source-box', 'running'])
    input('Source box', 'running')
    await submit()
    expect(state.api.createCheckpoint).toHaveBeenCalledWith('org-1', 'running', undefined)
  })

  it('links exact sources and never mistakes a similar name for the source', async () => {
    state.api.listCheckpoints.mockResolvedValue([ready, { ...creating, source_box_id: 'source-box' }])
    state.api.boxApi.listBoxesPaginated.mockResolvedValue({
      data: { items: [source, { ...source, id: 'prefix-match', name: 'deleted-source' }], totalPages: 1 },
    })
    await render()
    expect(document.body.textContent).toContain('deleted-source (deleted)')
    expect(document.querySelector('a[href="/dashboard/boxes/source-box"]')?.textContent).toBe('source-name')
    expect(document.querySelector('a[href="/dashboard/boxes/prefix-match"]')).toBeNull()
  })

  it('shows source lookup failures without claiming deletion', async () => {
    state.api.boxApi.listBoxesPaginated.mockRejectedValue(new Error('Network unavailable'))
    await render()
    expect(document.body.textContent).toContain('Could not load source boxes')
    expect(document.body.textContent).not.toContain('(deleted)')
  })

  it('keeps capture names and inline refusal for retry', async () => {
    state.api.createCheckpoint.mockRejectedValue(new Error('Checkpoint name already exists'))
    await render()
    await click('New Checkpoint')
    input('Source box', 'source-box')
    input('Checkpoint name', 'base')
    await submit()
    expect(document.body.textContent).toContain('Checkpoint name already exists')
    expect((document.querySelector('[aria-label="Checkpoint name"]') as HTMLInputElement).value).toBe('base')
    expect(document.querySelector('form')).not.toBeNull()
  })

  it('rechecks a fixed source and blocks capture after its state changes', async () => {
    state.api.boxApi.getBox.mockResolvedValue({ data: { ...source, desiredState: 'started' } })
    await render(<CheckpointCreateDialog box={source as Box} onClose={vi.fn()} />)
    const select = document.querySelector<HTMLSelectElement>('[aria-label="Source box"]')!
    expect(select.disabled).toBe(true)
    await submit()
    expect(state.api.createCheckpoint).not.toHaveBeenCalled()
    expect(state.api.boxApi.getBox).toHaveBeenCalledWith('source-box', 'org-1')
  })

  it('captures the refreshed fixed source without allowing it to be changed', async () => {
    const onClose = vi.fn()
    await render(<CheckpointCreateDialog box={source as Box} onClose={onClose} />)
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Source box"]')!.value).toBe('source-box')
    await submit()
    expect(state.api.createCheckpoint).toHaveBeenCalledWith('org-1', 'source-box', undefined)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('distinguishes disabled capabilities from discovery failures', async () => {
    state.api.getCheckpointCapabilities.mockRejectedValue(new Error('Unavailable'))
    await render()
    expect(document.body.textContent).toContain('Could not load checkpoint capabilities')
    expect(document.body.textContent).not.toContain('not enabled in this environment')
    state.api.getCheckpointCapabilities.mockResolvedValue({ checkpoints_enabled: false })
    await click('Retry capabilities')
    expect(document.body.textContent).toContain('Checkpoints are not enabled in this environment')
  })

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
      await vi.advanceTimersByTimeAsync(5001)
    })
    expect(state.api.listCheckpoints).toHaveBeenCalledTimes(2)
    expect((document.querySelector('[aria-label="Create Box from building"]') as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('captures without execution overrides and sends the selected organization', async () => {
    await render()
    await click('New Checkpoint')
    input('checkpoint-box', 'source-box')
    input('checkpoint-name', 'dev-base')
    await submit()
    expect(state.api.createCheckpoint).toHaveBeenCalledWith('org-1', 'source-box', 'dev-base')
    expect(document.querySelector('form')).toBeNull()
  })

  it('creates a new Box with only the saved checkpoint and optional name', async () => {
    await render()
    await click('Create Box from base')
    input('Box name', 'worker')
    await submit()
    expect(state.api.createBoxFromCheckpoint).toHaveBeenCalledWith('org-1', 'checkpoint-1', 'worker')
    expect(state.navigate).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('new-box'))
  })

  it('retains the row and confirmation when deletion is refused', async () => {
    state.api.removeCheckpoint.mockRejectedValue(new Error('Checkpoint is in use'))
    await render()
    await click('Delete base')
    expect(state.api.removeCheckpoint).not.toHaveBeenCalled()
    input('Confirm checkpoint name', 'base')
    await click('Delete')
    expect(state.api.removeCheckpoint).toHaveBeenCalledWith('org-1', 'checkpoint-1')
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Checkpoint is in use')
    expect(document.body.textContent).toContain('deleted-source')
  })

  it('permits readers to inspect checkpoints with disabled mutation controls', async () => {
    state.canWrite = false
    await render()
    expect(document.body.textContent).toContain('deleted-source')
    expect(
      (
        Array.from(document.querySelectorAll('button')).find((button) =>
          button.textContent?.includes('New Checkpoint'),
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
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
    expect(toast.success).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('deleted-source')
    expect(state.api.listCheckpoints).toHaveBeenLastCalledWith('org-2')
  })
})
