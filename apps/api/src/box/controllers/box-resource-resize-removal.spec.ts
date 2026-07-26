/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'events'
import type { ExecutionContext, INestApplication } from '@nestjs/common'
import { PATH_METADATA } from '@nestjs/common/constants'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { OpenFeature, TypedInMemoryProvider } from '@openfeature/server-sdk'
import { Test } from '@nestjs/testing'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { BoxAccessGuard } from '../guards/box-access.guard'
import { RunnerService } from '../services/runner.service'
import { BoxService } from '../services/box.service'
import { BoxController } from './box.controller'

function productBoxControllerPaths(): unknown[] {
  return Object.getOwnPropertyNames(BoxController.prototype)
    .filter((property) => property !== 'constructor')
    .map((property) =>
      Reflect.getMetadata(PATH_METADATA, Object.getOwnPropertyDescriptor(BoxController.prototype, property)?.value),
    )
    .filter((path) => path !== undefined)
}

describe('Box resource resize removal', () => {
  let app: INestApplication | undefined

  afterEach(async () => {
    await app?.close()
    await OpenFeature.clearProviders()
    app = undefined
  })

  it('does not register a product resource-resize handler', () => {
    expect(productBoxControllerPaths()).not.toContain(':boxIdOrName/resize')
  })

  it('returns 404 for the removed product resource-resize endpoint', async () => {
    await OpenFeature.setProviderAndWait(
      new TypedInMemoryProvider({
        box_resize: {
          variants: { enabled: true },
          defaultVariant: 'enabled',
          disabled: false,
        },
      }),
    )

    const subscriber = Object.assign(new EventEmitter(), {
      subscribe: jest.fn().mockResolvedValue(1),
    })
    const redis = {
      duplicate: jest.fn(() => subscriber),
    }
    const boxService = {
      resize: jest.fn().mockResolvedValue({ id: 'box-1' }),
      toBoxDto: jest.fn().mockResolvedValue({ id: 'box-1' }),
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [BoxController],
      providers: [
        { provide: RunnerService, useValue: {} },
        { provide: BoxService, useValue: boxService },
        { provide: getRedisConnectionToken(), useValue: redis },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = {
            organizationId: 'org-1',
            organization: { id: 'org-1' },
          }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(BoxAccessGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0)

    const address = app.getHttpServer().address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/api/box/box-1/resize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cpu: 2 }),
    })

    expect(response.status).toBe(404)
    expect(boxService.resize).not.toHaveBeenCalled()
  })
})
