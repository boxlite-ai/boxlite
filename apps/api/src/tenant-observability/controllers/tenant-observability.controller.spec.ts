/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext, NestInterceptor, NotFoundException, Type } from '@nestjs/common'
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants'
import { OpenFeature } from '@openfeature/server-sdk'
import { of } from 'rxjs'
import { TenantObservabilityController } from './tenant-observability.controller'

describe('TenantObservabilityController feature gate', () => {
  beforeEach(async () => {
    await OpenFeature.clearProviders()
  })

  it.each(['getLogs', 'getTraces', 'getTraceSpans', 'getMetrics'] as const)(
    'keeps %s disabled when the tenant observability flag is unresolved',
    async (method) => {
      const interceptorTypes = Reflect.getMetadata(
        INTERCEPTORS_METADATA,
        TenantObservabilityController.prototype[method],
      ) as Type<NestInterceptor>[]
      expect(interceptorTypes).toHaveLength(1)

      const gate = new interceptorTypes[0]()
      const context = {
        switchToHttp: () => ({ getRequest: () => ({ method: 'GET', url: '/api/observability' }) }),
      } as unknown as ExecutionContext

      await expect(gate.intercept(context, { handle: () => of('ok') })).rejects.toBeInstanceOf(NotFoundException)
    },
  )
})
