/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Response } from 'express'
import { ReplayResponse, REPLAY_MAX_RESPONSE_BYTES } from './box-request-replay.service'

const replayUpstreams = new WeakMap<ServerResponse, IncomingMessage | undefined>()

export function trackReplayUpstream(
  upstream: IncomingMessage,
  _request: IncomingMessage,
  response: ServerResponse,
): void {
  if (replayUpstreams.has(response)) replayUpstreams.set(response, upstream)
}

/** Side-channel capture: forwarding keeps Node's exact callback, return value and backpressure behavior. */
export function captureReplayResponse(
  response: Response,
  complete: (result: ReplayResponse) => void,
  unknown: () => void,
  stopHeartbeat: () => void,
): () => void {
  const write = response.write
  const end = response.end
  let chunks: Buffer[] = []
  let size = 0
  let overflow = false
  let ended = false
  let closed = false

  const collect = (chunk: unknown, encoding: unknown): void => {
    if (overflow || chunk === undefined || chunk === null || typeof chunk === 'function') return
    const bytesEncoding = typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined
    const length =
      typeof chunk === 'string'
        ? Buffer.byteLength(chunk, bytesEncoding)
        : chunk instanceof Uint8Array
          ? chunk.byteLength
          : undefined
    if (length === undefined || size + length > Math.floor(((REPLAY_MAX_RESPONSE_BYTES - 4096) * 3) / 4)) {
      overflow = true
      chunks = []
      return
    }
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, bytesEncoding) : Buffer.from(chunk as Uint8Array)
    size += length
    chunks.push(bytes)
  }
  const cleanup = (): void => {
    if (response.write === wrappedWrite) response.write = write
    if (response.end === wrappedEnd) response.end = end
    response.off('close', onClose)
    response.off('error', onClose)
    replayUpstreams.delete(response)
    chunks = []
    stopHeartbeat()
  }
  const onClose = (): void => {
    if (ended || closed) return
    closed = true
    stopHeartbeat()
    unknown()
    // Keep the owner capture until end: a still-running handler may confirm late success.
  }
  const wrappedWrite: typeof response.write = function (chunk: unknown, ...args: unknown[]): boolean {
    collect(chunk, args[0])
    // Node overloads are runtime-equivalent; forwarding must retain the original arguments.
    return Reflect.apply(write, response, [chunk, ...args])
  }
  const wrappedEnd: typeof response.end = function (...args: unknown[]): Response {
    if (!ended) {
      ended = true
      collect(args[0], args[1])
      const status = response.statusCode
      const headers: Record<string, string> = {}
      for (const name of ['content-type', 'location']) {
        const value = response.getHeader(name)
        if (typeof value === 'string') headers[name] = value
      }
      const upstream = replayUpstreams.get(response)
      // A proxy error can end the downstream response after a partial upstream 2xx.
      if (
        status >= 200 &&
        status < 300 &&
        !overflow &&
        !headers['content-type']?.includes('text/event-stream') &&
        (!upstream || upstream.complete)
      ) {
        const body = status === 204 ? '' : Buffer.concat(chunks, size).toString('base64')
        complete({ status, body, encoding: 'base64', headers })
      } else unknown()
      cleanup()
    }
    return Reflect.apply(end, response, args)
  }
  replayUpstreams.set(response, undefined)
  response.write = wrappedWrite
  response.end = wrappedEnd
  response.once('close', onClose)
  response.once('error', onClose)
  return cleanup
}
