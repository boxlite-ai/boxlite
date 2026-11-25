/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { BoxPricingClient } from './box-pricing.client'

const through = new Date('2026-11-25T10:01:15.000Z')
const line = {
  item: 'cpu',
  quantity: '15',
  unit: 'vcpu_second',
  amountUsd: '0.000000000000000000002778',
  start: '2026-11-25T10:00:00.000Z',
  end: '2026-11-25T10:00:15.000Z',
}
const priced = { lines: [line], totalUsd: line.amountUsd }

describe('BoxPricingClient', () => {
  let server: Server
  let respond: (response: ServerResponse) => void
  let requests: IncomingMessage[]
  let settings: Record<string, unknown>
  const price = () =>
    new BoxPricingClient({ get: (key: string) => settings[key] } as never).price('org/1', 'aB3cD4eF5gH6', through)

  beforeEach(async () => {
    requests = []
    server = createServer((request, response) => {
      requests.push(request)
      respond(response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    settings = {
      'usageExport.enabled': true,
      'usageExport.url': `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      'usageExport.token': 'token',
    }
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const answer = (status: number, body: unknown) => {
    respond = (response) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
  }

  it('sends the instant and credential, and keeps amounts as exact text', async () => {
    answer(200, priced)
    const { amountUsd, ...rest } = line
    await expect(price()).resolves.toEqual({ lines: [{ ...rest, amount_usd: amountUsd }], totalUsd: amountUsd })
    expect(requests[0].url).toBe(
      '/internal/organizations/org%2F1/boxes/aB3cD4eF5gH6/cost?through=2026-11-25T10:01:15.000Z',
    )
    expect(requests[0].headers.authorization).toBe('Bearer token')
  })

  it('accepts a cost with nothing priced', async () => {
    answer(200, { lines: [], totalUsd: null })
    await expect(price()).resolves.toEqual({ lines: [], totalUsd: null })
  })

  it.each([401, 403, 404, 429, 500, 503])('answers 503 for upstream %s', async (status) => {
    answer(status, {})
    await expect(price()).rejects.toMatchObject({ status: 503 })
  })

  it('answers 500 when its own request is rejected', async () => {
    answer(400, {})
    await expect(price()).rejects.toMatchObject({ status: 500 })
  })

  it('does not carry the credential across a redirect', async () => {
    respond = (response) => response.writeHead(302, { location: '/elsewhere' }).end()
    await expect(price()).rejects.toMatchObject({ status: 503 })
    expect(requests).toHaveLength(1)
  })

  it('answers 503 when the upstream does not answer in time', async () => {
    respond = () => undefined
    await expect(price()).rejects.toMatchObject({ status: 503 })
  })

  it.each([
    ['null body', null],
    ['text body', 'down'],
    ['missing total', { lines: [line] }],
    ['numeric total', { lines: [line], totalUsd: 0.1 }],
    ['25 decimal places', { lines: [line], totalUsd: `0.${'1'.repeat(25)}` }],
    ['negative total', { lines: [line], totalUsd: '-1' }],
    ['exponent total', { lines: [line], totalUsd: '1e-7' }],
    ['priced lines without a total', { lines: [line], totalUsd: null }],
    ['a total without lines', { lines: [], totalUsd: '0' }],
    ['null line', { ...priced, lines: [null] }],
    ['unknown item', { ...priced, lines: [{ ...line, item: 'network' }] }],
    ['mismatched unit', { ...priced, lines: [{ ...line, unit: 'gib_second' }] }],
    ['numeric quantity', { ...priced, lines: [{ ...line, quantity: 15 }] }],
    ['numeric amount', { ...priced, lines: [{ ...line, amountUsd: 0 }] }],
    ['open line', { ...priced, lines: [{ ...line, end: null }] }],
  ])('answers 503 for a malformed response: %s', async (_name, body) => {
    answer(200, body)
    await expect(price()).rejects.toMatchObject({ status: 503 })
  })

  it.each(['enabled', 'url', 'token'])('answers 503 without usageExport.%s', async (key) => {
    settings[`usageExport.${key}`] = undefined
    await expect(price()).rejects.toMatchObject({ status: 503 })
    expect(requests).toHaveLength(0)
  })
})
