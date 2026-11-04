// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AxiosError } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { BoxliteError } from '@/api/errors'
import { TooltipProvider } from '@/components/ui/tooltip'
import Snapshots from './Snapshots'
import { SnapshotCreateDialog } from '@/components/SnapshotCreateDialog'

const state = vi.hoisted(() => ({ orgId: 'org-a', permissions: ['write:boxes', 'delete:boxes'] }))
const api = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  listBoxesPaginated: vi.fn(),
  createSnapshot: vi.fn(),
  deleteSnapshot: vi.fn(),
  createBoxFromSnapshot: vi.fn(),
  getSnapshotCapabilities: vi.fn(),
  getBox: vi.fn(),
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ boxApi: api }) }))
vi.mock('@/lib/cloudSnapshot', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: state.orgId },
    authenticatedUserHasPermission: (permission: string) => state.permissions.includes(permission),
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

const snapshot = {
  id: 's-1',
  name: 'checkpoint',
  sourceBoxId: 'b-1',
  status: 'ready',
  sizeBytes: 1024,
  diskGb: 10,
  createdAt: '2026-10-01T00:00:00Z',
}
const boxes = [
  { id: 'b-1', name: 'stopped-source', state: 'stopped', desiredState: 'stopped', disk: 10 },
  { id: 'b-2', name: 'running-target', state: 'started', desiredState: 'started', disk: 10 },
  { id: 'b-3', name: 'starting-target', state: 'stopped', desiredState: 'started', disk: 10 },
  { id: 'b-4', name: 'stopped-target', state: 'stopped', desiredState: 'stopped', disk: 20 },
]
function refusal(status: number, message: string) {
  const transport = `Request failed with status code ${status}`
  return new BoxliteError(transport, {
    cause: new AxiosError(transport, undefined, undefined, undefined, {
      status,
      data: { error: { message } },
    } as never),
  })
}
function button(text: string, selector = 'button'): HTMLButtonElement {
  const element = [...document.querySelectorAll<HTMLButtonElement>(selector)].find(
    (item) => item.textContent?.trim() === text,
  )
  expect(element).toBeDefined()
  return element!
}
async function click(element: HTMLElement) {
  await act(async () => element.click())
}
async function fill(label: string, value: string) {
  const element = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!
  expect(element).not.toBeNull()
  if (element instanceof HTMLSelectElement) {
    await waitFor(() => expect([...element.options].some((option) => option.value === value)).toBe(true))
  }
  await act(async () => {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
async function waitFor(check: () => void) {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await Promise.resolve()
      })
      check()
    },
    { timeout: 6000 },
  )
}

describe('Snapshots page', () => {
  let client: QueryClient
  let root: Root
  async function render(content = <Snapshots />) {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <MemoryRouter>{content}</MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>,
      ),
    )
  }
  async function ready() {
    await render()
    await waitFor(() => expect(document.body.textContent).toContain('checkpoint'))
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.resetAllMocks()
    state.orgId = 'org-a'
    state.permissions = ['write:boxes', 'delete:boxes']
    api.listSnapshots.mockResolvedValue([snapshot])
    api.listBoxesPaginated.mockResolvedValue({ data: { items: boxes, totalPages: 1 } })
    api.createSnapshot.mockResolvedValue({ ...snapshot, status: 'creating' })
    api.deleteSnapshot.mockResolvedValue(undefined)
    api.createBoxFromSnapshot.mockResolvedValue({ box_id: 'new-box', name: 'cozy-otter', status: 'configured' })
    api.getSnapshotCapabilities.mockResolvedValue({ snapshots_enabled: true, create_from_snapshot_enabled: true })
    api.getBox.mockResolvedValue({ data: boxes[0] })
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    document.body.innerHTML = ''
  })

  it('shows loading and then a distinct empty state', async () => {
    let resolve: (value: []) => void
    api.listSnapshots.mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    await render()
    expect(document.body.textContent).toContain('Loading snapshots…')
    await act(async () => resolve!([]))
    await waitFor(() => expect(document.body.textContent).toContain('No snapshots yet'))
  })

  it('shows the disabled environment instead of a table or mutation controls', async () => {
    api.getSnapshotCapabilities.mockResolvedValue({ snapshots_enabled: false })
    api.listSnapshots.mockRejectedValue(refusal(503, 'Snapshots are off'))
    await render()
    await waitFor(() => expect(document.body.textContent).toContain('Snapshots are not enabled in this environment.'))
    expect(document.querySelector('table')).toBeNull()
    expect(document.querySelector('button')).toBeNull()
  })

  it('does not query snapshots when the cached capability is disabled', async () => {
    client.setQueryData(['snapshot-capabilities', 'org-a'], { snapshots_enabled: false })
    api.getSnapshotCapabilities.mockResolvedValue({ snapshots_enabled: false })
    await render()
    await waitFor(() => expect(document.body.textContent).toContain('Snapshots are not enabled'))
    expect(api.listSnapshots).not.toHaveBeenCalled()
  })

  it('does not prompt to stop a box while its fixed source is loading', async () => {
    api.getBox.mockReturnValue(new Promise(() => {}))
    await render(<SnapshotCreateDialog box={boxes[0] as never} onClose={() => undefined} />)
    expect(document.body.textContent).toContain('Loading boxes')
    expect(document.body.textContent).not.toContain('Stop a box before creating a snapshot')
  })

  it('keeps transient 503 list errors retryable', async () => {
    api.listSnapshots.mockRejectedValue(refusal(503, 'Snapshot backend temporarily unavailable'))
    await render()
    await waitFor(() => expect(document.body.textContent).toContain('Snapshot backend temporarily unavailable'))
    expect(document.body.textContent).not.toContain('Snapshots are not enabled')
    api.listSnapshots.mockResolvedValue([snapshot])
    await click(button('Retry'))
    await waitFor(() => expect(document.body.textContent).toContain('checkpoint'))
  }, 10000)

  it('shows capability errors with a retry action', async () => {
    api.getSnapshotCapabilities.mockRejectedValue(new Error('Config temporarily unavailable'))
    await render()
    await waitFor(() => expect(document.body.textContent).toContain('Could not load snapshot capabilities'))
    api.getSnapshotCapabilities.mockResolvedValue({ snapshots_enabled: true })
    await click(button('Retry capabilities'))
    await waitFor(() => expect(button('New Snapshot')).toHaveProperty('disabled', false))
  })

  it('submits a fixed box despite an unrelated cached box-list error', async () => {
    api.listBoxesPaginated.mockRejectedValue(new Error('Box list failed'))
    await render()
    await waitFor(() => expect(document.body.textContent).toContain('Could not load source boxes'))
    await render(<SnapshotCreateDialog box={boxes[0] as never} onClose={() => undefined} />)
    await waitFor(() => expect(button('Create Snapshot')).toHaveProperty('disabled', false))
    await click(button('Create Snapshot'))
    expect(api.createSnapshot).toHaveBeenCalledWith(expect.anything(), 'org-a', 'b-1', undefined)
  }, 10000)

  it('refreshes a fixed source even when its captured row was stopped', async () => {
    api.getBox.mockResolvedValue({ data: { ...boxes[0], state: 'started', desiredState: 'started' } })
    await render(<SnapshotCreateDialog box={boxes[0] as never} onClose={() => undefined} />)
    await waitFor(() => expect(api.getBox).toHaveBeenCalledWith('b-1', 'org-a'))
    expect(button('Create Snapshot')).toHaveProperty('disabled', true)
    expect(api.createSnapshot).not.toHaveBeenCalled()
  })

  it.each(['  worker  ', '   '])('trims child names before validation: %j', async (name) => {
    await ready()
    await click(button('Box'))
    await fill('Box name', name)
    expect(button('Create Box', '[role="dialog"] button')).toHaveProperty('disabled', false)
    await click(button('Create Box', '[role="dialog"] button'))
    expect(api.createBoxFromSnapshot).toHaveBeenCalledWith(expect.anything(), 'org-a', 's-1', name.trim() || undefined)
  })

  it('renders a retryable list failure, not an empty list', async () => {
    api.listSnapshots.mockRejectedValue(refusal(403, 'Not allowed to read this organization'))
    await render()
    await waitFor(() => expect(document.body.textContent).toContain('Not allowed to read this organization'))
    expect(document.body.textContent).not.toContain('No snapshots yet')
    api.listSnapshots.mockResolvedValue([snapshot])
    await click(button('Retry'))
    await waitFor(() => expect(document.body.textContent).toContain('checkpoint'))
  }, 10000)

  it('offers only stopped targets and validates names before creating', async () => {
    await ready()
    await click(button('New Snapshot'))
    await waitFor(() =>
      expect(document.querySelector('select[aria-label="Source box"]')?.textContent).toContain('stopped-target'),
    )
    const choices = [...document.querySelectorAll('select[aria-label="Source box"] option')].map(
      (item) => item.textContent,
    )
    expect(choices.some((text) => text?.includes('running-target') || text?.includes('starting-target'))).toBe(false)
    await fill('Source box', 'b-1')
    for (const name of ['.bad', 'has space', 'x'.repeat(129)]) {
      await fill('Snapshot name', name)
      expect(button('Create Snapshot')).toHaveProperty('disabled', true)
    }
    await fill('Snapshot name', 'a')
    expect(button('Create Snapshot')).toHaveProperty('disabled', false)
    await click(button('Create Snapshot'))
    expect(api.createSnapshot).toHaveBeenCalledWith(expect.anything(), 'org-a', 'b-1', 'a')
  })

  it('keeps creation refusals visible without closing the dialog', async () => {
    api.createSnapshot.mockRejectedValue(refusal(409, 'A snapshot named checkpoint already exists'))
    await ready()
    await click(button('New Snapshot'))
    await fill('Source box', 'b-1')
    await fill('Snapshot name', 'checkpoint')
    await click(button('Create Snapshot'))
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        'A snapshot named checkpoint already exists',
      ),
    )
  })

  it('lets the server name a new box and displays the returned name', async () => {
    await ready()
    await click(button('Box'))
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('(optional)')
    expect(document.querySelector('[aria-label="Box name"]')).toHaveProperty('value', '')
    await click(button('Create Box', '[role="dialog"] button'))
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(api.createBoxFromSnapshot).toHaveBeenCalledWith(expect.anything(), 'org-a', 's-1', undefined)
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('cozy-otter'))
  })

  it('rejects invalid custom box names before sending a request', async () => {
    await ready()
    await click(button('Box'))
    await fill('Box name', 'invalid/name')
    expect(button('Create Box', '[role="dialog"] button')).toHaveProperty('disabled', true)
    await click(button('Create Box', '[role="dialog"] button'))
    expect(api.createBoxFromSnapshot).not.toHaveBeenCalled()
    await fill('Box name', '')
    expect(button('Create Box', '[role="dialog"] button')).toHaveProperty('disabled', false)
  })

  it('keeps explicit box name conflicts in the dialog', async () => {
    const reason = 'Box with name checkpoint already exists'
    api.createBoxFromSnapshot.mockRejectedValue(refusal(409, reason))
    await ready()
    await click(document.querySelector('[aria-label="Create Box from checkpoint"]')!)
    expect(document.querySelector('[aria-label="Box name"]')).toHaveProperty('placeholder', 'my-new-box')
    await fill('Box name', 'checkpoint')
    await click(button('Create Box', '[role="dialog"] button'))
    await waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain(reason))
    expect(api.createBoxFromSnapshot).toHaveBeenCalledWith(expect.anything(), 'org-a', 's-1', 'checkpoint')
    api.createBoxFromSnapshot.mockResolvedValue({ box_id: 'new-box', name: 'new-worker' })
    await fill('Box name', 'new-worker')
    await click(button('Create Box', '[role="dialog"] button'))
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(api.createBoxFromSnapshot).toHaveBeenLastCalledWith(expect.anything(), 'org-a', 's-1', 'new-worker')
  })

  it('lets the server name a snapshot independently of its source box name', async () => {
    api.listBoxesPaginated.mockResolvedValue({
      data: { items: [{ ...boxes[0], name: 'source with spaces' }], totalPages: 1 },
    })
    api.createSnapshot.mockResolvedValue({ ...snapshot, name: 'brisk-fox', status: 'creating' })
    await ready()
    await click(button('New Snapshot'))
    await fill('Source box', 'b-1')
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('(optional)')
    expect(button('Create Snapshot')).toHaveProperty('disabled', false)
    await click(button('Create Snapshot'))
    expect(api.createSnapshot).toHaveBeenCalledWith(expect.anything(), 'org-a', 'b-1', undefined)
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('brisk-fox'))
  })

  it('keeps a create 503 in the dialog so the user can retry', async () => {
    api.createSnapshot.mockRejectedValue(refusal(503, 'Snapshots are off'))
    await ready()
    await click(button('New Snapshot'))
    await fill('Source box', 'b-1')
    await fill('Snapshot name', 'checkpoint')
    await click(button('Create Snapshot'))
    await waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Snapshots are off'))
    expect(document.body.textContent).not.toContain('Snapshots are not enabled in this environment.')
    api.createSnapshot.mockResolvedValue({ ...snapshot, status: 'creating' })
    await click(button('Create Snapshot'))
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  })

  it('requires the exact name for deletion and retains a 409 reason', async () => {
    api.deleteSnapshot.mockRejectedValue(refusal(409, 'Snapshot checkpoint is being restored into a box'))
    await ready()
    await click(document.querySelector('[aria-label="Delete checkpoint"]')!)
    expect(button('Delete')).toHaveProperty('disabled', true)
    await fill('Confirm snapshot name', 'Checkpoint')
    expect(button('Delete')).toHaveProperty('disabled', true)
    await fill('Confirm snapshot name', 'checkpoint')
    await click(button('Delete'))
    await waitFor(() =>
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('is being restored into a box'),
    )
    expect(api.deleteSnapshot).toHaveBeenCalledWith(expect.anything(), 'org-a', 's-1')
  })

  it('disables each action without its box permission', async () => {
    state.permissions = []
    await ready()
    expect(button('New Snapshot')).toHaveProperty('disabled', true)
    expect(document.querySelector('[aria-label="Create Box from checkpoint"]')).toHaveProperty('disabled', true)
    expect(document.querySelector('[aria-label="Delete checkpoint"]')).toHaveProperty('disabled', true)
  })

  it('discards an open confirmation when the organization changes', async () => {
    await ready()
    await click(document.querySelector('[aria-label="Delete checkpoint"]')!)
    await fill('Confirm snapshot name', 'checkpoint')
    state.orgId = 'org-b'
    api.listSnapshots.mockResolvedValue([])
    await render()
    await waitFor(() => expect(document.body.textContent).toContain('No snapshots yet'))
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(api.deleteSnapshot).not.toHaveBeenCalled()
  })
})
