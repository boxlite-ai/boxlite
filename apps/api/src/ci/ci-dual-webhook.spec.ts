/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Test } from '@nestjs/testing'
import { createHmac, randomUUID } from 'node:crypto'
import { CiWebhookController } from './ci-webhook.controller'
import { CiWebhookService } from './ci-webhook.service'
import { installCiWebhookBodyParser } from './ci-webhook-body'
it('verifies each hosted App only on its own HTTP route and supplies trusted provenance', async () => {
  const secret = 'a'.repeat(32),
    orgSecret = 'b'.repeat(32)
  const values = {
    'ci.githubClientId': 'personal',
    'ci.githubWebhookSecret': secret,
    'ci.githubOrgClientId': 'organization',
    'ci.githubOrgWebhookSecret': orgSecret,
  }
  const listener = { receive: jest.fn(async () => 'stored') }
  const service = new CiWebhookService(listener as any, { get: (key: string) => values[key] } as any)
  const module = await Test.createTestingModule({
    controllers: [CiWebhookController],
    providers: [{ provide: CiWebhookService, useValue: service }],
  }).compile()
  const app = module.createNestApplication({ logger: false })
  installCiWebhookBodyParser(app)
  app.setGlobalPrefix('api')
  await app.listen(0, '127.0.0.1')
  const port = app.getHttpServer().address().port
  const raw = Buffer.from(
    JSON.stringify({
      application: 'forged-body-app',
      action: 'queued',
      installation: { id: 1 },
      repository: { id: 2, owner: { id: 3 } },
      workflow_job: { id: 4, run_id: 5, status: 'queued', labels: ['boxlite'] },
    }),
  )
  const post = (route: string, key: string) =>
    fetch(`http://127.0.0.1:${port}/api/v1/ci/github/webhook${route}`, {
      method: 'POST',
      body: raw,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'workflow_job',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', key).update(raw).digest('hex'),
      },
    })
  try {
    expect((await post('/organization', secret)).status).toBe(401)
    expect((await post('', orgSecret)).status).toBe(401)
    expect(listener.receive).not.toHaveBeenCalled()
    expect((await post('/organization', orgSecret)).status).toBe(204)
    expect(listener.receive).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ application: 'forged-body-app' }),
      'organization',
    )
    expect((await post('', secret)).status).toBe(204)
    expect(listener.receive).toHaveBeenLastCalledWith(expect.any(Object), 'personal')
    expect(listener.receive).toHaveBeenCalledTimes(2)
  } finally {
    await app.close()
  }
})
