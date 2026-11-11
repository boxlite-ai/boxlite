/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ConfigService } from '@nestjs/config'
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto'
import { CiGitHubService } from './ci-github.service'
import { CiWebhookService } from './ci-webhook.service'
import { CiSecretsService } from './ci-secrets.service'

describe('CI runtime secret ENV configuration', () => {
  it.each([
    ['CI_WORKER_CPUS', '0'],
    ['CI_WORKER_CPUS', '17'],
    ['CI_WORKER_CPUS', '1.5'],
    ['CI_WORKER_MEMORY_GB', '200'],
    ['CI_WORKER_MEMORY_GB', '0.124'],
    ['CI_WORKER_MEMORY_GB', 'NaN'],
  ])('rejects invalid native worker resources at startup: %s=%s', (key, value) => {
    const previous = process.env[key]
    process.env[key] = value
    try {
      expect(() => jest.isolateModules(() => require('../config/configuration'))).toThrow(key)
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })
  it('uses injected values through production configuration for JWT, HMAC and connect encryption', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const secret = randomBytes(32).toString('hex')
    const values = {
      CI_GITHUB_APP_CLIENT_ID: 'injected-client',
      CI_GITHUB_APP_CLIENT_SECRET: 'private-injected-oauth-client-secret',
      DASHBOARD_URL: 'https://console.test',
      CI_GITHUB_APP_SLUG: 'injected-app',
      CI_GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      CI_GITHUB_WEBHOOK_SECRET: secret,
      CI_SECRET_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    }
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
    let config: ConfigService
    try {
      Object.assign(process.env, values)
      jest.isolateModules(() => {
        const { configuration } = require('../config/configuration')
        config = new ConfigService(configuration)
      })
    } finally {
      for (const key of Object.keys(values)) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
    const original = global.fetch
    global.fetch = jest.fn(async (_url, options) => {
      const token = (options!.headers as Record<string, string>).Authorization.slice('Bearer '.length)
      const [header, payload, signature] = token.split('.')
      expect(JSON.parse(Buffer.from(payload, 'base64url').toString()).iss).toBe(values.CI_GITHUB_APP_CLIENT_ID)
      expect(
        verify('RSA-SHA256', Buffer.from(header + '.' + payload), keys.publicKey, Buffer.from(signature, 'base64url')),
      ).toBe(true)
      return new Response(
        JSON.stringify({
          id: 123,
          account: { id: 456, login: 'owner', type: 'User' },
          suspended_at: null,
          permissions: { metadata: 'read' },
        }),
      )
    }) as typeof fetch
    try {
      await expect(
        new CiGitHubService(config! as any).forType('User').appSource().installation(123),
      ).resolves.toMatchObject({
        id: 123,
      })
      expect(global.fetch).toHaveBeenCalledTimes(1)
      global.fetch = jest.fn(async (address, options) => {
        expect(String(address)).toBe('https://github.com/login/oauth/access_token')
        expect(JSON.parse(String(options?.body))).toMatchObject({
          client_id: values.CI_GITHUB_APP_CLIENT_ID,
          client_secret: values.CI_GITHUB_APP_CLIENT_SECRET,
          code_verifier: 'A'.repeat(43),
        })
        return new Response(JSON.stringify({ access_token: 'private-oauth-user-token' }))
      }) as typeof fetch
      await expect(
        new CiGitHubService(config! as any).forType('User').exchangeWeb('test-code', 'A'.repeat(43)),
      ).resolves.toBe('private-oauth-user-token')
    } finally {
      global.fetch = original
    }

    const listener = { receive: jest.fn().mockResolvedValue('stored') }
    const service = new CiWebhookService(listener as any, config! as any)
    const raw = Buffer.from(
      JSON.stringify({
        action: 'queued',
        installation: { id: 123 },
        repository: { id: 7, owner: { id: 456 } },
        workflow_job: { id: 8, run_id: 9, status: 'queued', labels: ['boxlite'] },
      }),
    )
    const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
    await expect(service.receive(raw, signature, randomUUID(), 'workflow_job')).resolves.toBeUndefined()
    expect(listener.receive).toHaveBeenCalledTimes(1)
    await expect(service.receive(raw, 'sha256=' + '0'.repeat(64), randomUUID(), 'workflow_job')).rejects.toThrow()
    expect(listener.receive).toHaveBeenCalledTimes(1)
    const encryption = new CiSecretsService(config! as any)
    expect(encryption.open(encryption.seal('device-state', 'attempt'), 'attempt')).toBe('device-state')
  })
})
