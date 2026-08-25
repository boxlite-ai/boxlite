/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Box } from '../box/entities/box.entity'
import { Job } from '../box/entities/job.entity'
import { Runner } from '../box/entities/runner.entity'
import { Region } from '../region/entities/region.entity'
import { BackofficeInternalController } from './backoffice-internal.controller'
import { BackofficeInventoryReader } from './backoffice-inventory.reader'
import { BackofficeWorkloadAuthenticator, BackofficeWorkloadAuthGuard } from './backoffice-workload-auth'

@Module({
  imports: [TypeOrmModule.forFeature([Box, Runner, Job, Region])],
  controllers: [BackofficeInternalController],
  providers: [BackofficeWorkloadAuthenticator, BackofficeWorkloadAuthGuard, BackofficeInventoryReader],
})
export class BackofficeInternalModule {}
