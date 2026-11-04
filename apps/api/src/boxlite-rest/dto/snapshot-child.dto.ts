/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { Type } from 'class-transformer'
import { IsOptional, IsString, ValidateNested } from 'class-validator'
import { CreateBoxDto } from './create-box.dto'

export class SnapshotChildDto {
  @IsOptional()
  @IsString()
  name?: string

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateBoxDto)
  options?: CreateBoxDto
}
