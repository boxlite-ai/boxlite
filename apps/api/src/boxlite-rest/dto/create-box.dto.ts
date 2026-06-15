/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Type } from 'class-transformer'
import {
  IsOptional,
  IsString,
  IsNumber,
  IsBoolean,
  IsObject,
  IsArray,
  Min,
  IsIn,
  ValidateNested,
} from 'class-validator'

export class NetworkSpecDto {
  @IsIn(['enabled', 'disabled'])
  mode: 'enabled' | 'disabled'

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allow_net?: string[]
}

export class CreateBoxDto {
  @IsOptional()
  @IsString()
  name?: string

  @IsOptional()
  @IsString()
  image?: string

  // A box with 0 vCPUs can never boot (libkrun set_vm_config(0, ...) → EINVAL),
  // so reject undersized resources at the request boundary instead of accepting
  // a box that fails to start.
  @IsOptional()
  @IsNumber()
  @Min(1)
  cpus?: number

  @IsOptional()
  @IsNumber()
  @Min(256)
  memory_mib?: number

  @IsOptional()
  @IsNumber()
  @Min(1)
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

  @IsOptional()
  @ValidateNested()
  @Type(() => NetworkSpecDto)
  network?: NetworkSpecDto
}
