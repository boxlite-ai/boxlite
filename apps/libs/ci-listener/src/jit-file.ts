/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Header } from 'tar'

/** Fixed private files only; no paths, archive parsing or local secret staging. */
export function jitFileArchive(file: '.boxlite-jitconfig' | '.boxlite-jitconfig.ready', content: string): Uint8Array {
  if (
    !['.boxlite-jitconfig', '.boxlite-jitconfig.ready'].includes(file) ||
    typeof content !== 'string' ||
    Buffer.byteLength(content) > 1048576
  )
    throw new Error('Invalid JIT file')
  const body = Buffer.from(content, 'utf8'),
    header = new Header({ path: file, mode: 0o600, uid: 0, gid: 0, size: body.length, type: 'File' })
  if (header.encode() || !header.block) throw new Error('Invalid JIT archive')
  return new Uint8Array(Buffer.concat([header.block, body, Buffer.alloc(((512 - (body.length % 512)) % 512) + 1024)]))
}
