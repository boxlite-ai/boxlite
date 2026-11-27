/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { WebSocket, WebSocketServer } from 'ws'

export const UPLOAD_PROTOCOL = 'boxlite-file-upload.v1'
export const UPLOAD_PATH = /^\/api\/v1\/(?:(?<tenant>[^/?]+)\/)?boxes\/(?<boxId>[^/?]+)\/files\/ws(?:\?.*)?$/
const MAX_ERROR_BYTES = 16 * 1024

export const fileUploadWsEnabled = () => process.env.BOXLITE_FILE_UPLOAD_WS_ENABLED !== 'false'

export function createUploadWebSocketServer(): WebSocketServer {
  return new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
    allowSynchronousEvents: false,
    handleProtocols: (protocols) => (protocols.has(UPLOAD_PROTOCOL) ? UPLOAD_PROTOCOL : false),
  })
}

type Outcome = { status: number; failure?: string; error?: unknown }

/** Relay the tar while independently watching the Runner response. */
export function bridgeUpload(peer: WebSocket, url: URL, apiKey: string, lease: AbortSignal): Promise<Outcome> {
  return new Promise((resolve) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = request(url, {
      method: 'PUT',
      agent: false,
      rejectUnauthorized: false,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/x-tar',
        'Transfer-Encoding': 'chunked',
        // Go's HTTP/1 server can otherwise drain the unfinished body before sending a rejection.
        Connection: 'close',
      },
    })
    let finished = false
    let settled = false
    let responding = false
    let deadline: NodeJS.Timeout

    function settle(outcome: Outcome): void {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      lease.removeEventListener('abort', leaseLost)
      upstream.destroy()
      if (peer.readyState === WebSocket.OPEN) {
        peer.resume()
        peer.send(JSON.stringify({ type: 'result', status: outcome.status, error: outcome.error }))
        peer.close()
      }
      resolve(outcome)
    }
    const leaseLost = () => settle({ status: 503, failure: 'audit_lease_lost' })
    const resetDeadline = (ms: number) => {
      clearTimeout(deadline)
      deadline = setTimeout(() => settle({ status: 504, failure: 'upload_timeout' }), ms).unref()
    }
    peer.on('message', (chunk: Buffer, binary) => {
      if (settled || responding) return
      if (finished || (!binary && !chunk.equals(Buffer.from('finish')))) {
        settle({ status: 400, failure: 'upload_protocol_error' })
        return
      }
      if (!binary) {
        finished = true
        resetDeadline(5 * 60_000)
        upstream.end()
      } else {
        resetDeadline(120_000)
        if (!upstream.write(chunk)) peer.pause()
      }
    })
    upstream.on('drain', () => {
      if (!responding && !settled) peer.resume()
    })
    peer.once('close', () => {
      if (!finished && !responding) settle({ status: 0, failure: 'client_closed' })
    })
    peer.on('error', () => {
      if (!responding) settle({ status: 400, failure: 'websocket_error' })
    })
    upstream.on('error', () => {
      if (!responding) settle({ status: 502, failure: 'runner_unavailable' })
    })
    upstream.once('response', (response) => {
      responding = true
      peer.pause()
      const status = response.statusCode ?? 502
      if (status === 204 && finished) return settle({ status })
      if (status < 400 || status > 599) return settle({ status: 502, failure: 'unexpected_runner_response' })
      const outcome: Outcome = { status, failure: `http_${status}` }
      const chunks: Buffer[] = []
      let length = 0
      response.on('data', (data: Buffer) => {
        length += data.length
        if (length > MAX_ERROR_BYTES) settle(outcome)
        else chunks.push(data)
      })
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          outcome.error = typeof body?.error === 'string' ? { message: body.error } : body?.error
        } catch {
          // Preserve the status for non-JSON responses.
        }
        settle(outcome)
      })
      response.on('error', () => settle(outcome))
    })
    resetDeadline(120_000)
    lease.addEventListener('abort', leaseLost, { once: true })
    if (lease.aborted) leaseLost()
    else upstream.flushHeaders()
  })
}
