// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Images from './ImagesPage'

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('@/components/images/ImageCatalog', () => ({ ImageCatalog: () => <div>CATALOG-PANEL</div> }))
vi.mock('@/components/images/RegistriesPanel', () => ({ RegistriesPanel: () => <div>REGISTRIES-PANEL</div> }))
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
}))

let root: Root | null = null

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.resetAllMocks()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function renderPage(tab: 'images' | 'registries', entry = '/dashboard/images') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <MemoryRouter initialEntries={[entry]}>
        <Images tab={tab} />
      </MemoryRouter>,
    ),
  )
}

const tab = (name: string) => [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === name)

// Images and the private registries their boxes pull from are one page: the
// reader who needs a private image is already on it.
describe('the images page', () => {
  it('shows the image list on its first tab', async () => {
    await renderPage('images')

    expect(tab('Images')?.getAttribute('aria-selected')).toBe('true')
    expect(document.body.textContent).toContain('CATALOG-PANEL')
    expect(document.body.textContent).not.toContain('REGISTRIES-PANEL')
  })

  it('shows private registries on its second tab', async () => {
    await renderPage('registries', '/dashboard/images/registries')

    expect(tab('Private registries')?.getAttribute('aria-selected')).toBe('true')
    expect(document.body.textContent).toContain('REGISTRIES-PANEL')
  })

  // Each tab is a route, so a box's pull error can link straight to the
  // second one; the query it carries names the registry to connect.
  it('moves between tabs by route, keeping the query', async () => {
    await renderPage('images', '/dashboard/images?connect=ghcr.io')

    await act(async () => {
      const trigger = tab('Private registries') as HTMLElement
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })

    expect(mocks.navigate).toHaveBeenCalledWith('/dashboard/images/registries?connect=ghcr.io')
  })
})
