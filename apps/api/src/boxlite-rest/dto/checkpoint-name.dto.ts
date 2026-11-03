/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { IsBoolean, IsString, Matches, ValidateIf } from 'class-validator'

export class CheckpointNameDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  name?: string
}

export class CheckpointPauseDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  host_writers_stopped?: boolean
}
