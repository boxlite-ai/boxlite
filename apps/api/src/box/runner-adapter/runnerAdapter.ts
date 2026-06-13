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
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { RunnerServiceInfo } from '../common/runner-service-info'

export interface RunnerBoxInfo {
  state: BoxState
  daemonVersion?: string
}

export interface RunnerMetrics {
  currentAllocatedCpu?: number
  currentAllocatedDiskGiB?: number
  currentAllocatedMemoryGiB?: number
  currentCpuUsagePercentage?: number
  currentDiskUsagePercentage?: number
  currentMemoryUsagePercentage?: number
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
  createBox(box: Box, metadata?: { [key: string]: string }): Promise<StartBoxResponse | undefined>
  startBox(
    boxId: string,
    authToken: string,
    metadata?: { [key: string]: string },
    skipStart?: boolean,
  ): Promise<StartBoxResponse | undefined>
  stopBox(boxId: string, force?: boolean): Promise<void>
  destroyBox(boxId: string): Promise<void>

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
