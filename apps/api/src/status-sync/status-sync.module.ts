/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { TypeOrmModule } from '@nestjs/typeorm'
import { RedisLockProvider } from '../box/common/redis-lock.provider'
import { RedisHealthIndicator } from '../health/redis.health'
import { Runner } from '../box/entities/runner.entity'
import { Region } from '../region/entities/region.entity'
import { IncidentIoClient } from './services/incident-io.client'
import { StatusSyncService } from './services/status-sync.service'

/**
 * Cron-only module — nothing imports it and no request path touches it, so its
 * AppModule registration is pinned by app.module.spec.ts the same way the
 * usage ledger's is. RedisLockProvider and RedisHealthIndicator are
 * re-provided locally (the usage-module precedent) instead of importing
 * BoxModule/HealthModule, which would drag whole controller graphs into a
 * background job.
 */
@Module({
  imports: [TerminusModule, TypeOrmModule.forFeature([Runner, Region])],
  providers: [StatusSyncService, IncidentIoClient, RedisLockProvider, RedisHealthIndicator],
})
export class StatusSyncModule {}
