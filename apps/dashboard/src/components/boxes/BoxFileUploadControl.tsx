/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { Upload } from '@/components/ui/icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  buildBoxUploadItems,
  createBoxUploadDirectoryItem,
  createBoxUploadFileItem,
  type BoxUploadFileEntry,
  type BoxUploadItem,
} from '@/lib/box-upload'
import { useRef, useState, type DragEvent } from 'react'

interface BoxFileUploadControlProps {
  disabled: boolean
  disabledReason?: string
  destinationDir: string
  isDragging?: boolean
  isUploading: boolean
  onError: (error: unknown) => void
  onUpload: (items: BoxUploadItem[]) => void
}

export function BoxFileUploadControl({
  disabled,
  disabledReason,
  destinationDir,
  isDragging: externalDragging,
  isUploading,
  onError,
  onUpload,
}: BoxFileUploadControlProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isLocalDragging, setIsLocalDragging] = useState(false)
  const isDragging = externalDragging ?? isLocalDragging
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

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setIsLocalDragging(false)
    if (isDisabled) return

    try {
      submitItems(await buildDroppedUploadItems(event.dataTransfer))
    } catch (error) {
      onError(error)
    }
  }

  return (
    <div
      data-testid="box-file-drop-target"
      className={[
        'flex min-w-0 flex-col items-stretch justify-between gap-2 border border-dashed px-3 py-1.5 text-[11px] transition-colors sm:flex-row sm:items-center',
        isDragging ? 'border-brand bg-brand/10 text-foreground' : 'border-border text-muted-foreground',
        isDisabled ? 'opacity-60' : 'hover:border-brand/70',
      ].join(' ')}
      onDragEnter={(event) => {
        event.preventDefault()
        if (!isDisabled) setIsLocalDragging(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        if (!isDisabled) setIsLocalDragging(true)
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        setIsLocalDragging(false)
      }}
      onDrop={handleDrop}
    >
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
      <div className="min-w-0 leading-tight">
        <div className="truncate text-foreground">
          {isDragging ? `Drop to upload into ${destinationDir}` : 'Drop files or folders here'}
        </div>
      </div>
      <div className="flex flex-none">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex" tabIndex={isDisabled ? 0 : -1}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isDisabled}
                onClick={openFilePicker}
                className="h-7 gap-2 px-2.5 font-mono text-[12px]"
              >
                <Upload className="size-4" />
                {isUploading ? 'Uploading' : 'Upload'}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{disabledReason ?? `Upload files to ${destinationDir}`}</TooltipContent>
        </Tooltip>
      </div>
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
