// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteError } from '@/api/errors'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageCatalog } from './ImageCatalog'
import { BOX_TEMPLATES } from '@/lib/quickstart/box-templates'
import { catalogNameOf } from '@/lib/image-ref'

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
  byImage: new Map<string, unknown[]>(),
  byId: new Map<string, unknown>(),
  newBoxImage: undefined as string | undefined,
  newBoxOpen: false,
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
}))
vi.mock('@/hooks/queries/useBoxesByImageQuery', () => ({
  useBoxesByImageQuery: () => ({ byImage: state.byImage, byId: state.byId, truncated: false }),
}))
vi.mock('@/hooks/mutations/useDeleteImageMutation', () => ({
  useDeleteImageMutation: () => ({ mutateAsync: mocks.deleteImage, isPending: state.deleteInFlight }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    // Every permission unless a test withholds one.
    authenticatedUserHasPermission: (permission: string) => !state.deniedPermissions.includes(permission),
  }),
}))
// The dialogs are their own components; what matters here is what this page hands them.
vi.mock('@/components/Box/CreateBoxDialog', () => ({
  CreateBoxDialog: ({ open, prefillImage }: { open: boolean; prefillImage?: string }) => {
    state.newBoxOpen = open
    state.newBoxImage = prefillImage
    return null
  },
}))
vi.mock('@/components/images/UseImageSheet', () => ({ UseImageSheet: () => null }))
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
  aliases: ['v1'],
  versionCount: 1,
  sizeBytes: 4096,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
}

const BUILT_IN_IMAGE = {
  id: null,
  name: 'python',
  curated: true,
  curatedRef: 'docker.io/library/python:3.12-slim',
  aliases: [],
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
  state.byImage = new Map()
  state.byId = new Map()
  state.newBoxImage = undefined
  state.newBoxOpen = false
  vi.resetAllMocks()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function renderCatalog() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const created = createRoot(host)
  root = created
  await act(async () => created.render(React.createElement(MemoryRouter, null, React.createElement(ImageCatalog))))
}

function buttonWithTitle(prefix: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    (b.getAttribute('title') ?? '').startsWith(prefix),
  )
}

function confirmButton() {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Remove')
}

describe('the image list', () => {
  it.each([
    { label: 'empty', images: [] },
    { label: 'organization-only', images: [ORG_IMAGE] },
    { label: 'system and organization', images: [BUILT_IN_IMAGE, ORG_IMAGE] },
  ])('lists only API images for an $label catalog', async ({ images }) => {
    state.images = images
    await renderCatalog()

    expect(document.querySelectorAll('button[title^="New box from "]')).toHaveLength(images.length)
    const search = document.querySelector<HTMLInputElement>('input[placeholder="Filter images…"]')
    expect(search?.nextElementSibling?.textContent).toBe(String(images.length))
    for (const template of BOX_TEMPLATES) {
      expect(buttonWithTitle(`New box from ${template.name}`)).toBeUndefined()
    }
  })

  it('explains an empty image catalog without a standalone create button', async () => {
    state.images = []
    await renderCatalog()
    expect(document.body.textContent).toContain('No images yet')
    expect(document.body.textContent).toContain('Boxes page')
  })

  it('does not find a Quickstart-only template when filtering images', async () => {
    await renderCatalog()

    const search = document.querySelector<HTMLInputElement>('input[placeholder="Filter images…"]')
    if (!search) throw new Error('filter field missing')
    await act(async () => typeInto(search, BOX_TEMPLATES[0].image))

    expect(document.querySelectorAll('button[title^="New box from "]')).toHaveLength(0)
    expect(document.body.textContent).toContain('No image matches')
    expect(search.nextElementSibling?.textContent).toBe('0')
  })

  it.each([{ images: [] }, { images: [ORG_IMAGE] }])(
    'only creates boxes from catalog image actions',
    async ({ images }) => {
      state.images = images
      await renderCatalog()
      const actions = [...document.querySelectorAll('button')].filter(
        (button) => button.textContent?.trim() === 'New box',
      )
      expect(actions).toHaveLength(images.length)
      expect(actions.every((button) => button.title.startsWith('New box from '))).toBe(true)
    },
  )

  it('labels the custom-image quota without presenting declared bytes as storage usage', async () => {
    await renderCatalog()

    expect(document.body.textContent).toContain('Custom images 1 / 20')
    const quota = [...document.querySelectorAll('span')].find((span) => span.textContent?.startsWith('Custom images'))
    expect(quota?.textContent).toBe('Custom images 1 / 20')
    expect(document.body.textContent).toContain('Total image size 4.0 KiB')
  })

  it.each([16, 20])('keeps quota guidance at %s images', async (count) => {
    state.usage = { count, limit: 20, knownBytes: 4096 }
    await renderCatalog()

    expect(document.body.textContent).toContain(`Custom images ${count} / 20`)
    expect(document.body.textContent?.includes('At the limit. Remove an image, or contact us to raise it.')).toBe(
      count === 20,
    )
  })

  it('lists built-in images in searchable rows, with no way to remove them', async () => {
    state.images = [BUILT_IN_IMAGE, ORG_IMAGE]
    await renderCatalog()

    expect(document.body.textContent).not.toContain('Built-in')
    expect(buttonWithTitle('docker.io/library/python:3.12-slim')?.textContent).toBe('python')
    expect(buttonWithTitle('Remove python')).toBeUndefined()
    expect(buttonWithTitle('Remove quay.io/acme/app')).toBeTruthy()
  })

  it.each([false, true])('allows removal of an owned image matching a template (extra tag: %s)', async (extraTag) => {
    const template = BOX_TEMPLATES[0]
    const name = catalogNameOf(template.image)
    const tag = template.image.slice(template.image.lastIndexOf(':') + 1)
    state.images = [
      { ...ORG_IMAGE, id: 'img-template', name, aliases: extraTag ? ['other-version', tag] : [tag] },
      ORG_IMAGE,
    ]
    await renderCatalog()

    expect(document.querySelectorAll('button[title^="New box from "]')).toHaveLength(2)
    expect(buttonWithTitle(`Remove ${name}`)).toBeDefined()
    await act(async () => buttonWithTitle(`Remove ${name}`)!.click())
    await act(async () => confirmButton()!.click())
    expect(mocks.deleteImage).toHaveBeenCalledWith({ idOrRef: 'img-template', organizationId: 'org-1' })
    expect(buttonWithTitle('Remove quay.io/acme/app')).toBeTruthy()
  })

  it('offers no removal to a member who may not delete images', async () => {
    state.deniedPermissions = [OrganizationRolePermissionsEnum.DELETE_IMAGES]
    await renderCatalog()

    expect(document.body.textContent).toContain('quay.io/acme/app')
    expect(buttonWithTitle('Remove quay.io/acme/app')).toBeUndefined()
  })

  it('opens an image by its catalog id', async () => {
    await renderCatalog()

    const name = [...document.querySelectorAll('button')].find((b) => b.textContent === 'quay.io/acme/app')
    await act(async () => name?.click())

    expect(mocks.navigate).toHaveBeenCalledWith('/dashboard/images/img-1')
  })

  // The boxes that still reference an image are what block its removal, so
  // the count is on the row before anyone tries.
  it('counts the boxes that reference each image', async () => {
    state.byImage = new Map([['quay.io/acme/app', [{ id: 'b1' }, { id: 'b2' }]]])
    await renderCatalog()

    const row = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'quay.io/acme/app',
    )?.parentElement
    expect(row?.textContent).toContain('2')
  })

  it('reports failed reads and draws no usage it cannot back', async () => {
    state.images = []
    state.imagesError = new BoxliteError('catalog unavailable')
    state.usage = undefined
    state.usageError = new BoxliteError('usage unavailable')
    await renderCatalog()

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to fetch images',
      expect.objectContaining({ description: 'catalog unavailable' }),
    )
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to fetch image usage',
      expect.objectContaining({ description: 'usage unavailable' }),
    )
    expect(document.body.textContent).not.toContain('Custom images')
    expect(document.querySelectorAll('button[title^="New box from "]')).toHaveLength(0)
  })
})

describe('starting a box', () => {
  // An image has no create of its own; a box start is what adds one. The row
  // hands its reference, first tag included, to the box create.
  it('opens the box create with the row’s reference filled in', async () => {
    await renderCatalog()

    await act(async () => buttonWithTitle('New box from quay.io/acme/app:v1')?.click())

    expect(state.newBoxOpen).toBe(true)
    expect(state.newBoxImage).toBe('quay.io/acme/app:v1')
  })

  // The create API takes a built-in image under its short name.
  it('opens the built-in template with its startup configuration', async () => {
    state.images = [BUILT_IN_IMAGE]
    await renderCatalog()

    await act(async () => buttonWithTitle('New box from python')?.click())

    expect(mocks.navigate).toHaveBeenCalledWith('/dashboard/quickstart?method=console&template=python')
  })

  it('offers no box creation without Box write permission', async () => {
    state.deniedPermissions = [OrganizationRolePermissionsEnum.WRITE_BOXES]
    await renderCatalog()

    expect([...document.querySelectorAll('button')].filter((b) => b.textContent === 'New box')).toHaveLength(0)
    expect(state.newBoxOpen).toBe(false)
  })
})

describe('removing an image', () => {
  it('removes the image the row names and confirms it', async () => {
    mocks.deleteImage.mockResolvedValue(undefined)
    await renderCatalog()

    await act(async () => buttonWithTitle('Remove quay.io/acme/app')?.click())
    await act(async () => confirmButton()?.click())

    expect(mocks.deleteImage).toHaveBeenCalledWith({ idOrRef: 'img-1', organizationId: 'org-1' })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Removed quay.io/acme/app', expect.anything())
    expect(confirmButton()).toBeUndefined()
  })

  /**
   * The API refuses while boxes still reference the image, and names them by
   * id. Ids are not something a member can act on, so the refusal names the
   * boxes as they know them.
   */
  it('names the boxes a refusal lists, rather than their ids', async () => {
    state.byId = new Map([
      ['box-1', { id: 'box-1', name: 'agile-otter' }],
      ['box-2', { id: 'box-2', name: 'quiet-heron' }],
    ])
    mocks.deleteImage.mockRejectedValue(
      new BoxliteError(
        "Image 'quay.io/acme/app' cannot be removed while 2 box(es) can still boot from it: box-1, box-2",
      ),
    )
    await renderCatalog()

    await act(async () => buttonWithTitle('Remove quay.io/acme/app')?.click())
    await act(async () => confirmButton()?.click())

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    const [title, options] = mocks.toastError.mock.calls[0]
    expect(title).toBe('quay.io/acme/app is still referenced')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const descriptionRoot = createRoot(host)
    await act(async () =>
      descriptionRoot.render(
        React.createElement(MemoryRouter, null, (options as { description: React.ReactNode }).description),
      ),
    )
    expect(host.textContent).toContain('agile-otter')
    expect(host.textContent).toContain('quiet-heron')
    expect(host.textContent).not.toContain('box-1')
    act(() => descriptionRoot.unmount())
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('reports any other failure with the API’s reason', async () => {
    mocks.deleteImage.mockRejectedValue(new BoxliteError('catalog is read-only'))
    await renderCatalog()

    await act(async () => buttonWithTitle('Remove quay.io/acme/app')?.click())
    await act(async () => confirmButton()?.click())

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to remove quay.io/acme/app',
      expect.objectContaining({ description: 'catalog is read-only' }),
    )
  })

  it('explains an empty list as a filter miss and offers a way out', async () => {
    await renderCatalog()

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
   * Radix unmounts the dialog when the action is clicked, so the row button is
   * back on screen while the request is still in flight; re-opening from there
   * would send a second DELETE.
   */
  it('cannot be started again from the row while the first delete is in flight', async () => {
    await renderCatalog()

    await act(async () => buttonWithTitle('Remove quay.io/acme/app')?.click())

    mocks.deleteImage.mockImplementation(() => {
      state.deleteInFlight = true
      return new Promise(() => {})
    })
    await act(async () => confirmButton()?.click())

    expect(mocks.deleteImage).toHaveBeenCalledTimes(1)
    expect(buttonWithTitle('Remove quay.io/acme/app')?.disabled).toBe(true)

    await act(async () => buttonWithTitle('Remove quay.io/acme/app')?.click())

    expect(confirmButton()).toBeUndefined()
    expect(mocks.deleteImage).toHaveBeenCalledTimes(1)
  })
})
