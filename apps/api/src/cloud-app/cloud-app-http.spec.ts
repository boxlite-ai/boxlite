import { Readable } from 'node:stream'
import type { Request } from 'express'
import { cloudAppRequest } from './cloud-app-http'

describe('App HTTP bridge', () => {
  it('preserves signed webhook bytes after the platform JSON parser', async () => {
    const rawBody = Buffer.from('{ "amount": 42, "currency": "USD" }\n')
    const request = Object.assign(Readable.from([]), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer app-user' },
      rawBody,
      body: JSON.parse(rawBody.toString()),
    }) as unknown as Request
    const forwarded = cloudAppRequest(request, 'https://orders.apps.example/webhook?source=payment')
    expect(await forwarded.text()).toBe(rawBody.toString())
    expect(forwarded.headers.get('authorization')).toBe('Bearer app-user')
    expect(new URL(forwarded.url).search).toBe('?source=payment')
  })

  it('streams binary source bodies without JSON conversion', async () => {
    const data = Buffer.from([0, 255, 17, 129])
    const request = Object.assign(Readable.from([data]), {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
    }) as unknown as Request
    expect(Buffer.from(await cloudAppRequest(request, 'https://api.example/source').arrayBuffer())).toEqual(data)
  })
})
