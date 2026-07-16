/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { BoxService } from '../box/services/box.service'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { BoxliteNetworkController } from './boxlite-network.controller'

describe('BoxliteNetworkController', () => {
  let app: INestApplication

  afterEach(async () => {
    await app?.close()
  })

  it('exposes tunnels only through the prefixed REST route', async () => {
    const boxService = {
      getPortPreviewUrl: jest.fn().mockResolvedValue({ url: 'https://3000-box.proxy.example.test' }),
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [BoxliteNetworkController],
      providers: [{ provide: BoxService, useValue: boxService }],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { organizationId: 'org-1' }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0)
    const address = app.getHttpServer().address() as AddressInfo

    const canonical = await fetch(`http://127.0.0.1:${address.port}/api/v1/boxes/box-1/network/tunnel?port=3000`, {
      method: 'POST',
    })
    const prefixed = await fetch(`http://127.0.0.1:${address.port}/api/v1/org-1/boxes/box-1/network/tunnel?port=3000`, {
      method: 'POST',
    })

    expect(canonical.status).toBe(404)
    expect(prefixed.status).toBe(200)
    expect(await prefixed.json()).toEqual({ url: 'https://3000-box.proxy.example.test' })
    expect(boxService.getPortPreviewUrl).toHaveBeenCalledWith('box-1', 'org-1', 3000)
  })
})
