/* Copyright 2026 BoxLite AI; SPDX-License-Identifier: AGPL-3.0 */
import { IsBoolean, ValidateIf, IsString, MaxLength } from 'class-validator'

export class PrepareTunnelDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  isPublic?: boolean
}

export class TunnelAccessDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(256)
  token?: string

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(128)
  userId?: string
}

export class TunnelHandoffDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(8192)
  grant?: string

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(64)
  ticket?: string
}
