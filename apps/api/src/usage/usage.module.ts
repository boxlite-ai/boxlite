/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { BoxUsagePeriod } from './entities/box-usage-period.entity'
import { UsageService } from './services/usage.service'
import { RedisLockProvider } from '../box/common/redis-lock.provider'
import { BoxUsagePeriodArchive } from './entities/box-usage-period-archive.entity'
import { BoxUsageExportOutbox } from './entities/box-usage-export-outbox.entity'
import { UsageExportOutboxService } from './services/usage-export-outbox.service'
import { UsageExportPublisherService } from './services/usage-export-publisher.service'
import { UsageAllocationSnapshotService } from './services/usage-allocation-snapshot.service'
import { BoxRepository } from '../box/repositories/box.repository'
import { BoxLookupCacheInvalidationService } from '../box/services/box-lookup-cache-invalidation.service'
import { Box } from '../box/entities/box.entity'
import { Runner } from '../box/entities/runner.entity'

@Module({
  imports: [
    TypeOrmModule.forFeature([BoxUsagePeriod, Box, Runner, BoxUsagePeriodArchive, BoxUsageExportOutbox]),
  ],
  providers: [
    UsageService,
    UsageExportOutboxService,
    UsageExportPublisherService,
    UsageAllocationSnapshotService,
    RedisLockProvider,
    BoxLookupCacheInvalidationService,
    {
      provide: BoxRepository,
      inject: [DataSource, EventEmitter2, BoxLookupCacheInvalidationService],
      useFactory: (
        dataSource: DataSource,
        eventEmitter: EventEmitter2,
        boxLookupCacheInvalidationService: BoxLookupCacheInvalidationService,
      ) => new BoxRepository(dataSource, eventEmitter, boxLookupCacheInvalidationService),
    },
  ],
  exports: [UsageService],
})
export class UsageModule {}
