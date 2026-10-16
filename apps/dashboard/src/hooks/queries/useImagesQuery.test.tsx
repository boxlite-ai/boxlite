// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useImageQuery, useImageUsageQuery, useImagesQuery } from './useImagesQuery'

const mocks = vi.hoisted(() => ({
  listImages: vi.fn(),
  getImage: vi.fn(),
  getImageUsage: vi.fn(),
}))

// Each test picks the organization the member has selected, if any.
const state = vi.hoisted(() => ({ organization: { id: 'org-1' } as { id: string } | null }))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ imageApi: mocks }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: state.organization }),
}))

let refetchAll: (() => Promise<{ error: Error | null }[]>) | undefined

function CatalogProbe({ idOrRef }: { idOrRef?: string }) {
  const list = useImagesQuery()
  const detail = useImageQuery(idOrRef)
  const usage = useImageUsageQuery()
  refetchAll = () => Promise.all([list.refetch(), detail.refetch(), usage.refetch()])
  return (
    <>
      <div data-testid="list">{list.data?.map((image) => image.name).join(',') ?? 'none'}</div>
      <div data-testid="detail">{detail.data?.name ?? 'none'}</div>
      <div data-testid="usage">{usage.data ? `${usage.data.count}/${usage.data.limit}` : 'none'}</div>
    </>
  )
}

function shown(testId: string) {
  return document.querySelector(`[data-testid="${testId}"]`)?.textContent
}

describe('image catalog queries', () => {
  let queryClient: QueryClient
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    state.organization = { id: 'org-1' }
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    mocks.listImages.mockResolvedValue({ data: [{ name: 'python' }, { name: 'quay.io/acme/app' }] })
    mocks.getImage.mockResolvedValue({ data: { name: 'quay.io/acme/app' } })
    mocks.getImageUsage.mockResolvedValue({ data: { count: 1, limit: 20, knownBytes: 4096 } })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    refetchAll = undefined
    queryClient.clear()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  async function renderProbe(idOrRef?: string) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <CatalogProbe idOrRef={idOrRef} />
        </QueryClientProvider>,
      )
    })
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  it('reads the list, one image and the usage for the selected organization', async () => {
    await renderProbe('img-1')

    expect(mocks.listImages).toHaveBeenCalledWith('org-1')
    expect(mocks.getImage).toHaveBeenCalledWith('img-1', 'org-1')
    expect(mocks.getImageUsage).toHaveBeenCalledWith('org-1')
    expect(shown('list')).toBe('python,quay.io/acme/app')
    expect(shown('detail')).toBe('quay.io/acme/app')
    expect(shown('usage')).toBe('1/20')
  })

  // Without an organization there is no catalog to read: a request now would
  // go out with an empty organization header and be answered for nobody.
  it('sends nothing until an organization is selected', async () => {
    state.organization = null
    await renderProbe('img-1')

    expect(mocks.listImages).not.toHaveBeenCalled()
    expect(mocks.getImage).not.toHaveBeenCalled()
    expect(mocks.getImageUsage).not.toHaveBeenCalled()
  })

  // `enabled` holds back automatic fetches only; a manual refetch runs the
  // query regardless, and must fail here rather than ask for nobody's catalog.
  it('fails a forced refetch without an organization instead of sending it', async () => {
    state.organization = null
    await renderProbe(undefined)

    let results: { error: Error | null }[] = []
    await act(async () => {
      results = (await refetchAll?.()) ?? []
    })

    expect(results.map((result) => result.error?.message)).toEqual([
      'No organization selected',
      'No image selected',
      'No organization selected',
    ])
    expect(mocks.listImages).not.toHaveBeenCalled()
    expect(mocks.getImage).not.toHaveBeenCalled()
    expect(mocks.getImageUsage).not.toHaveBeenCalled()
  })

  it('does not ask for a detail before the route names an image', async () => {
    await renderProbe(undefined)

    expect(mocks.getImage).not.toHaveBeenCalled()
    expect(shown('detail')).toBe('none')
    expect(mocks.listImages).toHaveBeenCalledWith('org-1')
  })
})
