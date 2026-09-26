/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { OrganizationService } from '../../organization/services/organization.service'
import { OrganizationUserService } from '../../organization/services/organization-user.service'
import { BoxAccessGuard } from '../guards/box-access.guard'
import { RegionBoxAccessGuard } from '../guards/region-box-access.guard'
import { BoxAutoResumeService } from '../services/box-auto-resume.service'
import { BoxService } from '../services/box.service'
import { BoxState } from '../enums/box-state.enum'
import { PreviewController } from './preview.controller'

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

// The unit spec beside this one calls ensureBoxReady directly, which is exactly
// how the route shipped unauthenticated: constructing the controller skips the
// guard chain, so nothing there could notice that no strategy runs on this
// route. This one goes over HTTP so the chain is what is under test.
describe('POST /preview/:boxId/ensure-ready — guard chain', () => {
  let app: INestApplication
  let baseUrl: string
  const ensureReady = jest.fn().mockResolvedValue(undefined)

  beforeEach(async () => {
    ensureReady.mockClear()
    const moduleRef = await Test.createTestingModule({
      controllers: [PreviewController],
      providers: [
        {
          provide: BoxService,
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              id: 'box-uuid',
              organizationId: 'org-1',
              state: BoxState.STOPPED,
              autoResume: true,
            }),
          },
        },
        { provide: OrganizationUserService, useValue: {} },
        { provide: BoxAutoResumeService, useValue: { ensureReady } },
        { provide: OrganizationService, useValue: { findOne: jest.fn().mockResolvedValue({ id: 'org-1' }) } },
      ],
    })
      // The controller injects Redis, which this route never touches; let Nest
      // fill that (and anything else unlisted) rather than naming an injection
      // token this test would then be asserting on by accident.
      .useMocker(() => ({}))
      // Stands in for a valid proxy credential: the real CombinedAuthGuard runs
      // the strategies, and this is the shape a proxy bearer resolves to.
      // ProxyGuard below is the real one and reads exactly this.
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { role: 'proxy' }
          return true
        },
      })
      // The other two OrGuard arms are for user-facing callers; deny them so
      // the proxy arm is the only way through and the test cannot pass by the
      // wrong door.
      .overrideGuard(BoxAccessGuard)
      .useValue({ canActivate: () => false })
      .overrideGuard(RegionBoxAccessGuard)
      .useValue({ canActivate: () => false })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0)
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await app?.close()
  })

  it('lets a proxy credential through to the resume', async () => {
    // Without CombinedAuthGuard on the route no strategy runs, request.user
    // stays undefined, every OrGuard arm refuses, and this answers 403 — the
    // shape that made the whole wake feature a no-op on the dev stage.
    const response = await fetch(`${baseUrl}/api/preview/box-1/ensure-ready`, { method: 'POST' })

    expect(response.status).toBe(204)
    expect(ensureReady).toHaveBeenCalledWith('box-uuid', { id: 'org-1' })
  })
})
