/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

export type AttachFrame =
  | { kind: 'output'; bytes: Uint8Array }
  | { kind: 'exit'; exitCode: number }
  | { kind: 'error'; message: string }
  | { kind: 'ignored' }

/**
 * One server frame of the `/v1` attach WebSocket (openapi/box.openapi.yaml,
 * `attachExecution`): binary `[channel:u8][payload]` with channel 1 stdout or
 * 2 stderr, or a JSON text frame carrying `exit` or `error`.
 */
export function decodeAttachFrame(data: ArrayBuffer | string): AttachFrame {
  if (typeof data !== 'string') {
    const bytes = new Uint8Array(data)
    if (bytes.length > 1 && (bytes[0] === 1 || bytes[0] === 2)) return { kind: 'output', bytes: bytes.subarray(1) }
    return { kind: 'ignored' }
  }
  try {
    const message = JSON.parse(data) as { type?: string; exit_code?: number; message?: string }
    if (message.type === 'exit') return { kind: 'exit', exitCode: message.exit_code ?? 0 }
    if (message.type === 'error') return { kind: 'error', message: message.message ?? 'error' }
  } catch {
    // Not JSON: nothing the protocol defines.
  }
  return { kind: 'ignored' }
}
