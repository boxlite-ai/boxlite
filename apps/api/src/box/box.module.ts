/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { BoxController } from './controllers/box.controller'
import { BoxService } from './services/box.service'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Box } from './entities/box.entity'
import { UserModule } from '../user/user.module'
import { RunnerService } from './services/runner.service'
import { Runner } from './entities/runner.entity'
import { RunnerController } from './controllers/runner.controller'
import { ToolboxService } from './services/toolbox.deprecated.service'
import { DockerRegistryModule } from '../docker-registry/docker-registry.module'
import { BoxManager } from './managers/box.manager'
import { ToolboxController } from './controllers/toolbox.deprecated.controller'
import { Snapshot } from './entities/snapshot.entity'
import { SnapshotController } from './controllers/snapshot.controller'
import { SnapshotService } from './services/snapshot.service'
import { SnapshotManager } from './managers/snapshot.manager'
import { SnapshotRunner } from './entities/snapshot-runner.entity'
import { DockerRegistry } from '../docker-registry/entities/docker-registry.entity'
import { RedisLockProvider } from './common/redis-lock.provider'
import { OrganizationModule } from '../organization/organization.module'
import { BoxWarmPoolService } from './services/box-warm-pool.service'
import { WarmPool } from './entities/warm-pool.entity'
import { PreviewController } from './controllers/preview.controller'
import { SnapshotSubscriber } from './subscribers/snapshot.subscriber'
import { VolumeController } from './controllers/volume.controller'
import { VolumeService } from './services/volume.service'
import { VolumeManager } from './managers/volume.manager'
import { Volume } from './entities/volume.entity'
import { BuildInfo } from './entities/build-info.entity'
import { BackupManager } from './managers/backup.manager'
import { VolumeSubscriber } from './subscribers/volume.subscriber'
import { RunnerSubscriber } from './subscribers/runner.subscriber'
import { WorkspaceController } from './controllers/workspace.deprecated.controller'
import { RunnerAdapterFactory } from './runner-adapter/runnerAdapter'
import { BoxStartAction } from './managers/box-actions/box-start.action'
import { BoxStopAction } from './managers/box-actions/box-stop.action'
import { BoxDestroyAction } from './managers/box-actions/box-destroy.action'
import { BoxArchiveAction } from './managers/box-actions/box-archive.action'
import { SshAccess } from './entities/ssh-access.entity'
import { BoxRepository } from './repositories/box.repository'
import { ProxyCacheInvalidationService } from './services/proxy-cache-invalidation.service'
import { RegionModule } from '../region/region.module'
import { Region } from '../region/entities/region.entity'
import { SnapshotRegion } from './entities/snapshot-region.entity'
import { JobController } from './controllers/job.controller'
import { JobService } from './services/job.service'
import { JobStateHandlerService } from './services/job-state-handler.service'
import { Job } from './entities/job.entity'
import { BoxLookupCacheInvalidationService } from './services/box-lookup-cache-invalidation.service'
import { BoxAccessGuard } from './guards/box-access.guard'
import { RunnerAccessGuard } from './guards/runner-access.guard'
import { RegionRunnerAccessGuard } from './guards/region-runner-access.guard'
import { RegionBoxAccessGuard } from './guards/region-box-access.guard'
import { ProxyGuard } from './guards/proxy.guard'
import { SshGatewayGuard } from './guards/ssh-gateway.guard'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { BoxLastActivity } from './entities/box-last-activity.entity'
import { BoxActivityService } from './services/box-activity.service'
import { BoxStateWaiterService } from './services/box-state-waiter.service'

@Module({
  imports: [
    UserModule,
    DockerRegistryModule,
    OrganizationModule,
    RegionModule,
    TypeOrmModule.forFeature([
      Box,
      Runner,
      Snapshot,
      BuildInfo,
      SnapshotRunner,
      SnapshotRegion,
      DockerRegistry,
      WarmPool,
      Volume,
      SshAccess,
      Region,
      Job,
      BoxLastActivity,
    ]),
  ],
  controllers: [
    BoxController,
    RunnerController,
    ToolboxController,
    SnapshotController,
    WorkspaceController,
    PreviewController,
    VolumeController,
    JobController,
  ],
  providers: [
    BoxService,
    BoxManager,
    BackupManager,
    BoxWarmPoolService,
    RunnerService,
    ToolboxService,
    SnapshotService,
    ProxyCacheInvalidationService,
    BoxLookupCacheInvalidationService,
    SnapshotManager,
    RedisLockProvider,
    SnapshotSubscriber,
    VolumeService,
    VolumeManager,
    VolumeSubscriber,
    RunnerSubscriber,
    RunnerAdapterFactory,
    BoxStartAction,
    BoxStopAction,
    BoxDestroyAction,
    BoxArchiveAction,
    JobService,
    JobStateHandlerService,
    BoxActivityService,
    BoxStateWaiterService,
    BoxAccessGuard,
    RunnerAccessGuard,
    RegionRunnerAccessGuard,
    RegionBoxAccessGuard,
    ProxyGuard,
    SshGatewayGuard,
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
  exports: [
    BoxService,
    RunnerService,
    RedisLockProvider,
    SnapshotService,
    VolumeService,
    VolumeManager,
    BoxRepository,
    RunnerAdapterFactory,
    BoxActivityService,
    BoxStateWaiterService,
  ],
})
export class BoxModule {}
