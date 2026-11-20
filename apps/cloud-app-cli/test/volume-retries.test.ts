import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Api } from '../src/api.js'
import { API, JSON_HEADERS, KEY, mockApi } from './helpers.js'

test('volume file calls follow the command retry policy on HTTP 503', async (t) => {
  const cases = [
    { name: 'GET', method: 'GET', attempts: 3, call: (api: Api) => api.volumeGet('uploads', '/file') },
    { name: 'DELETE', method: 'DELETE', attempts: 3, call: (api: Api) => api.volumeRemove('uploads', '/file', false) },
    {
      name: 'PUT with overwrite',
      method: 'PUT',
      attempts: 3,
      call: (api: Api) => api.volumePut('uploads', '/file', Buffer.from('data'), true),
    },
    {
      name: 'PUT without overwrite',
      method: 'PUT',
      attempts: 1,
      call: (api: Api) => api.volumePut('uploads', '/file', Buffer.from('data'), false),
    },
  ] as const
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { agent, pool } = mockApi()
      const api = new Api({ baseUrl: API, key: KEY, app: 'crm', env: 'main', dispatcher: agent })
      let attempts = 0
      pool
        .intercept({ path: /^\/apps\/crm\/envs\/main\/volumes\/uploads\/files\?/, method: entry.method })
        .reply(() => {
          attempts++
          return {
            statusCode: 503,
            data: { error: { code: 'unavailable', message: 'Box unavailable' } },
            responseOptions: { headers: JSON_HEADERS },
          }
        })
        .persist()
      try {
        await assert.rejects(entry.call(api), { code: 'unavailable' })
        assert.equal(attempts, entry.attempts)
      } finally {
        await agent.close()
      }
    })
  }
})
