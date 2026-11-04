import type { Request, Response } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Preserve raw application bodies; management JSON may already have been parsed by Nest. */
export function cloudAppRequest(request: Request, url: string): globalThis.Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  let body: BodyInit | undefined
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const raw = (request as Request & { rawBody?: Buffer }).rawBody
    if (raw) body = new Uint8Array(raw)
    else if (request.body !== undefined) body = JSON.stringify(request.body)
    else if (!request.readableEnded) body = Readable.toWeb(request) as ReadableStream<Uint8Array>
  }
  return new globalThis.Request(url, { method: request.method, headers, body, duplex: 'half' } as RequestInit)
}

export async function sendCloudAppResponse(result: globalThis.Response, response: Response): Promise<void> {
  response.status(result.status)
  result.headers.forEach((value, name) => {
    if (name !== 'set-cookie' && name !== 'transfer-encoding') response.setHeader(name, value)
  })
  const cookies = result.headers.getSetCookie()
  if (cookies.length) response.setHeader('set-cookie', cookies)
  if (!result.body) {
    response.end()
    return
  }
  await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream), response)
}
