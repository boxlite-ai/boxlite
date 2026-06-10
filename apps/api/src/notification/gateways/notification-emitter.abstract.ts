/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDto } from '../../box/dto/box.dto'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { VolumeDto } from '../../box/dto/volume.dto'
import { VolumeState } from '../../box/enums/volume-state.enum'
import { RunnerDto } from '../../box/dto/runner.dto'
import { RunnerState } from '../../box/enums/runner-state.enum'

export abstract class NotificationEmitter {
  abstract emitBoxCreated(box: BoxDto): void
  abstract emitBoxStateUpdated(box: BoxDto, oldState: BoxState, newState: BoxState): void
  abstract emitBoxDesiredStateUpdated(
    box: BoxDto,
    oldDesiredState: BoxDesiredState,
    newDesiredState: BoxDesiredState,
  ): void
  abstract emitVolumeCreated(volume: VolumeDto): void
  abstract emitVolumeStateUpdated(volume: VolumeDto, oldState: VolumeState, newState: VolumeState): void
  abstract emitVolumeLastUsedAtUpdated(volume: VolumeDto): void
  abstract emitRunnerCreated(runner: RunnerDto, organizationId: string | null): void
  abstract emitRunnerStateUpdated(
    runner: RunnerDto,
    organizationId: string | null,
    oldState: RunnerState,
    newState: RunnerState,
  ): void
  abstract emitRunnerUnschedulableUpdated(runner: RunnerDto, organizationId: string | null): void
}
