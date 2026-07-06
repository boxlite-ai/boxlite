// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { createBoxUploadFileItem } from '@/lib/box-upload'
import { useUploadBoxFilesMutation } from './useUploadBoxFilesMutation'

const mocks = vi.hoisted(() => ({
  selectedOrganizationId: 'org-1' as string | undefined,
  uploadBoxItemViaBoxApi: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ axiosInstance: {} }),
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: mocks.selectedOrganizationId ? { id: mocks.selectedOrganizationId } : undefined,
  }),
}))

vi.mock('@/lib/cloudBox', () => ({
  uploadBoxItemViaBoxApi: mocks.uploadBoxItemViaBoxApi,
}))

describe('useUploadBoxFilesMutation', () => {
  let root: Root | null = null
  let queryClient: QueryClient
  let mutation: {
    mutateAsync: (
      variables: Parameters<ReturnType<typeof useUploadBoxFilesMutation>['mutateAsync']>[0],
    ) => Promise<unknown>
  } | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    mutation = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
    mocks.selectedOrganizationId = 'org-1'
  })

  function renderMutation() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    })

    act(() => {
      root = createRoot(host)
      renderWithProvider(<CaptureMutation />)
    })
  }

  function renderWithProvider(children: ReactNode) {
    root?.render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>)
  }

  function CaptureMutation() {
    mutation = useUploadBoxFilesMutation()
    return null
  }

  it('invalidates the organization that started the upload when a later org switch races with failure', async () => {
    renderMutation()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const upload = deferred<string>()
    const uploadError = new Error('upload failed')
    mocks.uploadBoxItemViaBoxApi.mockReturnValueOnce(upload.promise)

    let uploadPromise!: Promise<unknown>
    act(() => {
      uploadPromise = mutation!.mutateAsync({
        boxId: 'box-1',
        detailRef: 'box-public-id',
        destinationDir: '/workspace',
        items: [createBoxUploadFileItem(new File(['payload'], 'note.txt'))],
      })
    })

    await waitForMicrotask()
    expect(mocks.uploadBoxItemViaBoxApi).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'box-1',
      expect.objectContaining({ name: 'note.txt' }),
      '/workspace',
    )

    mocks.selectedOrganizationId = 'org-2'
    act(() => {
      renderWithProvider(<CaptureMutation />)
    })

    await act(async () => {
      upload.reject(uploadError)
      await expect(uploadPromise!).rejects.toThrow('upload failed')
    })

    const invalidatedKeys = invalidateSpy.mock.calls.map(([filters]) => filters.queryKey)
    expect(invalidatedKeys).toContainEqual(queryKeys.boxes.detail('org-1', 'box-1'))
    expect(invalidatedKeys).toContainEqual(queryKeys.boxes.detail('org-1', 'box-public-id'))
    expect(invalidatedKeys).not.toContainEqual(queryKeys.boxes.detail('org-2', 'box-1'))
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, reject, resolve }
}

function waitForMicrotask(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}
