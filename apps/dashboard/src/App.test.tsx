// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Outlet, useLocation, useParams } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import App from './App'

// The route table is what is under test, so everything it mounts around a page
// is a pass-through and every page is a marker naming itself.
vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ error: undefined, isAuthenticated: false, user: undefined, removeUser: vi.fn() }),
}))
vi.mock('posthog-js/react', () => ({ usePostHog: () => undefined }))
vi.mock('./hooks/useConfig', () => ({ useConfig: () => ({}) }))

const { passThrough } = vi.hoisted(() => ({
  passThrough: ({ children }: { children?: React.ReactNode }) => children,
}))
vi.mock('./providers/ApiProvider', () => ({ ApiProvider: passThrough }))
vi.mock('@/providers/OrganizationsProvider', () => ({ OrganizationsProvider: passThrough }))
vi.mock('@/providers/SelectedOrganizationProvider', () => ({ SelectedOrganizationProvider: passThrough }))
vi.mock('./providers/RegionsProvider', () => ({ RegionsProvider: passThrough }))
vi.mock('@/providers/NotificationSocketProvider', () => ({ NotificationSocketProvider: passThrough }))
vi.mock('./providers/BoxSessionProvider', () => ({ BoxSessionProvider: passThrough }))
vi.mock('./components/Banner', () => ({ BannerProvider: passThrough }))

vi.mock('./pages/Dashboard', () => ({ default: () => <Outlet /> }))
vi.mock('./pages/LandingPage', () => ({ default: () => <p>landing page</p> }))
vi.mock('./pages/Logout', () => ({ default: () => <p>logout page</p> }))
vi.mock('./pages/NotFound', () => ({ default: () => <p>not found page</p> }))
vi.mock('./pages/Boxes', () => ({
  default: function BoxesMarker() {
    return <p>boxes page at {useLocation().pathname}</p>
  },
}))
vi.mock('./pages/ImagesPage', () => ({
  default: function ImagesMarker({ tab }: { tab: string }) {
    return <p>images page, {tab} tab</p>
  },
}))
vi.mock('./pages/ImageDetails', () => ({
  default: function ImageDetailsMarker() {
    return <p>image details page for {useParams().idOrRef}</p>
  },
}))

describe('App routes', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  async function renderAt(path: string) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      )
    })
    // The pages are lazy chunks: let the dynamic imports settle.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    return document.body.textContent
  }

  // A dashboard path without its own route ends on the box list (hidden) or on
  // not-found (unknown); the catalog is reachable only if both of its paths
  // mount their pages.
  it('opens the image catalog', async () => {
    expect(await renderAt('/dashboard/images')).toBe('images page, images tab')
  })

  // `registries` is a static segment under the same prefix as `:idOrRef`; it
  // must reach its tab rather than read as an image named "registries".
  it('opens private registries as the second tab of Images', async () => {
    expect(await renderAt('/dashboard/images/registries')).toBe('images page, registries tab')
  })

  it('sends the old registries path to its tab', async () => {
    expect(await renderAt('/dashboard/registries')).toBe('images page, registries tab')
  })

  it('opens one image by the id in its path', async () => {
    expect(await renderAt('/dashboard/images/img-1')).toBe('image details page for img-1')
  })

  it('still bounces a hidden route to the box list', async () => {
    expect(await renderAt('/dashboard/members')).toBe('boxes page at /dashboard/boxes')
  })
})
