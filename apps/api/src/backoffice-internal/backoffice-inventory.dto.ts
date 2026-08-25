/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Type } from 'class-transformer'
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator'
import { BoxState } from '../box/enums/box-state.enum'
import { RunnerState } from '../box/enums/runner-state.enum'

export const BACKOFFICE_INVENTORY_DEFAULT_LIMIT = 100
export const BACKOFFICE_INVENTORY_MAX_LIMIT = 200

class BackofficeInventoryPageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BACKOFFICE_INVENTORY_MAX_LIMIT)
  limit = BACKOFFICE_INVENTORY_DEFAULT_LIMIT
}

export class BackofficeBoxesQueryDto extends BackofficeInventoryPageQueryDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  regionId?: string

  @IsOptional()
  @IsUUID()
  runnerId?: string

  @IsOptional()
  @IsEnum(BoxState)
  state?: BoxState
}

export class BackofficeRunnersQueryDto extends BackofficeInventoryPageQueryDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  regionId?: string

  @IsOptional()
  @IsEnum(RunnerState)
  state?: RunnerState
}
