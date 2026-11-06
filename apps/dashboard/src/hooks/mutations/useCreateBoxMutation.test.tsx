// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/apiClient'
import type { DashboardConfig } from '@/types/DashboardConfig'
import { getBoxesQueryKey } from '../useBoxes'
import { useCreateBoxMutation } from './useCreateBoxMutation'

const context = vi.hoisted(() => ({
  api: null as ApiClient | null,
  organization: { id: 'org-1' } as { id: string } | null,
}))
vi.mock('../useApi', () => ({ useApi: () => context.api }))
vi.mock('../useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: context.organization }),
}))

describe('useCreateBoxMutation startup timeout recovery', () => {
  let server: Server
  let apiUrl: string
  let root: Root
  let client: QueryClient
  let mutation: ReturnType<typeof useCreateBoxMutation>
  let postStatus: number, getStatus: number
  let postBody: unknown
  let box: { id: string; state: string; errorReason?: string }
  let requests: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders }>

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-boxlite-organization-id')
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end()
        return
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers })
      req.resume()
      res.setHeader('Content-Type', 'application/json')
      res.writeHead(req.method === 'POST' ? postStatus : getStatus)
      res.end(
        JSON.stringify(req.method === 'POST' ? postBody : getStatus === 200 ? box : { message: 'Box unavailable' }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    requests = []
    postStatus = 408
    getStatus = 200
    postBody = { message: 'Startup is still pending', boxId: 'box-1' }
    box = { id: 'box-1', state: 'creating' }
    context.organization = { id: 'org-1' }
    context.api = new ApiClient({ apiUrl } as DashboardConfig, 'test-token')
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    client.setQueryData(getBoxesQueryKey('org-1'), [])
    client.setQueryData(getBoxesQueryKey('org-2'), [])
    root = createRoot(document.createElement('div'))
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
  })

  async function submit() {
    function Probe() {
      mutation = useCreateBoxMutation()
      return null
    }
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      ),
    )
    let created
    await act(async () => {
      created = await mutation.mutateAsync({ image: 'docker.io/unclecode/crawl4ai:latest' })
    })
    return created
  }

  it.each(['creating', 'started', 'error'])(
    'reads the created Box after 408 and preserves its %s state',
    async (state) => {
      box.state = state
      if (state === 'error') box.errorReason = 'Image startup failed'

      await expect(submit()).resolves.toEqual(box)

      expect(requests.map(({ method, url }) => [method, url])).toEqual([
        ['POST', '/api/v1/org-1/boxes'],
        ['GET', '/api/box/box-1'],
      ])
      expect(requests.every(({ headers }) => headers.authorization === 'Bearer test-token')).toBe(true)
      expect(requests[1].headers['x-boxlite-organization-id']).toBe('org-1')
      expect(client.getQueryState(getBoxesQueryKey('org-1'))?.isInvalidated).toBe(true)
      expect(client.getQueryState(getBoxesQueryKey('org-2'))?.isInvalidated).toBe(false)
    },
  )

  it('keeps normal 201 creation on the same scoped read path', async () => {
    postStatus = 201
    postBody = { box_id: 'box-1', status: 'running' }
    box.state = 'started'
    await expect(submit()).resolves.toEqual(box)
    expect(requests.map(({ method }) => method)).toEqual(['POST', 'GET'])
  })

  it.each([undefined, '', 123, { id: 'box-1' }])('does not recover a 408 without a valid Box ID: %p', async (boxId) => {
    postBody = { message: 'Timed out waiting for box box-1 to reach started', boxId }
    await expect(submit()).rejects.toMatchObject({ response: { status: 408 } })
    expect(requests.map(({ method }) => method)).toEqual(['POST'])
  })

  it.each([400, 403, 409, 429, 502, 504])('preserves HTTP %s failures even if an ID is present', async (status) => {
    postStatus = status
    await expect(submit()).rejects.toMatchObject({ response: { status } })
    expect(requests.map(({ method }) => method)).toEqual(['POST'])
  })

  it('exposes a failed follow-up read without repeating creation', async () => {
    getStatus = 404
    await expect(submit()).rejects.toThrow('Box unavailable')
    expect(requests.map(({ method }) => method)).toEqual(['POST', 'GET'])
    expect(client.getQueryState(getBoxesQueryKey('org-1'))?.isInvalidated).toBe(false)
  })

  it('sends no request without an organization', async () => {
    context.organization = null
    await expect(submit()).rejects.toThrow('Missing organization')
    expect(requests).toEqual([])
  })
})
