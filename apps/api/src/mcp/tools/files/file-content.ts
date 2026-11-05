/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { posix } from 'node:path'
import { Header, Parser, Pax } from 'tar'
import { McpToolError } from '../shared/mcp-tool'
import { RUNNER_ARCHIVE_LIMIT } from '../../runner/runner-http'

export const TEXT_FILE_LIMIT = 60 * 1024

/** Build the existing copy-in wire format without accessing the API filesystem. */
export function archiveTextFile(destination: string, text: string): Buffer {
  const content = Buffer.from(text, 'utf8')
  if (content.length > TEXT_FILE_LIMIT) throw new McpToolError('UTF-8 content exceeds 60 KiB')
  if (content.toString('utf8') !== text || binaryControl(text))
    throw new McpToolError('Content is not supported UTF-8 text; use tar_base64')
  const name = posix.basename(destination)
  if (!name || name === '.' || name === '..' || destination.endsWith('/')) {
    throw new McpToolError('UTF-8 upload requires a guest filename; use tar_base64 for directory archives')
  }
  const block = Buffer.alloc(512)
  const header = new Header({
    path: name,
    type: 'File',
    size: content.length,
    mode: 0o644,
    uid: 0,
    gid: 0,
    mtime: new Date(0),
  })
  const needsPax = header.encode(block)
  const archive = Buffer.concat([
    needsPax ? new Pax({ path: name }).encode() : Buffer.alloc(0),
    block,
    content,
    Buffer.alloc((512 - (content.length % 512)) % 512),
    Buffer.alloc(1024),
  ])
  if (archive.length > RUNNER_ARCHIVE_LIMIT) throw new McpToolError('Archive exceeds 64 KiB')
  return archive
}

export function decodeBase64Archive(value: string): Buffer {
  const maxEncodedLength = Math.ceil(RUNNER_ARCHIVE_LIMIT / 3) * 4
  if (
    value.length > maxEncodedLength ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new McpToolError('Invalid or oversized base64 archive (64 KiB decoded maximum)')
  }
  const archive = Buffer.from(value, 'base64')
  if (!archive.length || archive.length > RUNNER_ARCHIVE_LIMIT || archive.toString('base64') !== value) {
    throw new McpToolError('Invalid or oversized base64 archive (64 KiB decoded maximum)')
  }
  return archive
}

export async function archiveTextContent(archive: Buffer, sourceIsDirectory?: boolean): Promise<string> {
  if (sourceIsDirectory !== false) {
    throw new McpToolError(
      'UTF-8 download requires a confirmed single-file source; use tar_base64 for directory or unknown source shape',
    )
  }
  requireTarFraming(archive)
  return new Promise<string>((resolve, reject) => {
    const parser = new Parser({ strict: true, maxMetaEntrySize: RUNNER_ARCHIVE_LIMIT, brotli: false, zstd: false })
    let entries = 0
    let bytes = 0
    let unsupported = false
    let eof = false
    const chunks: Buffer[] = []
    const invalid = () =>
      reject(
        new McpToolError(
          'Unsupported UTF-8 archive: require one complete regular text file within 60 KiB; use tar_base64',
        ),
      )
    parser.on('error', invalid)
    parser.on('ignoredEntry', () => {
      unsupported = true
    })
    parser.on('eof', () => {
      eof = true
    })
    parser.on('entry', (entry) => {
      entries++
      if (entry.type !== 'File' || entry.size > TEXT_FILE_LIMIT) unsupported = true
      entry.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > TEXT_FILE_LIMIT) unsupported = true
        else chunks.push(chunk)
      })
      entry.resume()
    })
    parser.on('end', () => {
      if (unsupported || entries !== 1 || !eof) return invalid()
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes))
        if (binaryControl(text)) return invalid()
        resolve(text)
      } catch {
        invalid()
      }
    })
    parser.end(archive)
  })
}

function binaryControl(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0)
    if (code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) return true
  }
  return false
}

/** Parser permits missing terminators and compressed inputs; this representation promises plain, complete tar. */
function requireTarFraming(archive: Buffer): void {
  const invalid = () =>
    new McpToolError('Invalid or truncated uncompressed tar archive; use tar_base64 for unsupported text shapes')
  // node-tar auto-detects gzip even for a checksum-valid polyglot header.
  if (archive[0] === 0x1f && archive[1] === 0x8b) throw invalid()
  if (archive.length > RUNNER_ARCHIVE_LIMIT || archive.length % 512 !== 0) throw invalid()
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = new Header(archive, offset)
    if (header.nullBlock) {
      if (archive.length - offset < 1024 || !archive.subarray(offset).every((byte) => byte === 0)) throw invalid()
      return
    }
    if (
      !header.cksumValid ||
      !Number.isSafeInteger(header.size) ||
      header.size < 0 ||
      header.size > RUNNER_ARCHIVE_LIMIT
    )
      throw invalid()
    offset += 512 + Math.ceil(header.size / 512) * 512
  }
  throw invalid()
}
