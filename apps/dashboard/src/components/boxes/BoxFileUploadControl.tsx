/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  buildBoxUploadItems,
  createBoxUploadDirectoryItem,
  createBoxUploadFileItem,
  type BoxUploadFileEntry,
  type BoxUploadItem,
} from '@/lib/box-upload'
import { Icon as IconifyIcon } from '@iconify/react'
import { useRef } from 'react'

interface BoxFileUploadControlProps {
  disabled: boolean
  disabledReason?: string
  destinationDir: string
  isUploading: boolean
  onError: (error: unknown) => void
  onUpload: (items: BoxUploadItem[]) => void
}

export function BoxFileUploadControl({
  disabled,
  disabledReason,
  destinationDir,
  isUploading,
  onError,
  onUpload,
}: BoxFileUploadControlProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const directoryInputRef = useRef<HTMLInputElement>(null)
  const isDisabled = disabled || isUploading

  const submitItems = (items: BoxUploadItem[]) => {
    if (items.length === 0) return
    onUpload(items)
  }

  const submitFiles = (fileList: FileList | File[] | null | undefined) => {
    const files = Array.from(fileList ?? [])
    if (files.length === 0) return
    try {
      submitItems(buildBoxUploadItems(files))
    } catch (error) {
      onError(error)
    }
  }

  const openFilePicker = () => {
    if (isDisabled) return
    fileInputRef.current?.click()
  }

  const openDirectoryPicker = () => {
    if (isDisabled) return
    directoryInputRef.current?.click()
  }

  return (
    <div data-testid="box-file-upload-control" className="flex flex-none items-center gap-1">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          submitFiles(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
      />
      <input
        ref={directoryInputRef}
        type="file"
        multiple
        className="hidden"
        {...{ webkitdirectory: '', directory: '' }}
        onChange={(event) => {
          submitFiles(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isDisabled}
        title={disabledReason ?? `Upload files to ${destinationDir}`}
        onClick={openFilePicker}
        className="h-7 gap-2 px-2.5 font-mono text-[12px]"
      >
        {isUploading ? <Spinner className="size-4" /> : <IconifyIcon icon="pixelarticons:files" className="size-4" />}
        {isUploading ? 'Uploading' : 'Upload Files'}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isDisabled}
        title={disabledReason ?? `Upload a folder to ${destinationDir}`}
        onClick={openDirectoryPicker}
        className="h-7 gap-2 px-2.5 font-mono text-[12px]"
      >
        <IconifyIcon icon="pixelarticons:folder" className="size-4" />
        Folder
      </Button>
    </div>
  )
}

interface UploadFileSystemEntry {
  isDirectory: boolean
  isFile: boolean
  name: string
}

interface UploadFileSystemFileEntry extends UploadFileSystemEntry {
  file: (successCallback: (file: File) => void, errorCallback?: (error: DOMException) => void) => void
}

interface UploadFileSystemDirectoryEntry extends UploadFileSystemEntry {
  createReader: () => {
    readEntries: (
      successCallback: (entries: UploadFileSystemEntry[]) => void,
      errorCallback?: (error: DOMException) => void,
    ) => void
  }
}

type WebkitDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => unknown
}

export async function buildDroppedUploadItems(dataTransfer: DataTransfer): Promise<BoxUploadItem[]> {
  const entries = Array.from(dataTransfer.items ?? [])
    .map((item) => ((item as WebkitDataTransferItem).webkitGetAsEntry?.() ?? null) as UploadFileSystemEntry | null)
    .filter((entry): entry is UploadFileSystemEntry => Boolean(entry))

  if (entries.length === 0) {
    return buildBoxUploadItems(Array.from(dataTransfer.files ?? []))
  }

  const items = await Promise.all(entries.map(readEntryAsUploadItem))
  return items.filter((item): item is BoxUploadItem => Boolean(item))
}

async function readEntryAsUploadItem(entry: UploadFileSystemEntry): Promise<BoxUploadItem | null> {
  if (entry.isFile) {
    return createBoxUploadFileItem(await readFileEntry(entry as UploadFileSystemFileEntry))
  }

  if (entry.isDirectory) {
    const files = await readDirectoryFiles(entry as UploadFileSystemDirectoryEntry, '')
    return files.length > 0 ? createBoxUploadDirectoryItem(entry.name, files) : null
  }

  return null
}

function readFileEntry(entry: UploadFileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject)
  })
}

async function readDirectoryFiles(
  directory: UploadFileSystemDirectoryEntry,
  prefix: string,
): Promise<BoxUploadFileEntry[]> {
  const entries = await readAllDirectoryEntries(directory)
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isFile) {
        return [
          {
            file: await readFileEntry(entry as UploadFileSystemFileEntry),
            relativePath: `${prefix}${entry.name}`,
          },
        ]
      }

      if (entry.isDirectory) {
        return readDirectoryFiles(entry as UploadFileSystemDirectoryEntry, `${prefix}${entry.name}/`)
      }

      return []
    }),
  )

  return files.flat()
}

function readAllDirectoryEntries(directory: UploadFileSystemDirectoryEntry): Promise<UploadFileSystemEntry[]> {
  const reader = directory.createReader()
  const entries: UploadFileSystemEntry[] = []

  return new Promise((resolve, reject) => {
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries)
          return
        }
        entries.push(...batch)
        readBatch()
      }, reject)
    }

    readBatch()
  })
}
