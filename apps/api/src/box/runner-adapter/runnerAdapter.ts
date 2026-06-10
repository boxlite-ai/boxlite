/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Runner } from '../entities/runner.entity'
import { ModuleRef } from '@nestjs/core'
import { RunnerAdapterV0 } from './runnerAdapter.v0'
import { RunnerAdapterV2 } from './runnerAdapter.v2'
import { BuildInfo } from '../entities/build-info.entity'
import { DockerRegistry } from '../../docker-registry/entities/docker-registry.entity'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BackupState } from '../enums/backup-state.enum'
import { RunnerServiceInfo } from '../common/runner-service-info'

export interface RunnerBoxInfo {
  state: BoxState
  daemonVersion?: string
  backupState?: BackupState
  backupSnapshot?: string
  backupErrorReason?: string
}

export interface RunnerSnapshotInfo {
  name: string
  sizeGB: number
  entrypoint: string[]
  cmd: string[]
  hash: string
}

export interface SnapshotDigestResponse {
  hash: string
  sizeGB: number
}

export interface RunnerMetrics {
  currentAllocatedCpu?: number
  currentAllocatedDiskGiB?: number
  currentAllocatedMemoryGiB?: number
  currentCpuUsagePercentage?: number
  currentDiskUsagePercentage?: number
  currentMemoryUsagePercentage?: number
  currentSnapshotCount?: number
  currentStartedBoxes?: number
}

export interface RunnerInfo {
  serviceHealth?: RunnerServiceInfo[]
  metrics?: RunnerMetrics
  appVersion?: string
}

export interface StartBoxResponse {
  daemonVersion: string
}

export interface RunnerAdapter {
  init(runner: Runner): Promise<void>

  healthCheck(signal?: AbortSignal): Promise<void>

  runnerInfo(signal?: AbortSignal): Promise<RunnerInfo>

  boxInfo(boxId: string): Promise<RunnerBoxInfo>
  createBox(
    box: Box,
    snapshotRef: string,
    registry?: DockerRegistry,
    entrypoint?: string[],
    metadata?: { [key: string]: string },
    otelEndpoint?: string,
    skipStart?: boolean,
  ): Promise<StartBoxResponse | undefined>
  startBox(
    boxId: string,
    authToken: string,
    metadata?: { [key: string]: string },
    skipStart?: boolean,
  ): Promise<StartBoxResponse | undefined>
  stopBox(boxId: string, force?: boolean): Promise<void>
  destroyBox(boxId: string): Promise<void>
  createBackup(box: Box, backupSnapshotName: string, registry?: DockerRegistry): Promise<void>

  removeSnapshot(snapshotName: string): Promise<void>
  buildSnapshot(
    buildInfo: BuildInfo,
    organizationId?: string,
    sourceRegistries?: DockerRegistry[],
    registry?: DockerRegistry,
    pushToInternalRegistry?: boolean,
  ): Promise<void>
  pullSnapshot(
    snapshotName: string,
    registry?: DockerRegistry,
    destinationRegistry?: DockerRegistry,
    destinationRef?: string,
    newTag?: string,
  ): Promise<void>
  snapshotExists(snapshotRef: string): Promise<boolean>
  getSnapshotInfo(snapshotName: string): Promise<RunnerSnapshotInfo>
  inspectSnapshotInRegistry(snapshotName: string, registry?: DockerRegistry): Promise<SnapshotDigestResponse>

  updateNetworkSettings(
    boxId: string,
    networkBlockAll?: boolean,
    networkAllowList?: string,
    networkLimitEgress?: boolean,
  ): Promise<void>

  recoverBox(box: Box): Promise<void>

  resizeBox(boxId: string, cpu?: number, memory?: number, disk?: number): Promise<void>
}

@Injectable()
export class RunnerAdapterFactory {
  private readonly logger = new Logger(RunnerAdapterFactory.name)

  constructor(private moduleRef: ModuleRef) {}

  async create(runner: Runner): Promise<RunnerAdapter> {
    switch (runner.apiVersion) {
      case '0': {
        const adapter = await this.moduleRef.create(RunnerAdapterV0)
        await adapter.init(runner)
        return adapter
      }
      case '2': {
        const adapter = await this.moduleRef.create(RunnerAdapterV2)
        await adapter.init(runner)
        return adapter
      }
      default:
        throw new Error(`Unsupported runner version: ${runner.apiVersion}`)
    }
  }
}
