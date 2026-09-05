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
const state = vi.hoisted(() => ({ permissions: [] as string[] }))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    authenticatedUserHasPermission: (permission: string) => state.permissions.includes(permission),
  }),
}))
vi.mock('@/hooks/queries/useVolumesQuery', () => ({
  useVolumesQuery: () => ({ data: [READY_VOLUME], isLoading: false, error: undefined }),
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
