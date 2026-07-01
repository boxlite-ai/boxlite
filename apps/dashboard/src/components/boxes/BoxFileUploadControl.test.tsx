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

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing expected element: ${selector}`)
  return element
}

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

  function renderControl(onUpload = vi.fn()) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <BoxFileUploadControl disabled={false} destinationDir="/workspace" isUploading={false} onUpload={onUpload} />,
      )
    })
    return onUpload
  }

  it('shows where uploaded files land before the user selects anything', () => {
    renderControl()

    expect(document.body.textContent).toContain('Upload')
    expect(document.querySelectorAll('button')).toHaveLength(1)
    expect(document.body.textContent).toContain('/workspace')
    expect(document.body.textContent).toContain('Drop files or folders here')
  })

  it('passes selected files from the hidden file picker', () => {
    const onUpload = renderControl()
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

  it('passes dropped folders with relative paths', async () => {
    const onUpload = renderControl()
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    const dropTarget = required<HTMLElement>('[data-testid="box-file-drop-target"]')
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

    await act(async () => {
      const event = new Event('drop', { bubbles: true })
      Object.defineProperty(event, 'dataTransfer', {
        configurable: true,
        value: {
          files: [],
          items: [{ webkitGetAsEntry: () => projectEntry }],
        },
      })
      dropTarget.dispatchEvent(event)
    })

    expect(onUpload).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'directory',
        name: 'project',
        files: [{ file, relativePath: 'docs/note.txt' }],
      }),
    ])
  })

  it('passes dropped files and reveals the drop target', async () => {
    const onUpload = renderControl()
    const file = new File(['payload'], 'archive.zip', { type: 'application/zip' })
    const dropTarget = required<HTMLElement>('[data-testid="box-file-drop-target"]')

    act(() => {
      dropTarget.dispatchEvent(new Event('dragenter', { bubbles: true }))
    })

    expect(document.body.textContent).toContain('Drop to upload into /workspace')

    await act(async () => {
      const event = new Event('drop', { bubbles: true })
      Object.defineProperty(event, 'dataTransfer', {
        configurable: true,
        value: { files: [file] },
      })
      dropTarget.dispatchEvent(event)
    })

    expect(onUpload).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'file',
        name: 'archive.zip',
        files: [{ file, relativePath: 'archive.zip' }],
      }),
    ])
  })
})
