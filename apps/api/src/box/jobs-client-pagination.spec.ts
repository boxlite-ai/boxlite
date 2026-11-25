// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import axios from 'axios'
import { Configuration, JobsApi, JobStatus } from '@boxlite-ai/api-client'

describe('generated JobsApi pagination', () => {
  it('preserves numbered pages and Axios options, and sends an explicit cursor', async () => {
    const requests: unknown[] = []
    const server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://localhost')
      requests.push([request.method, url.pathname, Object.fromEntries(url.searchParams), request.headers['x-test']])
      response.setHeader('Content-Type', 'application/json')
      response.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const config = new Configuration({ basePath: `http://127.0.0.1:${port}` })
      const jobs = new JobsApi(config, undefined, axios.create({ proxy: false }))
      const options = { headers: { 'X-Test': 'options' } }
      const cursor = '00000000-0000-4000-8000-000000000099'
      await jobs.listJobs(2, 10, JobStatus.IN_PROGRESS, 20, options)
      await jobs.listJobs(2, 10, JobStatus.IN_PROGRESS, 20, cursor, options)
      const page = { page: '2', limit: '10', status: 'IN_PROGRESS', offset: '20' }
      expect(requests).toEqual([
        ['GET', '/jobs', page, 'options'],
        ['GET', '/jobs', { ...page, afterId: cursor }, 'options'],
      ])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
