/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Initial upload destination before the terminal reports a cwd.
export const DEFAULT_BOX_UPLOAD_DIR = '/root'

const TAR_BLOCK_SIZE = 512
const TMPFS_UPLOAD_DESTINATIONS = ['/tmp', '/dev/shm']

export interface BoxUploadFileEntry {
  file: File
  relativePath: string
}

export interface BoxUploadItem {
  kind: 'file' | 'directory'
  name: string
  files: BoxUploadFileEntry[]
}

export function buildBoxFileUploadPath(destinationDir: string, file: File): string {
  return buildBoxUploadPath(destinationDir, createBoxUploadFileItem(file))
}

export function buildBoxUploadPath(destinationDir: string, item: BoxUploadItem): string {
  const dir = normalizeDestinationDir(destinationDir)
  return dir === '/' ? `/${item.name}` : `${dir}/${item.name}`
}

export async function createSingleFileTar(file: File): Promise<Blob> {
  return createBoxUploadTar(createBoxUploadFileItem(file))
}

export function getBoxUploadDestinationBlockedReason(destinationDir: string): string | undefined {
  const normalizedDir = normalizeDestinationDir(destinationDir)
  const blockedDir = TMPFS_UPLOAD_DESTINATIONS.find((dir) => isPathOrChild(normalizedDir, dir))
  if (!blockedDir) return undefined
  return `Uploads to ${blockedDir} are not supported because that path is tmpfs-backed`
}

export function buildBoxUploadItems(files: File[]): BoxUploadItem[] {
  const items: BoxUploadItem[] = []
  const directories = new Map<string, BoxUploadFileEntry[]>()

  for (const file of files) {
    const relativePath = getBrowserRelativePath(file)
    if (!relativePath) {
      items.push(createBoxUploadFileItem(file))
      continue
    }

    const segments = splitPathSegments(relativePath)

    if (segments.length > 1) {
      const directoryName = sanitizePathSegment(segments[0])
      const filePath = sanitizeRelativePath(segments.slice(1).join('/'))
      const entries = directories.get(directoryName) ?? []
      entries.push({ file, relativePath: filePath })
      directories.set(directoryName, entries)
    } else {
      items.push(createBoxUploadFileItem(file))
    }
  }

  for (const [directoryName, entries] of directories) {
    if (entries.length > 0) {
      items.push(createBoxUploadDirectoryItem(directoryName, entries))
    }
  }

  assertUniqueTopLevelUploadNames(items)
  return items
}

function assertUniqueTopLevelUploadNames(items: BoxUploadItem[]): void {
  const seenNames = new Set<string>()

  for (const item of items) {
    if (seenNames.has(item.name)) {
      throw new Error(`Multiple uploads resolve to the same destination name: ${item.name}`)
    }
    seenNames.add(item.name)
  }
}

export function createBoxUploadFileItem(file: File): BoxUploadItem {
  const fileName = sanitizeFileName(file.name)
  return {
    kind: 'file',
    name: fileName,
    files: [{ file, relativePath: fileName }],
  }
}

export function createBoxUploadDirectoryItem(name: string, files: BoxUploadFileEntry[]): BoxUploadItem {
  return {
    kind: 'directory',
    name: sanitizeFileName(name),
    files: files.map(({ file, relativePath }) => ({
      file,
      relativePath: sanitizeRelativePath(relativePath),
    })),
  }
}

export async function createBoxUploadTar(item: BoxUploadItem): Promise<Blob> {
  const chunks: Array<Uint8Array> = []

  for (const entry of item.files) {
    const data = await readFileBytes(entry.file)
    chunks.push(createTarHeader(entry.relativePath, data.byteLength, Math.floor(entry.file.lastModified / 1000) || 0))
    chunks.push(data)
    chunks.push(new Uint8Array(paddingLength(data.byteLength)))
  }

  const endBlocks = new Uint8Array(TAR_BLOCK_SIZE * 2)

  return new Blob([...chunks, endBlocks], { type: 'application/x-tar' })
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer())
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read upload file'))
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.readAsArrayBuffer(file)
  })
}

function normalizeDestinationDir(destinationDir: string): string {
  const trimmed = destinationDir.trim().replace(/\/+$/, '')
  if (destinationDir.trim().startsWith('/') && !trimmed) return '/'
  if (!trimmed) return DEFAULT_BOX_UPLOAD_DIR
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function isPathOrChild(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`)
}

function sanitizeFileName(fileName: string): string {
  const baseName = fileName.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return sanitizePathSegment(baseName) || 'upload'
}

function sanitizeRelativePath(path: string): string {
  const segments = splitPathSegments(path).map(sanitizePathSegment).filter(Boolean)
  return segments.length > 0 ? segments.join('/') : 'upload'
}

function sanitizePathSegment(segment: string): string {
  const trimmed = segment.trim()
  return trimmed && trimmed !== '.' && trimmed !== '..' ? trimmed : ''
}

function splitPathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

function getBrowserRelativePath(file: File): string | undefined {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined
}

function paddingLength(length: number): number {
  const remainder = length % TAR_BLOCK_SIZE
  return remainder === 0 ? 0 : TAR_BLOCK_SIZE - remainder
}

function createTarHeader(fileName: string, size: number, mtime: number): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_SIZE)
  const encoder = new TextEncoder()

  writeText(header, 0, 100, encoder.encode(fileName))
  writeOctal(header, 100, 8, 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, mtime)
  header.fill(0x20, 148, 156)
  header[156] = '0'.charCodeAt(0)
  writeText(header, 257, 6, encoder.encode('ustar'))
  writeText(header, 263, 2, encoder.encode('00'))

  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeChecksum(header, checksum)

  return header
}

function writeText(target: Uint8Array, offset: number, length: number, value: Uint8Array): void {
  if (value.byteLength > length) {
    throw new Error('File name is too long to upload')
  }
  target.set(value, offset)
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const raw = value.toString(8)
  if (raw.length > length - 1) {
    throw new Error(`Tar header value ${value} is too large to upload`)
  }

  const encoded = raw.padStart(length - 1, '0')
  for (let index = 0; index < encoded.length; index += 1) {
    target[offset + index] = encoded.charCodeAt(index)
  }
}

function writeChecksum(target: Uint8Array, checksum: number): void {
  const encoded = checksum.toString(8).padStart(6, '0')
  for (let index = 0; index < encoded.length; index += 1) {
    target[148 + index] = encoded.charCodeAt(index)
  }
  target[154] = 0
  target[155] = 0x20
}
