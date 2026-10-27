/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty } from '@nestjs/swagger'
import { IsBoolean } from 'class-validator'
import { RunnerState } from '../enums/runner-state.enum'

export class UpdateRunnerDrainingDto {
  @ApiProperty()
  @IsBoolean()
  draining: boolean
}

export class RunnerDrainStatusDto {
  @ApiProperty()
  id: string

  @ApiProperty({ enum: RunnerState, enumName: 'RunnerState' })
  state: RunnerState

  @ApiProperty()
  draining: boolean

  @ApiProperty()
  assignedBoxes: number

  @ApiProperty({ description: 'Unfinished migrations involving either side of this runner' })
  activeMigrations: number

  @ApiProperty({ description: 'Pending or in-progress runner jobs' })
  pendingJobs: number
}
