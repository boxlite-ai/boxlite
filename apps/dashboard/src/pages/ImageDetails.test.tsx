// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteError } from '@/api/errors'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImageDetails from './ImageDetails'

function typeInto(el: HTMLInputElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  desc?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const state = vi.hoisted(() => ({
  image: undefined as unknown,
  isLoading: false,
  error: null as Error | null,
  byImage: new Map<string, unknown[]>(),
  deniedPermissions: [] as string[],
  newBoxImage: undefined as string | undefined,
}))

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  pin: vi.fn(),
  unpin: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@/hooks/queries/useImagesQuery', () => ({
  useImageQuery: () => ({ data: state.image, isLoading: state.isLoading, error: state.error }),
}))
vi.mock('@/hooks/queries/useBoxesByImageQuery', () => ({
  useBoxesByImageQuery: () => ({ byImage: state.byImage, truncated: false }),
}))
vi.mock('@/hooks/mutations/useImageAliasMutations', () => ({
  usePinImageTagMutation: () => ({ mutateAsync: mocks.pin, isPending: false }),
  useUnpinImageTagMutation: () => ({ mutateAsync: mocks.unpin, isPending: false }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    organizationMembers: [{ userId: 'auth0|chen', name: 'Chen Ming', email: 'chen@example.com' }],
    authenticatedUserHasPermission: (permission: string) => !state.deniedPermissions.includes(permission),
  }),
}))
vi.mock('@/components/Box/CreateBoxDialog', () => ({
  CreateBoxDialog: ({ prefillImage }: { prefillImage?: string }) => {
    state.newBoxImage = prefillImage
    return null
  },
}))
vi.mock('@/components/images/UseImageSheet', () => ({ UseImageSheet: () => null }))
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ idOrRef: 'img-1' }),
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }))

const DIGEST_NEW = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const DIGEST_OLD = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const ORG_IMAGE = {
  id: 'img-1',
  name: 'quay.io/acme/app',
  curated: false,
  curatedRef: null,
  aliases: ['latest', 'v1'],
  versionCount: 2,
  sizeBytes: 4096,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  history: [
    {
      aliasName: 'latest',
      fromVersionId: null,
      fromDigest: null,
      toVersionId: 'ver-2',
      toDigest: DIGEST_NEW,
      actorId: 'auth0|chen',
      createdAt: '2026-01-02T00:00:00.000Z',
    },
    {
      aliasName: 'v1',
      fromVersionId: null,
      fromDigest: null,
      toVersionId: 'ver-1',
      toDigest: DIGEST_OLD,
      actorId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  versions: [
    {
      id: 'ver-2',
      digest: DIGEST_NEW,
      sizeBytes: 2048,
      aliases: ['latest'],
      lastUsedAt: null,
      upstreamMissingAt: null,
      sourceRef: 'quay.io/acme/app:latest',
      createdAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'ver-1',
      digest: DIGEST_OLD,
      sizeBytes: 2048,
      aliases: ['v1'],
      lastUsedAt: '2026-01-01T00:00:00.000Z',
      upstreamMissingAt: '2026-01-03T00:00:00.000Z',
      sourceRef: 'quay.io/acme/app:v1',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
}

const BUILT_IN_IMAGE = {
  ...ORG_IMAGE,
  id: null,
  name: 'python',
  curated: true,
  curatedRef: 'docker.io/library/python:3.12-slim',
  aliases: [],
  versionCount: 0,
  sizeBytes: null,
  versions: [],
  history: [],
}

let root: Root | null = null

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  state.image = ORG_IMAGE
  state.isLoading = false
  state.error = null
  state.byImage = new Map()
  state.deniedPermissions = []
  state.newBoxImage = undefined
  vi.resetAllMocks()
  mocks.pin.mockResolvedValue(undefined)
  mocks.unpin.mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function renderPage() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <MemoryRouter>
        <ImageDetails />
      </MemoryRouter>,
    ),
  )
}

const text = () => document.body.textContent ?? ''
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label)
const buttons = (label: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent === label)

describe('an organization image', () => {
  it('lists its tags with the digest each is pinned to, and every version', async () => {
    await renderPage()

    expect(text()).toContain('quay.io/acme/app')
    expect(text()).toContain('2 pinned')
    expect(text()).toContain(DIGEST_NEW)
    expect(text()).toContain(DIGEST_OLD)
    expect(text()).toContain('quay.io/acme/app:v1')
  })

  // Recorded once and never cleared, so it is a past event, not a live state;
  // the copy BoxLite holds still starts boxes.
  it('marks a version a pull found gone upstream, in the past tense', async () => {
    await renderPage()

    expect(text()).toContain('Gone upstream')
    const mark = [...document.querySelectorAll('span')].find((s) => s.textContent?.startsWith('Gone upstream'))
    expect(mark?.getAttribute('title')).toContain("BoxLite's copy still starts boxes")
  })

  it('names who pinned each tag: a member by name, or the first pull', async () => {
    await renderPage()

    expect(text()).toContain('Chen Ming')
    expect(text()).not.toContain('auth0|chen')
    expect(text()).toContain('first pull')
    expect(text()).toContain('unpins are not recorded')
  })

  it('says when no version has been recorded yet', async () => {
    state.image = { ...ORG_IMAGE, versions: [], versionCount: 0, aliases: [], history: [] }
    await renderPage()

    expect(text()).toContain('No versions recorded yet.')
    expect(text()).toContain('No tag is pinned.')
  })

  // Every box not destroyed blocks removal, stopped ones included, so they
  // are listed where the reader can open them.
  it('lists the boxes that still reference it', async () => {
    state.byImage = new Map([
      [
        'quay.io/acme/app',
        [
          { id: 'b1', name: 'agile-otter', state: 'started', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'b2', name: 'quiet-heron', state: 'stopped', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      ],
    ])
    await renderPage()

    const links = [...document.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])
    expect(links).toContainEqual(['agile-otter', '/dashboard/boxes/b1'])
    expect(links).toContainEqual(['quiet-heron', '/dashboard/boxes/b2'])
    expect(text()).toContain('all must be destroyed before removal')
  })

  it('says it can be removed when no box references it', async () => {
    await renderPage()

    expect(text()).toContain('No box references it, so it can be removed.')
  })
})

describe('starting a box', () => {
  it('starts a box at the image’s first tag', async () => {
    await renderPage()

    await act(async () => button('New box')?.click())

    expect(state.newBoxImage).toBe('quay.io/acme/app:latest')
  })

  // Pinned to the digest, so a tag moved later cannot change what it runs.
  it('starts a box pinned to one version’s digest', async () => {
    await renderPage()

    const versionButton = document.querySelector<HTMLButtonElement>('button[title="New box pinned to this digest"]')
    await act(async () => versionButton?.click())

    expect(state.newBoxImage).toBe(`quay.io/acme/app@${DIGEST_NEW}`)
  })

  it('offers no box start to a member who may not create boxes', async () => {
    state.deniedPermissions = [OrganizationRolePermissionsEnum.WRITE_BOXES]
    await renderPage()

    expect(button('New box')).toBeUndefined()
    expect(document.querySelector('button[title="New box pinned to this digest"]')).toBeNull()
  })
})

describe('pinning and unpinning tags', () => {
  it('pins a tag to the version chosen', async () => {
    await renderPage()
    await act(async () => button('Pin a tag')?.click())

    await act(async () => typeInto(document.getElementById('pin-tag') as HTMLInputElement, 'stable'))
    await act(async () => (document.getElementById('pin-tag') as HTMLInputElement).form?.requestSubmit())

    expect(mocks.pin).toHaveBeenCalledWith({
      idOrRef: 'img-1',
      alias: 'stable',
      versionId: 'ver-2',
      organizationId: 'org-1',
    })
  })

  // The API refuses an existing name even for the same version; the form says
  // so before sending, and what to do instead.
  it('refuses a tag that is already pinned before sending it', async () => {
    await renderPage()
    await act(async () => button('Pin a tag')?.click())

    await act(async () => typeInto(document.getElementById('pin-tag') as HTMLInputElement, 'v1'))

    expect(text()).toContain('v1 is already pinned. Unpin it first.')
    expect(button('Pin')?.disabled).toBe(true)
  })

  it('refuses a name that is not OCI tag syntax before sending it', async () => {
    await renderPage()
    await act(async () => button('Pin a tag')?.click())

    await act(async () => typeInto(document.getElementById('pin-tag') as HTMLInputElement, '-bad'))

    expect(text()).toContain('Letters, digits')
    expect(button('Pin')?.disabled).toBe(true)
  })

  it('reports the API’s reason when a pin is refused', async () => {
    mocks.pin.mockRejectedValue(new BoxliteError('version is not ready'))
    await renderPage()
    await act(async () => button('Pin a tag')?.click())
    await act(async () => typeInto(document.getElementById('pin-tag') as HTMLInputElement, 'stable'))
    await act(async () => (document.getElementById('pin-tag') as HTMLInputElement).form?.requestSubmit())

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Could not pin stable',
      expect.objectContaining({ description: 'version is not ready' }),
    )
  })

  it('unpins the tag its row names', async () => {
    await renderPage()

    await act(async () => buttons('Unpin')[1]?.click())

    expect(mocks.unpin).toHaveBeenCalledWith({ idOrRef: 'img-1', alias: 'v1', organizationId: 'org-1' })
  })

  it('offers no pin or unpin to a member who may not change images', async () => {
    state.deniedPermissions = [OrganizationRolePermissionsEnum.WRITE_IMAGES]
    await renderPage()

    expect(button('Pin a tag')).toBeUndefined()
    expect(buttons('Unpin')).toHaveLength(0)
  })
})

describe('a built-in image', () => {
  // Operator configuration: nothing of this organization's to pin, count or remove.
  it('is presented as built-in, with its tag managed and nothing to pin', async () => {
    state.image = BUILT_IN_IMAGE
    await renderPage()

    expect(text()).toContain('Built-in')
    expect(text()).toContain('docker.io/library/python:3.12-slim')
    expect(text()).toContain('not counted against your limit')
    expect(button('Pin a tag')).toBeUndefined()
    expect(text()).not.toContain('Pin history')
  })

  it('starts a box under its short name', async () => {
    state.image = BUILT_IN_IMAGE
    await renderPage()

    await act(async () => button('New box')?.click())

    expect(state.newBoxImage).toBe('python')
  })
})

describe('reading the image', () => {
  it('shows a loading state while the image is being read', async () => {
    state.image = undefined
    state.isLoading = true
    await renderPage()

    expect(text()).toContain('Loading…')
  })

  it('reports a failed read with the API’s reason and renders no record', async () => {
    state.image = undefined
    state.error = new BoxliteError('image not found')
    await renderPage()

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to fetch image',
      expect.objectContaining({ description: 'image not found' }),
    )
    expect(text()).not.toContain('Tags')
    expect(button('Pin a tag')).toBeUndefined()
  })

  it('goes back to the images list', async () => {
    await renderPage()

    await act(async () => button('Images')?.click())

    expect(mocks.navigate).toHaveBeenCalledWith('/dashboard/images')
  })
})
