// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BoxFileUploadControl, buildDroppedUploadItems } from './BoxFileUploadControl'

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

  function renderUploadingControl() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <BoxFileUploadControl
          disabled={false}
          destinationDir="/workspace"
          isUploading
          onError={vi.fn()}
          onUpload={vi.fn()}
        />,
      )
    })
  }

  it('shows only the compact upload action before the user selects anything', () => {
    renderControl()

    expect(document.body.textContent).toContain('Upload Files')
    expect(document.body.textContent).toContain('Folder')
    expect(document.querySelectorAll('button')).toHaveLength(2)
    expect(document.querySelector('[data-testid="box-file-drop-target"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Drop files or folders here')
  })

  it('shows a loading spinner while an upload is pending', () => {
    renderUploadingControl()

    expect(document.body.textContent).toContain('Uploading')
    expect(document.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
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

  it('passes selected folders from the hidden directory picker', () => {
    const { onUpload } = renderControl()
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'webkitRelativePath', {
      configurable: true,
      value: 'project/docs/note.txt',
    })
    const input = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1]

    expect(input.hasAttribute('webkitdirectory')).toBe(true)

    act(() => {
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [file],
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onUpload).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'directory',
        name: 'project',
        files: [{ file, relativePath: 'docs/note.txt' }],
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

    const items = await buildDroppedUploadItems({
      files: [] as unknown as FileList,
      items: [{ webkitGetAsEntry: () => projectEntry }] as unknown as DataTransferItemList,
    } as DataTransfer)

    expect(items).toEqual([
      expect.objectContaining({
        kind: 'directory',
        name: 'project',
        files: [{ file, relativePath: 'docs/note.txt' }],
      }),
    ])
  })

  it('builds dropped files when directory entries are unavailable', async () => {
    const file = new File(['payload'], 'archive.zip', { type: 'application/zip' })
    const items = await buildDroppedUploadItems({ files: [file] as unknown as FileList, items: [] } as DataTransfer)

    expect(items).toEqual([
      expect.objectContaining({
        kind: 'file',
        name: 'archive.zip',
        files: [{ file, relativePath: 'archive.zip' }],
      }),
    ])
  })

  it('returns no items for empty dropped folders so callers can surface feedback', async () => {
    const emptyFolderEntry = {
      isDirectory: true,
      isFile: false,
      name: 'empty',
      createReader: () => ({
        readEntries: vi.fn().mockImplementationOnce((resolve: (entries: unknown[]) => void) => resolve([])),
      }),
    }

    await expect(
      buildDroppedUploadItems({
        files: [] as unknown as FileList,
        items: [{ webkitGetAsEntry: () => emptyFolderEntry }] as unknown as DataTransferItemList,
      } as DataTransfer),
    ).resolves.toEqual([])
  })

  it('surfaces dropped folder read failures', async () => {
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

    await expect(
      buildDroppedUploadItems({
        files: [] as unknown as FileList,
        items: [{ webkitGetAsEntry: () => folderEntry }] as unknown as DataTransferItemList,
      } as DataTransfer),
    ).rejects.toBe(readError)
  })
})
