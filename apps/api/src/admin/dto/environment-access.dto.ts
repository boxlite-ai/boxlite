/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Transform } from 'class-transformer'
import { IsBoolean, IsEmail, IsString, MaxLength, MinLength } from 'class-validator'

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
