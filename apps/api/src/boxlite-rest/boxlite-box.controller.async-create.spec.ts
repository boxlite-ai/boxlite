/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { INestApplication, RequestTimeoutException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { AddressInfo } from 'node:net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { BoxState } from '../box/enums/box-state.enum'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { BoxliteBoxController } from './boxlite-box.controller'

describe('BoxliteBoxController asynchronous create HTTP', () => {
  let app: INestApplication, endpoint: string
  const organization = { id: '11111111-1111-4111-8111-111111111111' }
  const boxService = { create: jest.fn() }
  const waiter = { waitForStarted: jest.fn() }
  const commerce = { resolveMaxCreatedBoxes: jest.fn().mockResolvedValue(3) }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BoxliteBoxController],
      providers: [
        { provide: BoxService, useValue: boxService },
        { provide: BoxStateWaiterService, useValue: waiter },
        { provide: CommerceBoxLimitService, useValue: commerce },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate(context: { switchToHttp(): { getRequest(): { user: unknown } } }) {
          context.switchToHttp().getRequest().user = { organization, organizationId: organization.id }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication({ logger: false })
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    endpoint = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/${organization.id}/boxes`
  })
  afterAll(async () => app?.close())
  beforeEach(() => {
    boxService.create.mockReset()
    waiter.waitForStarted.mockReset().mockRejectedValue(new RequestTimeoutException('VM is still starting'))
  })

  it.each([
    [BoxState.CREATING, 'configured'],
    [BoxState.STARTING, 'configured'],
    [BoxState.STARTED, 'running'],
  ])('returns the persisted identity while the backend is %s', async (state, status) => {
    boxService.create.mockResolvedValue({
      id: 'original-box-id',
      name: 'ci-jit-test',
      organizationId: organization.id,
      state,
      image: 'ghcr.io/actions/actions-runner:latest',
      cpu: 2,
      memory: 2,
      labels: {},
    })
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ci-jit-test', image: 'ghcr.io/actions/actions-runner:latest' }),
    })
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body).toEqual(expect.objectContaining({ box_id: 'original-box-id', status }))
    expect(waiter.waitForStarted).not.toHaveBeenCalled()
    expect(boxService.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ci-jit-test' }),
      organization,
      expect.anything(),
      { maxCreatedBoxes: 3 },
    )
  })
})
