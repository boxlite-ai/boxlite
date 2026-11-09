import axios from 'axios'
import { createHash } from 'node:crypto'
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
  const expectedFingerprint = createHash('sha256')
    .update(Buffer.from(keys.hostPublicKey.split(' ')[1], 'base64'))
    .digest('base64')
    .replace(/=+$/, '')
  expect(configured.host_key_fingerprint).toBe(`SHA256:${expectedFingerprint}`)
  const disabled = await requestSsh(api, 'mock-org', 'identity-box', 'disable')
  expect(disabled.host_public_key).toBe('')
  expect((await requestSsh(api, 'mock-org', 'identity-box', 'status')).host_public_key).toBe('')
  const enabled = await requestSsh(api, 'mock-org', 'identity-box', 'enable')
  expect(enabled.host_public_key).toBe(configured.host_public_key)
  expect(enabled.host_key_fingerprint).toBe(configured.host_key_fingerprint)
  expect(JSON.stringify(enabled)).not.toContain(keys.privateKey)
  expect(JSON.stringify(enabled)).not.toContain(keys.config.host_private_key)
})

it.each(['missing', 'empty', 'truncated'])(
  'mock SSH rejects a %s private-key block without saving configuration',
  async (kind) => {
    const api = { axiosInstance: axios.create({ baseURL: 'https://ssh-preview.test/' }) } as unknown as ApiClient
    const keys = await generateSshCredentials()
    const envelope = Buffer.from(keys.config.host_private_key.replace(/-----[^\n]+-----/g, ''), 'base64')
    let offset = Buffer.byteLength('openssh-key-v1\0')
    for (let field = 0; field < 3; field++) offset += 4 + envelope.readUInt32BE(offset)
    offset += 4 // Key count.
    offset += 4 + envelope.readUInt32BE(offset) // Public-key block.
    const invalid =
      kind === 'missing'
        ? envelope.subarray(0, offset)
        : kind === 'empty'
          ? Buffer.concat([envelope.subarray(0, offset), Buffer.alloc(4)])
          : envelope.subarray(0, envelope.length - 1)
    const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${invalid.toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`
    const boxId = `invalid-${kind}-block`

    await expect(
      requestSsh(api, 'mock-org', boxId, 'setup', { ...keys.config, host_private_key: privateKey }),
    ).rejects.toMatchObject({ response: { status: 400 } })
    expect(await requestSsh(api, 'mock-org', boxId, 'status')).toMatchObject({ enabled: false, generation: 0 })
    await expect(requestSsh(api, 'mock-org', boxId, 'enable')).rejects.toMatchObject({ response: { status: 409 } })
  },
)
