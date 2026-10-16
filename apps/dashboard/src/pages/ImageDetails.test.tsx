// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteError } from '@/api/errors'
import { RoutePath } from '@/enums/RoutePath'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import ImageDetails from './ImageDetails'

const mocks = vi.hoisted(() => ({
  getImage: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ imageApi: { getImage: mocks.getImage } }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-1' } }),
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({ idOrRef: 'img-1' }),
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

const ORG_IMAGE = {
  id: 'img-1',
  name: 'quay.io/acme/app',
  curated: false,
  curatedRef: null,
  aliases: ['v1', 'latest'],
  versionCount: 2,
  sizeBytes: 4096,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  history: [],
  versions: [
    {
      id: 'ver-2',
      digest: 'sha256:bbbb',
      sizeBytes: 2048,
      aliases: ['latest'],
      lastUsedAt: null,
      upstreamMissingAt: null,
      sourceRef: 'quay.io/acme/app:latest',
      createdAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'ver-1',
      digest: 'sha256:aaaa',
      sizeBytes: 2048,
      aliases: ['v1'],
      lastUsedAt: null,
      upstreamMissingAt: null,
      sourceRef: 'quay.io/acme/app:v1',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
}

const CURATED_IMAGE = {
  ...ORG_IMAGE,
  id: null,
  name: 'python',
  curated: true,
  curatedRef: 'docker.io/library/python:3.12-slim',
  aliases: [],
  versionCount: 0,
  versions: [],
}

function text() {
  return document.body.textContent ?? ''
}

describe('ImageDetails', () => {
  let queryClient: QueryClient
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    queryClient.clear()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  async function renderPage() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <ImageDetails />
        </QueryClientProvider>,
      )
    })
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  it('reads the image the route names and lists every recorded build', async () => {
    mocks.getImage.mockResolvedValue({ data: ORG_IMAGE })
    await renderPage()

    expect(mocks.getImage).toHaveBeenCalledWith('img-1', 'org-1')
    expect(document.querySelector('h1')?.textContent).toBe('quay.io/acme/app')
    expect(text()).toContain('This organization')
    expect(text()).toContain('Aliases: v1, latest.')
    // Each row keeps the reference the caller typed, next to the digest it got.
    for (const version of ORG_IMAGE.versions) {
      expect(document.querySelector(`[title="${version.digest}"]`)?.textContent).toBe(version.digest)
      expect(document.querySelector(`[title="${version.sourceRef}"]`)?.textContent).toBe(version.sourceRef)
    }
  })

  it('says when an organization image has no build recorded yet', async () => {
    mocks.getImage.mockResolvedValue({ data: { ...ORG_IMAGE, aliases: [], versionCount: 0, versions: [] } })
    await renderPage()

    expect(text()).toContain('No versions recorded yet.')
    expect(text()).toContain('Aliases: none recorded.')
  })

  // A curated image is operator configuration: it has no catalog row to
  // remove, no limit to count against, and no builds of its own.
  it('presents a curated image as the operator’s, pinned and not removable', async () => {
    mocks.getImage.mockResolvedValue({ data: CURATED_IMAGE })
    await renderPage()

    expect(text()).toContain('Operator (curated)')
    expect(text()).toContain('pinned to docker.io/library/python:3.12-slim')
    expect(text()).toContain('cannot be removed')
    expect(text()).toContain('no versions are recorded for them')
    expect(text()).not.toContain('No versions recorded yet.')
  })

  it('shows a loading state while the image is being read', async () => {
    mocks.getImage.mockReturnValue(new Promise(() => {}))
    await renderPage()

    expect(text()).toContain('Loading…')
    expect(document.querySelector('h1')).toBeNull()
  })

  it('reports a failed read with the API’s reason and renders no record', async () => {
    mocks.getImage.mockRejectedValue(new BoxliteError('Image img-1 not found'))
    await renderPage()

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to fetch image',
      expect.objectContaining({ description: 'Image img-1 not found' }),
    )
    expect(document.querySelector('h1')).toBeNull()
  })

  it('goes back to the catalog', async () => {
    mocks.getImage.mockResolvedValue({ data: ORG_IMAGE })
    await renderPage()

    const back = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Images')
    act(() => back?.click())

    expect(mocks.navigate).toHaveBeenCalledWith(RoutePath.IMAGES)
  })
})
