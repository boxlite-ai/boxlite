// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BoxFileUploadControl } from './BoxFileUploadControl'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

describe('BoxFileUploadControl', () => {
  let root: Root | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  function renderControl(onUpload = vi.fn(), onError = vi.fn()) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <BoxFileUploadControl
          disabled={false}
          destinationDir="/workspace"
          isUploading={false}
          onError={onError}
          onUpload={onUpload}
        />,
      )
    })
    return { onError, onUpload }
  }

  function createDragEvent(type: string, dataTransfer?: Partial<DataTransfer>): Event {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      configurable: true,
      value: dataTransfer ?? { files: [], items: [] },
    })
    return event
  }

  async function flushAsyncDrop() {
    await Promise.resolve()
    await Promise.resolve()
  }

  it('shows where uploaded files land before the user selects anything', () => {
    renderControl()

    expect(document.body.textContent).toContain('Upload')
    expect(document.querySelectorAll('button')).toHaveLength(1)
    expect(document.body.textContent).toContain('/workspace')
    expect(document.body.textContent).toContain('Drop files or folders here')
  })

  it('shows the fixed workspace target while files are dragging over the upload target', () => {
    renderControl()
    const dropTarget = document.querySelector<HTMLElement>('[data-testid="box-file-drop-target"]')

    act(() => {
      dropTarget?.dispatchEvent(createDragEvent('dragenter'))
    })

    expect(document.body.textContent).toContain('Drop to upload into /workspace')
  })

  it('passes selected files from the hidden file picker', () => {
    const { onUpload } = renderControl()
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    const input = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[0]

    act(() => {
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [file],
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onUpload).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'file',
        name: 'note.txt',
        files: [{ file, relativePath: 'note.txt' }],
      }),
    ])
  })

  it('builds dropped folders with relative paths', async () => {
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    const noteEntry = {
      isDirectory: false,
      isFile: true,
      name: 'note.txt',
      file: (resolve: (file: File) => void) => resolve(file),
    }
    const docsEntry = {
      isDirectory: true,
      isFile: false,
      name: 'docs',
      createReader: () => ({
        readEntries: vi
          .fn()
          .mockImplementationOnce((resolve: (entries: unknown[]) => void) => resolve([noteEntry]))
          .mockImplementationOnce((resolve: (entries: unknown[]) => void) => resolve([])),
      }),
    }
    const projectEntry = {
      isDirectory: true,
      isFile: false,
      name: 'project',
      createReader: () => ({
        readEntries: vi
          .fn()
          .mockImplementationOnce((resolve: (entries: unknown[]) => void) => resolve([docsEntry]))
          .mockImplementationOnce((resolve: (entries: unknown[]) => void) => resolve([])),
      }),
    }

    const { onUpload } = renderControl()
    const dropTarget = document.querySelector<HTMLElement>('[data-testid="box-file-drop-target"]')

    await act(async () => {
      dropTarget?.dispatchEvent(
        createDragEvent('drop', {
          files: [] as unknown as FileList,
          items: [{ webkitGetAsEntry: () => projectEntry }] as unknown as DataTransferItemList,
        }),
      )
      await flushAsyncDrop()
    })

    expect(onUpload).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'directory',
        name: 'project',
        files: [{ file, relativePath: 'docs/note.txt' }],
      }),
    ])
  })

  it('builds dropped files when directory entries are unavailable', async () => {
    const { onUpload } = renderControl()
    const file = new File(['payload'], 'archive.zip', { type: 'application/zip' })
    const dropTarget = document.querySelector<HTMLElement>('[data-testid="box-file-drop-target"]')

    await act(async () => {
      dropTarget?.dispatchEvent(createDragEvent('drop', { files: [file] as unknown as FileList }))
      await flushAsyncDrop()
    })

    expect(onUpload).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'file',
        name: 'archive.zip',
        files: [{ file, relativePath: 'archive.zip' }],
      }),
    ])
  })

  it('surfaces dropped folder read failures', async () => {
    const { onError, onUpload } = renderControl()
    const readError = new DOMException('not readable', 'NotReadableError')
    const folderEntry = {
      isDirectory: true,
      isFile: false,
      name: 'project',
      createReader: () => ({
        readEntries: (_resolve: (entries: unknown[]) => void, reject: (error: DOMException) => void) =>
          reject(readError),
      }),
    }
    const dropTarget = document.querySelector<HTMLElement>('[data-testid="box-file-drop-target"]')

    await act(async () => {
      dropTarget?.dispatchEvent(
        createDragEvent('drop', {
          files: [] as unknown as FileList,
          items: [{ webkitGetAsEntry: () => folderEntry }] as unknown as DataTransferItemList,
        }),
      )
      await flushAsyncDrop()
    })

    expect(onError).toHaveBeenCalledWith(readError)
    expect(onUpload).not.toHaveBeenCalled()
  })
})
