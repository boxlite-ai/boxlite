/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsOptional, IsString, IsNumber, IsBoolean, IsObject, IsArray } from 'class-validator'

export class CreateBoxDto {
  @IsOptional()
  @IsString()
  name?: string

  @IsOptional()
  @IsString()
  image?: string

  @IsOptional()
  @IsNumber()
  cpus?: number

  @IsOptional()
  @IsNumber()
  memory_mib?: number

  @IsOptional()
  @IsNumber()
  disk_size_gb?: number

  @IsOptional()
  @IsString()
  working_dir?: string

  @IsOptional()
  @IsObject()
  env?: Record<string, string>

  @IsOptional()
  @IsArray()
  entrypoint?: string[]

  @IsOptional()
  @IsArray()
  cmd?: string[]

  @IsOptional()
  @IsString()
  user?: string

  @IsOptional()
  @IsBoolean()
  auto_remove?: boolean

  @IsOptional()
  @IsBoolean()
  detach?: boolean
}
