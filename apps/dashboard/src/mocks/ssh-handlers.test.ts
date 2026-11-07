import axios from 'axios'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ApiClient } from '@/api/apiClient'
import { generateSshCredentials, requestSsh } from '@/lib/ssh'
import { sshHandlers } from './ssh-handlers'

const server = setupServer(...sshHandlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

it('mock SSH preserves the configured host identity across disable and enable', async () => {
  const api = { axiosInstance: axios.create({ baseURL: 'https://ssh-preview.test/' }) } as unknown as ApiClient
  const keys = await generateSshCredentials()
  const configured = await requestSsh(api, 'mock-org', 'identity-box', 'setup', keys.config)
  expect(configured.host_public_key).toBe(keys.hostPublicKey)
  const disabled = await requestSsh(api, 'mock-org', 'identity-box', 'disable')
  expect(disabled.host_public_key).toBe('')
  expect((await requestSsh(api, 'mock-org', 'identity-box', 'status')).host_public_key).toBe('')
  const enabled = await requestSsh(api, 'mock-org', 'identity-box', 'enable')
  expect(enabled.host_public_key).toBe(configured.host_public_key)
  expect(enabled.host_key_fingerprint).toBe(configured.host_key_fingerprint)
  expect(JSON.stringify(enabled)).not.toContain(keys.privateKey)
  expect(JSON.stringify(enabled)).not.toContain(keys.config.host_private_key)
})
