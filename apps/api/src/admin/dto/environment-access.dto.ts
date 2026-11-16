/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Transform, Type } from 'class-transformer'
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'

export class EnvironmentAccessListDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(19)
  page = 0

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(320)
  @Matches(/^[^\u0000-\u001f\u007f]*$/)
  search?: string
}

export class EnvironmentAccessQueryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  @MaxLength(320)
  email: string
}

export class EnvironmentAccessUpdateDto extends EnvironmentAccessQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  userId: string

  @IsBoolean()
  allowed: boolean
}
