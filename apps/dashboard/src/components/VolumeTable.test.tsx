// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { VolumeDto, VolumeState } from '@boxlite-ai/api-client'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { VolumeTable } from './VolumeTable'

// The bulk toast animates out, and AnimatePresence keeps an exiting element
// mounted for the duration. These tests assert on whether the toast is offered,
// not on how it leaves, so unmount it synchronously.
const MOTION_ONLY_PROPS = new Set(['initial', 'animate', 'exit', 'transition'])

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) => (props: Record<string, unknown>) =>
        createElement(tag, Object.fromEntries(Object.entries(props).filter(([key]) => !MOTION_ONLY_PROPS.has(key)))),
    },
  ),
}))

// Each test says whether its member may delete volumes.
const org = vi.hoisted(() => ({ canDelete: true }))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    authenticatedUserHasPermission: () => org.canDelete,
  }),
}))

function volume(id: string, state: VolumeState): VolumeDto {
  return {
    id,
    name: id,
    organizationId: 'org-1',
    state,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    errorReason: null,
  }
}

/** Row checkboxes, in table order. The header's "Select all" is excluded. */
function rowCheckboxes() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="Select row"]'))
}

function bulkActionButton() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.startsWith('Delete '),
  )
}

describe('VolumeTable bulk selection', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.matchMedia = () =>
      ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList
  })

  beforeEach(() => {
    org.canDelete = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  function render(data: VolumeDto[], onBulkDelete = vi.fn()) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const paint = (rows: VolumeDto[]) =>
      root?.render(
        <VolumeTable
          data={rows}
          loading={false}
          processingVolumeAction={{}}
          onDelete={vi.fn()}
          onBulkDelete={onBulkDelete}
        />,
      )
    act(() => {
      root = createRoot(host)
      paint(data)
    })
    /** Re-render with fresh rows, as a poll of the volumes list would. */
    const rerender = (rows: VolumeDto[]) => act(() => paint(rows))
    return { onBulkDelete, rerender }
  }

  it('opens the confirmation from the toast rather than deleting on the spot', () => {
    const { onBulkDelete } = render([volume('live', VolumeState.READY)])

    const [row] = rowCheckboxes()
    act(() => row.click())

    const action = bulkActionButton()
    expect(action?.textContent).toBe('Delete 1')

    act(() => action?.click())

    // Bulk delete used to be reachable only through the command palette. It is
    // the toast's job now, and it must still ask before destroying anything.
    expect(document.body.textContent).toContain('delete')
    expect(onBulkDelete).not.toHaveBeenCalled()
  })

  it('does not offer a bulk delete when the only selected volume is already deleted', () => {
    render([volume('gone', VolumeState.DELETED)])

    const [deletedRow] = rowCheckboxes()
    expect(deletedRow).toBeDefined()
    act(() => deletedRow.click())

    // A DELETED volume cannot be deleted again, so selecting it must not arm
    // the bulk action — otherwise the toast offers "Delete 0" and confirming
    // calls onBulkDelete([]).
    expect(bulkActionButton()).toBeUndefined()
  })

  it('counts only deletable volumes when the selection mixes states', () => {
    render([volume('live', VolumeState.READY), volume('gone', VolumeState.DELETED)])

    rowCheckboxes().forEach((checkbox) => act(() => checkbox.click()))

    expect(bulkActionButton()?.textContent).toBe('Delete 1')
  })

  it('drops a selection when a refresh moves that volume out of a deletable state', () => {
    const { onBulkDelete, rerender } = render([volume('doomed', VolumeState.READY)])

    const [row] = rowCheckboxes()
    act(() => row.click())
    expect(bulkActionButton()?.textContent).toBe('Delete 1')

    // The volume is deleted elsewhere and the next poll reports it.
    rerender([volume('doomed', VolumeState.DELETED)])

    // Disabling the checkbox is not enough: a selection already made would keep
    // the toast up at "Delete 0" and confirm into an empty onBulkDelete.
    expect(bulkActionButton()).toBeUndefined()
    expect(onBulkDelete).not.toHaveBeenCalled()
  })

  it('arms nothing for a member who cannot delete volumes', () => {
    org.canDelete = false
    render([volume('live', VolumeState.READY)])

    // Selection exists only to arm the bulk delete, so without the permission
    // the checkbox is inert: present in the column, but not a way in.
    const [row] = rowCheckboxes()
    expect(row.hasAttribute('disabled')).toBe(true)

    act(() => row.click())
    expect(bulkActionButton()).toBeUndefined()
  })
})
