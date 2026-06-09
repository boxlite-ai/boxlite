/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SandboxDto } from '../../sandbox/dto/sandbox.dto'
import { SandboxState } from '../../sandbox/enums/sandbox-state.enum'
import { SandboxDesiredState } from '../../sandbox/enums/sandbox-desired-state.enum'
import { BoxTemplateDto } from '../../sandbox/dto/box-template.dto'
import { BoxTemplateState } from '../../sandbox/enums/box-template-state.enum'
import { VolumeDto } from '../../sandbox/dto/volume.dto'
import { VolumeState } from '../../sandbox/enums/volume-state.enum'
import { RunnerDto } from '../../sandbox/dto/runner.dto'
import { RunnerState } from '../../sandbox/enums/runner-state.enum'

export abstract class NotificationEmitter {
  abstract emitSandboxCreated(sandbox: SandboxDto): void
  abstract emitSandboxStateUpdated(sandbox: SandboxDto, oldState: SandboxState, newState: SandboxState): void
  abstract emitSandboxDesiredStateUpdated(
    sandbox: SandboxDto,
    oldDesiredState: SandboxDesiredState,
    newDesiredState: SandboxDesiredState,
  ): void
  abstract emitTemplateCreated(template: BoxTemplateDto): void
  abstract emitBoxTemplateStateUpdated(
    template: BoxTemplateDto,
    oldState: BoxTemplateState,
    newState: BoxTemplateState,
  ): void
  abstract emitTemplateRemoved(template: BoxTemplateDto): void
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
