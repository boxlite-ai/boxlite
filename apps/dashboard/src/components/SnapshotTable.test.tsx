// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { Box } from '@boxlite-ai/api-client'
import { Snapshot } from '@/lib/cloudSnapshot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from './ui/tooltip'
import { SnapshotTable } from './SnapshotTable'

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ authenticatedUserHasPermission: () => true }),
}))
const snapshot: Snapshot = {
  id: 's-1',
  name: 'checkpoint',
  sourceBoxId: 'b-1',
  status: 'ready',
  sizeBytes: 2048,
  diskGb: 10,
  createdAt: new Date().toISOString(),
}
let root: Root
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
})
function render(data: Snapshot[], boxes?: Box[]) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <MemoryRouter>
        <TooltipProvider>
          <SnapshotTable
            data={data}
            boxes={boxes}
            loading={false}
            filtered={false}
            onCreate={vi.fn()}
            onCreateBox={vi.fn()}
            createBoxEnabled
            onDelete={vi.fn()}
          />
        </TooltipProvider>
      </MemoryRouter>,
    ),
  )
}

describe('SnapshotTable', () => {
  it('renders the required columns and links an existing source', () => {
    render([snapshot], [{ id: 'b-1', name: 'source' } as Box])
    expect([...document.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
      'Name',
      'Source box',
      'Status',
      'Size',
      'Disk (GiB)',
      'Created',
      'Actions',
    ])
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/dashboard/boxes/b-1')
    expect(document.body.textContent).toContain('2.0 KiB')
  })
  it('marks a missing source deleted after the complete box listing arrives', () => {
    render([snapshot], [])
    expect(document.body.textContent).toContain('b-1 (deleted)')
    expect(document.querySelector('a')).toBeNull()
  })
  it('does not claim deletion when the box listing has not succeeded', () => {
    render([snapshot])
    expect(document.body.textContent).not.toContain('(deleted)')
  })
  it('disables both actions while creating', () => {
    render([{ ...snapshot, status: 'creating' }], [])
    expect(document.querySelector('[aria-label="Create Box from checkpoint"]')).toHaveProperty('disabled', true)
    expect(document.querySelector('[aria-label="Delete checkpoint"]')).toHaveProperty('disabled', true)
  })
  it('offers failure details on focus and allows deletion but not box creation', async () => {
    render([{ ...snapshot, status: 'failed', error: 'Upload failed' }], [])
    expect(document.querySelector('[aria-label="Create Box from checkpoint"]')).toHaveProperty('disabled', true)
    expect(document.querySelector('[aria-label="Delete checkpoint"]')).toHaveProperty('disabled', false)
    await act(async () => document.querySelector<HTMLElement>('span[tabindex="0"]')!.focus())
    expect(document.body.textContent).toContain('Upload failed')
  })
})
