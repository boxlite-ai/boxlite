/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Region } from './entities/region.entity'
import { RegionService } from './services/region.service'
import { Runner } from '../box/entities/runner.entity'
import { RegionController } from './controllers/region.controller'

@Module({
  imports: [TypeOrmModule.forFeature([Region, Runner])],
  controllers: [RegionController],
  providers: [RegionService],
  exports: [RegionService],
})
export class RegionModule {}
