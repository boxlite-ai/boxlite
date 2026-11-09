// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Volumes from './Volumes'

const READY_VOLUME = {
  id: 'f0f2f2b6-0b1e-4a1a-9c0a-1c2f3a4b5c6d',
  name: 'subtitle-models',
  state: 'ready',
  createdAt: new Date().toISOString(),
  lastUsedAt: null,
}

// Stands in for the real form so the assertions can read what the page decided
// to hand it — whether it is open, and which volume it was told to mount.
vi.mock('@/components/Box/CreateBoxDialog', () => ({
  CreateBoxDialog: ({ open, prefillVolume }: { open?: boolean; prefillVolume?: string }) => (
    <div data-testid="create-box-dialog" data-open={String(!!open)} data-prefill-volume={prefillVolume} />
  ),
}))

// Each test sets the permissions its member holds.
const state = vi.hoisted(() => ({
  permissions: [] as string[],
  empty: false,
  loading: false,
  error: undefined as Error | undefined,
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    authenticatedUserHasPermission: (permission: string) => state.permissions.includes(permission),
  }),
}))
vi.mock('@/hooks/queries/useVolumesQuery', () => ({
  useVolumesQuery: () => ({ data: state.empty ? [] : [READY_VOLUME], isLoading: state.loading, error: state.error }),
}))
vi.mock('@/hooks/mutations/useCreateVolumeMutation', () => ({
  useCreateVolumeMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/mutations/useDeleteVolumeMutation', () => ({
  useDeleteVolumeMutation: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@/hooks/useVolumeWsSync', () => ({ useVolumeWsSync: () => undefined }))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueriesData: vi.fn(), invalidateQueries: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

/**
 * Finds a row action by its text label, matching both buttons and links.
 * Searches both element types because the "+ Box" action was previously a link.
 */
function rowAction(label: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('button, a')).find(
    (element) => element.textContent?.trim() === label,
  )
}

describe('Volumes row action "+ Box"', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    state.loading = false
    state.error = undefined
    state.empty = false
    state.permissions = [OrganizationRolePermissionsEnum.WRITE_VOLUMES, OrganizationRolePermissionsEnum.WRITE_BOXES]
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  function renderPage() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(<Volumes />)
    })
  }

  it('distinguishes volume loading and failure from successful empty data', () => {
    state.empty = true
    state.error = new Error('unavailable')
    renderPage()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Volumes are unavailable')
    expect(document.body.textContent).not.toContain('No volumes yet')
    state.error = undefined
    state.loading = true
    act(() => root!.render(<Volumes />))
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading volumes')
    expect(document.body.textContent).not.toContain('No volume matches')
  })

  it('keeps the filter and creation toolbar when no volumes exist', () => {
    state.empty = true
    renderPage()
    expect(document.querySelector('input[placeholder="Filter volumes…"]')).not.toBeNull()
    expect(rowAction('New Volume')).toBeDefined()
  })

  it('opens and cancels volume creation through the shared buttons', async () => {
    renderPage()
    await act(async () => rowAction('New Volume')!.click())
    expect(document.querySelector('input[aria-label="Volume name"]')).not.toBeNull()
    expect((rowAction('Create') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => rowAction('Cancel')!.click())

    expect(document.querySelector('input[aria-label="Volume name"]')).toBeNull()
    expect(document.body.textContent).toContain(READY_VOLUME.name)
  })

  it('restores the volume list when clearing an unmatched filter', () => {
    renderPage()
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Filter volumes…"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'no-match')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.textContent).not.toContain(READY_VOLUME.name)

    act(() => rowAction('Clear filter')!.click())

    expect(input.value).toBe('')
    expect(document.body.textContent).toContain(READY_VOLUME.name)
  })

  it('opens the create-box form on this page rather than linking away to a new tab', () => {
    renderPage()

    expect(document.querySelector('[data-testid="create-box-dialog"]')).toBeNull()
    // The regression this guards: the action used to be an anchor into
    // /boxes?createBox=1 with target="_blank", which threw away the list the
    // user was reading and started a second copy of the app.
    expect(document.querySelector('a[target="_blank"]')).toBeNull()

    const action = rowAction('+ Box')
    expect(action).toBeDefined()

    act(() => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const dialog = document.querySelector('[data-testid="create-box-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('data-open')).toBe('true')
  })

  it('hands the form the volume id, never the display name', () => {
    renderPage()

    act(() => {
      rowAction('+ Box')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // A name is only unique inside one organization; the id is the selector
    // that cannot resolve to a different volume.
    const prefill = document.querySelector('[data-testid="create-box-dialog"]')?.getAttribute('data-prefill-volume')
    expect(prefill).toBe(READY_VOLUME.id)
    expect(prefill).not.toBe(READY_VOLUME.name)
  })

  // Creating a box takes WRITE_BOXES, not WRITE_VOLUMES. While this action was
  // a link to /boxes the dialog there was behind that check, so a
  // volumes-only member never reached a form; opening it in place must not
  // hand them one that 403s on submit.
  it('hides the action from a member who may write volumes but not boxes', () => {
    state.permissions = [OrganizationRolePermissionsEnum.WRITE_VOLUMES]
    renderPage()

    expect(rowAction('+ Box')).toBeUndefined()
    expect(document.querySelector('[data-testid="create-box-dialog"]')).toBeNull()
    // The volume-scoped controls are still there — the row was not hidden
    // wholesale.
    expect(rowAction('New Volume')).toBeDefined()
  })
})
