/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { CustomDomainMaintenanceController } from './custom-domain-maintenance.controller'
import { CustomDomainWorkflowService } from '../services/custom-domain-workflow.service'

describe('custom-domain maintenance authorization', () => {
  let app: INestApplication
  let base: string
  const maintain = jest.fn()
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CustomDomainMaintenanceController],
      providers: [{ provide: CustomDomainWorkflowService, useValue: { maintain } }],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context) => {
          const req = context.switchToHttp().getRequest()
          req.user = { role: req.headers['x-test-role'] }
          return req.headers.authorization === 'Bearer test'
        },
      })
      .compile()
    app = module.createNestApplication()
    await app.listen(0, '127.0.0.1')
    base = await app.getUrl()
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => maintain.mockReset())
  it.each(['user', 'proxy', 'runner'])('denies %s at the real system-role guard', async (role) => {
    const response = await fetch(`${base}/admin/custom-domains/maintain`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'x-test-role': role },
    })
    expect(response.status).toBe(403)
    expect(maintain).not.toHaveBeenCalled()
  })
  it('allows an authenticated admin and awaits the maintenance operation', async () => {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    maintain.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
          entered()
        }),
    )
    let completed = false
    const pending = fetch(`${base}/admin/custom-domains/maintain`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'x-test-role': 'admin' },
    }).then((response) => {
      completed = true
      return response
    })
    await started
    expect(completed).toBe(false)
    release()
    expect((await pending).status).toBe(204)
  })
})
