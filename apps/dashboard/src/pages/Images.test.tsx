// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drive a React controlled input the way a user typing would.
function typeInto(el: HTMLInputElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  desc?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

import Images, { imageRouteKey } from './Images'

const state = vi.hoisted(() => ({
  images: [] as unknown[],
  deleteInFlight: false,
}))

const mocks = vi.hoisted(() => ({
  deleteImage: vi.fn(),
}))

vi.mock('@/hooks/queries/useImagesQuery', () => ({
  useImagesQuery: () => ({ data: state.images, isLoading: false }),
  useImageUsageQuery: () => ({ data: { count: 1, limit: 20, knownBytes: 4096 } }),
  useImageQuery: () => ({ data: undefined, isLoading: false }),
}))
vi.mock('@/hooks/mutations/useDeleteImageMutation', () => ({
  useDeleteImageMutation: () => ({ mutateAsync: mocks.deleteImage, isPending: state.deleteInFlight }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    // Every permission, so the delete control is present and the guard under
    // test is the only thing that can hold a second request back.
    authenticatedUserHasPermission: () => true,
  }),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  generatePath: (path: string) => path,
}))

describe('imageRouteKey', () => {
  it('routes an organization image by its catalog id', () => {
    expect(imageRouteKey({ id: 'abc-123', name: 'quay.io/acme/app' })).toBe('abc-123')
  })

  /**
   * Curated images are operator configuration rather than rows, so they have no
   * id. Their short name is what the API accepts in its place — and, unlike a
   * full reference, it carries no slash to escape into the route.
   */
  it('routes a curated image by its name', () => {
    expect(imageRouteKey({ id: null, name: 'python' })).toBe('python')
  })
})

describe('removing an image', () => {
  let root: Root | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    state.images = [
      {
        id: 'img-1',
        name: 'quay.io/acme/app',
        curated: false,
        curatedRef: null,
        tags: ['v1'],
        versionCount: 1,
        sizeBytes: 4096,
        lastUsedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]
    state.deleteInFlight = false
    mocks.deleteImage.mockReset()
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  async function renderPage() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const created = createRoot(host)
    root = created
    await act(async () => created.render(React.createElement(Images)))
  }

  function buttonWithTitle(prefix: string) {
    return [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      (b.getAttribute('title') ?? '').startsWith(prefix),
    )
  }

  function confirmButton() {
    return [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Remove')
  }

  /**
   * The catalog is never empty on a successful read — the API always prepends
   * the operator's curated set — so a filter that matches nothing is the only
   * empty list a user can reach, and the one worth explaining.
   */
  it('explains an empty list as a filter miss and offers a way out', async () => {
    await renderPage()

    const search = document.querySelector<HTMLInputElement>('input[placeholder="Filter images…"]')
    if (!search) throw new Error('filter field missing')
    await act(async () => typeInto(search, 'nothing-matches-this'))

    expect(document.body.textContent).toContain('No image matches')

    const clear = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Clear filter',
    )
    await act(async () => clear?.click())

    expect(document.body.textContent).not.toContain('No image matches')
    expect(buttonWithTitle('Remove quay.io/acme/app')).toBeTruthy()
  })

  /**
   * Radix unmounts the dialog when the action is clicked, even though `open` is
   * controlled — so the confirm cannot be clicked twice. The row button can:
   * it is back on screen the moment the dialog closes, while the request is
   * still in flight, and re-opening from there sends a second DELETE whose 404
   * surfaces as a failure to remove something that was in fact removed.
   */
  it('cannot be started again from the row while the first delete is in flight', async () => {
    await renderPage()

    await act(async () => buttonWithTitle('Remove quay.io/acme/app')?.click())

    // Never settles, so the whole assertion happens inside the in-flight
    // window; the flag stands in for what react-query's isPending reports
    // while the mutation is running.
    mocks.deleteImage.mockImplementation(() => {
      state.deleteInFlight = true
      return new Promise(() => {})
    })
    await act(async () => confirmButton()?.click())

    expect(mocks.deleteImage).toHaveBeenCalledTimes(1)
    expect(confirmButton()).toBeUndefined()
    expect(buttonWithTitle('Remove quay.io/acme/app')?.disabled).toBe(true)

    await act(async () => buttonWithTitle('Remove quay.io/acme/app')?.click())

    expect(confirmButton()).toBeUndefined()
    expect(mocks.deleteImage).toHaveBeenCalledTimes(1)
  })
})
