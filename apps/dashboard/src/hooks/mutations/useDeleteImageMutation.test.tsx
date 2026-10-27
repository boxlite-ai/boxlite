// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../queries/queryKeys'
import { useImageQuery } from '../queries/useImagesQuery'
import { useDeleteImageMutation } from './useDeleteImageMutation'

const mocks = vi.hoisted(() => ({
  deleteImage: vi.fn(),
  getImage: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ imageApi: mocks }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-1' } }),
}))

const DELETED_IMAGE = {
  id: 'img-1',
  name: 'quay.io/acme/app',
  curated: false,
  curatedRef: null,
  aliases: ['v1'],
  versionCount: 1,
  sizeBytes: 4096,
  lastUsedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  versions: [],
  history: [],
}

let deleteImage: ReturnType<typeof useDeleteImageMutation> | undefined

function DeleteProbe() {
  deleteImage = useDeleteImageMutation()
  return null
}

// Stands in for reopening the image's detail page: the same query, read the
// same way the page reads it. The route takes an id or a reference.
function DetailProbe({ idOrRef = 'img-1' }: { idOrRef?: string }) {
  const { data } = useImageQuery(idOrRef)
  return <div data-testid="detail">{data?.name ?? 'none'}</div>
}

async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('useDeleteImageMutation', () => {
  let queryClient: QueryClient
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    // The staleTime QueryProvider gives every query: a cached record inside
    // this window is served without asking the server again.
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 }, mutations: { retry: false } },
    })
    queryClient.setQueryData(queryKeys.images.list('org-1'), [DELETED_IMAGE])
    queryClient.setQueryData(queryKeys.images.usage('org-1'), { count: 1, limit: 20, knownBytes: 4096 })
    queryClient.setQueryData(queryKeys.images.detail('org-1', 'img-1'), DELETED_IMAGE)

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <DeleteProbe />
        </QueryClientProvider>,
      )
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    deleteImage = undefined
    queryClient.clear()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  async function reopenDetail(idOrRef?: string) {
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <DetailProbe idOrRef={idOrRef} />
        </QueryClientProvider>,
      )
    })
    await settle()
    return document.querySelector('[data-testid="detail"]')?.textContent
  }

  /**
   * The detail was read before the delete, so it is cached. Reopening it must
   * ask the server — which no longer has it — rather than show the record that
   * was just removed.
   */
  it('does not show a removed image when its detail page is reopened', async () => {
    mocks.deleteImage.mockResolvedValue(undefined)
    mocks.getImage.mockRejectedValue(new Error('Image not found'))

    await act(async () => {
      await deleteImage?.mutateAsync({ idOrRef: 'img-1', organizationId: 'org-1' })
    })

    expect(await reopenDetail()).toBe('none')
    expect(mocks.getImage).toHaveBeenCalledWith('img-1', 'org-1')
  })

  // The list removes by id, but a detail page opened from a link may have
  // cached the same image under its reference.
  it('does not show a removed image whose detail was opened by reference', async () => {
    queryClient.setQueryData(queryKeys.images.detail('org-1', 'quay.io/acme/app'), DELETED_IMAGE)
    mocks.deleteImage.mockResolvedValue(undefined)
    mocks.getImage.mockRejectedValue(new Error('Image not found'))

    await act(async () => {
      await deleteImage?.mutateAsync({ idOrRef: 'img-1', organizationId: 'org-1' })
    })

    expect(await reopenDetail('quay.io/acme/app')).toBe('none')
    expect(mocks.getImage).toHaveBeenCalledWith('quay.io/acme/app', 'org-1')
  })

  it('refreshes the catalog list and the usage count after a removal', async () => {
    mocks.deleteImage.mockResolvedValue(undefined)

    await act(async () => {
      await deleteImage?.mutateAsync({ idOrRef: 'img-1', organizationId: 'org-1' })
    })

    expect(mocks.deleteImage).toHaveBeenCalledWith('img-1', 'org-1')
    expect(queryClient.getQueryState(queryKeys.images.list('org-1'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(queryKeys.images.usage('org-1'))?.isInvalidated).toBe(true)
  })

  // A refused removal (409: boxes still boot from it) leaves the image in the
  // catalog, so its detail is still true and must stay.
  it('keeps the detail when the removal is refused', async () => {
    mocks.deleteImage.mockRejectedValue(new Error('still in use by box-1'))

    await act(async () => {
      await expect(deleteImage?.mutateAsync({ idOrRef: 'img-1', organizationId: 'org-1' })).rejects.toThrow(
        'still in use by box-1',
      )
    })

    expect(queryClient.getQueryData(queryKeys.images.detail('org-1', 'img-1'))).toEqual(DELETED_IMAGE)
    expect(queryClient.getQueryState(queryKeys.images.list('org-1'))?.isInvalidated).toBe(false)
  })

  it('refuses without an organization and sends nothing', async () => {
    await act(async () => {
      await expect(deleteImage?.mutateAsync({ idOrRef: 'img-1' })).rejects.toThrow('No organization selected')
    })

    expect(mocks.deleteImage).not.toHaveBeenCalled()
  })
})
