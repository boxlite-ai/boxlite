// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteError } from '@/api/errors'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Images, { imageRouteKey } from './Images'

// Drive a React controlled input the way a user typing would.
function typeInto(el: HTMLInputElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  desc?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const state = vi.hoisted(() => ({
  images: [] as unknown[],
  imagesError: null as Error | null,
  usage: undefined as unknown,
  usageError: null as Error | null,
  deleteInFlight: false,
  deniedPermissions: [] as string[],
}))

const mocks = vi.hoisted(() => ({
  deleteImage: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@/hooks/queries/useImagesQuery', () => ({
  useImagesQuery: () => ({ data: state.images, error: state.imagesError, isLoading: false }),
  useImageUsageQuery: () => ({ data: state.usage, error: state.usageError }),
  useImageQuery: () => ({ data: undefined, isLoading: false }),
}))
vi.mock('@/hooks/mutations/useDeleteImageMutation', () => ({
  useDeleteImageMutation: () => ({ mutateAsync: mocks.deleteImage, isPending: state.deleteInFlight }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    // Every permission unless a test withholds one, so the delete control is
    // present and the guard under test is the only thing that can hold a
    // second request back.
    authenticatedUserHasPermission: (permission: string) => !state.deniedPermissions.includes(permission),
  }),
}))
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }))

const ORG_IMAGE = {
  id: 'img-1',
  name: 'quay.io/acme/app',
  curated: false,
  curatedRef: null,
  tags: ['v1'],
  versionCount: 1,
  sizeBytes: 4096,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
}

const CURATED_IMAGE = {
  id: null,
  name: 'python',
  curated: true,
  curatedRef: 'docker.io/library/python:3.12-slim',
  tags: [],
  versionCount: 0,
  sizeBytes: null,
  lastUsedAt: null,
  createdAt: null,
}

let root: Root | null = null

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  state.images = [ORG_IMAGE]
  state.imagesError = null
  state.usage = { count: 1, limit: 20, knownBytes: 4096 }
  state.usageError = null
  state.deleteInFlight = false
  state.deniedPermissions = []
  vi.resetAllMocks()
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

describe('the catalog', () => {
  it('shows how much of the image limit the organization uses', async () => {
    await renderPage()

    expect(document.body.textContent).toContain('1 / 20')
    expect(document.body.textContent).toContain('declare 4.0 KiB in total')
  })

  // The operator's images belong to no organization: there is nothing here to
  // remove and no versions of this organization's to count.
  it('marks a curated row and offers no way to remove it', async () => {
    state.images = [CURATED_IMAGE, ORG_IMAGE]
    await renderPage()

    const rowNames = [...document.querySelectorAll('button')].map((b) => b.textContent).filter(Boolean)
    expect(rowNames).toContain('pythoncurated')
    expect(rowNames).toContain('quay.io/acme/app')
    expect(buttonWithTitle('Remove python')).toBeUndefined()
    expect(buttonWithTitle('Remove quay.io/acme/app')).toBeTruthy()
  })

  it('offers no removal to a member who may not delete images', async () => {
    state.deniedPermissions = [OrganizationRolePermissionsEnum.DELETE_IMAGES]
    await renderPage()

    expect(document.body.textContent).toContain('quay.io/acme/app')
    expect(buttonWithTitle('Remove quay.io/acme/app')).toBeUndefined()
  })

  it('opens an image by its catalog id', async () => {
    await renderPage()

    const name = [...document.querySelectorAll('button')].find((b) => b.textContent === 'quay.io/acme/app')
    await act(async () => name?.click())

    expect(mocks.navigate).toHaveBeenCalledWith('/dashboard/images/img-1')
  })

  it('reports failed reads and draws no usage bar it cannot back', async () => {
    state.images = []
    state.imagesError = new BoxliteError('catalog unavailable')
    state.usage = undefined
    state.usageError = new BoxliteError('usage unavailable')
    await renderPage()

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to fetch images',
      expect.objectContaining({ description: 'catalog unavailable' }),
    )
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to fetch image usage',
      expect.objectContaining({ description: 'usage unavailable' }),
    )
    expect(document.body.textContent).not.toContain('Catalog')
  })
})

describe('removing an image', () => {
  it('removes the image the row names and confirms it', async () => {
    mocks.deleteImage.mockResolvedValue(undefined)
    await renderPage()

    await act(async () => buttonWithTitle('Remove quay.io/acme/app')?.click())
    await act(async () => confirmButton()?.click())

    expect(mocks.deleteImage).toHaveBeenCalledWith({ idOrRef: 'img-1', organizationId: 'org-1' })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Removed quay.io/acme/app from the catalog')
    expect(confirmButton()).toBeUndefined()
  })

  /**
   * The API refuses while boxes can still boot from the image, and its message
   * names them. That list is what the member needs to act on, so it must reach
   * them as the API wrote it.
   */
  it('surfaces a refusal with the boxes that still hold the image', async () => {
    const refusal = "Image 'quay.io/acme/app' cannot be removed while 2 box(es) can still boot from it: box-1, box-2"
    mocks.deleteImage.mockRejectedValue(new BoxliteError(refusal))
    await renderPage()

    await act(async () => buttonWithTitle('Remove quay.io/acme/app')?.click())
    await act(async () => confirmButton()?.click())

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to remove quay.io/acme/app',
      expect.objectContaining({ description: refusal }),
    )
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(confirmButton()).toBeUndefined()
  })

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
