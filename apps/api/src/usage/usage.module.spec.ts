/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MODULE_METADATA } from '@nestjs/common/constants'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { Box } from '../box/entities/box.entity'
import { BoxRepository } from '../box/repositories/box.repository'
import { BoxLookupCacheInvalidationService } from '../box/services/box-lookup-cache-invalidation.service'
import { RedisLockProvider } from '../box/common/redis-lock.provider'
import { BoxUsagePeriod } from './entities/box-usage-period.entity'
import { BoxUsagePeriodArchive } from './entities/box-usage-period-archive.entity'
import { BoxUsageExportOutbox } from './entities/box-usage-export-outbox.entity'
import { UsageExportOutboxService } from './services/usage-export-outbox.service'
import { UsageExportPublisherService } from './services/usage-export-publisher.service'
import { UsageService } from './services/usage.service'
import { UsageModule } from './usage.module'

// Everything the module reaches for outside its own providers — the DataSource,
// the ioredis connection — is stubbed, and useMocker fills in any token the
// module forgot to provide. So a compile proves the wiring it *does* declare is
// constructible, not that the declarations are complete; the metadata tests
// below cover what it would otherwise let through.
// The DataSource shape is what @nestjs/typeorm's repository factory and
// BaseRepository read while wiring up.
const externalStub = () => ({
  entityMetadatas: [],
  options: { type: 'postgres' },
  getRepository: () => ({}),
})

describe('UsageModule', () => {
  it('resolves UsageService and builds BoxRepository through its factory', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [UsageModule] })
      .useMocker(externalStub)
      .compile()

    expect(moduleRef.get(UsageService)).toBeInstanceOf(UsageService)
    expect(moduleRef.get(RedisLockProvider)).toBeInstanceOf(RedisLockProvider)
    expect(moduleRef.get(BoxRepository)).toBeInstanceOf(BoxRepository)
    expect(moduleRef.get(UsageExportOutboxService)).toBeInstanceOf(UsageExportOutboxService)
    expect(moduleRef.get(UsageExportPublisherService)).toBeInstanceOf(UsageExportPublisherService)
  })

  it('registers every entity repository and provider its service resolves through', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, UsageModule) as Array<any>
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, UsageModule) as Array<any>
    const importedTokens = imports.flatMap((imported) => imported?.providers ?? []).map((provider) => provider?.provide)

    expect(importedTokens).toEqual(
      expect.arrayContaining([
        getRepositoryToken(BoxUsagePeriod),
        getRepositoryToken(BoxUsagePeriodArchive),
        getRepositoryToken(BoxUsageExportOutbox),
        getRepositoryToken(Box),
      ]),
    )
    expect(providers).toContain(BoxLookupCacheInvalidationService)
    // Dropping either of these leaves every service-level test green while the
    // exporter silently stops running.
    expect(providers).toContain(UsageExportOutboxService)
    expect(providers).toContain(UsageExportPublisherService)
  })

  // This module hand-rolls its own BoxRepository factory instead of importing
  // BoxModule, so a dependency added, dropped or reordered in the constructor
  // would silently arrive as `undefined` or in the wrong slot — Nest checks
  // neither the arity nor the order of a useFactory's inject list.
  it('injects exactly the BoxRepository constructor parameters, in order', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, UsageModule) as Array<any>
    const boxRepositoryProvider = providers.find((provider) => provider?.provide === BoxRepository)

    expect(boxRepositoryProvider.inject).toEqual([DataSource, EventEmitter2, BoxLookupCacheInvalidationService])
    expect(boxRepositoryProvider.inject).toHaveLength(BoxRepository.length)
  })
})
