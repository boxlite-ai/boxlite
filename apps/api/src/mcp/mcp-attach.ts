/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import WebSocket from 'ws'

/** Per-stream output kept for a tool result; matches the runner's replay backlog. */
export const MCP_ATTACH_STREAM_CAP = 256 * 1024

const STDOUT = 0x01
const STDERR = 0x02

export interface McpAttachResult {
  execution_id: string
  /** True once the process exited; false when the wait ran out first. */
  complete: boolean
  exit_code: number | null
  stdout: string
  stderr: string
  /** True when either stream passed {@link MCP_ATTACH_STREAM_CAP} and its tail was dropped. */
  truncated: boolean
  error?: string
}

/**
 * Collects an execution's output from its attach WebSocket into one result.
 *
 * The socket is read-only (`stdin=0`) and authenticated by a single-use attach
 * ticket, so no credential travels with it. Output printed before the socket
 * opened is not lost: the runner replays each stream's backlog on subscribe.
 * The wait is bounded; on timeout the result says so and the agent can poll
 * `getExecution` or attach again.
 */
export function collectAttach(url: string, executionId: string, timeoutMs: number): Promise<McpAttachResult> {
  const streams = { [STDOUT]: new BoundedText(), [STDERR]: new BoundedText() }
  return new Promise((resolve) => {
    let settled = false
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    const finish = (complete: boolean, exitCode: number | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      resolve({
        execution_id: executionId,
        complete,
        exit_code: exitCode,
        stdout: streams[STDOUT].text(),
        stderr: streams[STDERR].text(),
        truncated: streams[STDOUT].truncated || streams[STDERR].truncated,
        ...(error ? { error } : {}),
      })
    }
    const timer = setTimeout(() => finish(false, null), timeoutMs)
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const message = parseControl(event.data)
        if (message?.type === 'exit') finish(true, typeof message.exit_code === 'number' ? message.exit_code : null)
        return
      }
      const frame = new Uint8Array(event.data as ArrayBuffer)
      const stream = streams[frame[0] as typeof STDOUT | typeof STDERR]
      stream?.append(frame.subarray(1))
    }
    // The upgrade is refused with a status (409 when another client is attached,
    // 404 when the execution is gone) that a WebSocket client cannot read.
    socket.onerror = () => finish(false, null, 'Attach refused: another client may be attached, or the execution ended')
    socket.onclose = () => finish(false, null, 'Attach closed before the process exited')
  })
}

function parseControl(text: string): { type?: string; exit_code?: unknown } | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Keeps the newest bytes of a stream, up to the cap. */
class BoundedText {
  private chunks: Uint8Array[] = []
  private size = 0
  truncated = false

  append(bytes: Uint8Array): void {
    this.chunks.push(bytes.slice())
    this.size += bytes.length
    while (this.size > MCP_ATTACH_STREAM_CAP && this.chunks.length > 0) {
      const overflow = this.size - MCP_ATTACH_STREAM_CAP
      const head = this.chunks[0]
      if (head.length <= overflow) {
        this.chunks.shift()
        this.size -= head.length
      } else {
        this.chunks[0] = head.subarray(overflow)
        this.size -= overflow
      }
      this.truncated = true
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}
