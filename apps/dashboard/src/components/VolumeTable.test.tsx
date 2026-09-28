// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { VolumeDto, VolumeState } from '@boxlite-ai/api-client'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    authenticatedUserHasPermission: () => true,
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
})
