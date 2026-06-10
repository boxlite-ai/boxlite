/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsString, IsOptional, IsNumber, IsBoolean, IsArray, IsObject } from 'class-validator'

export class ExecRequestDto {
  @IsString()
  command: string

  @IsOptional()
  @IsArray()
  args?: string[]

  @IsOptional()
  @IsObject()
  env?: Record<string, string>

  @IsOptional()
  @IsNumber()
  timeout_seconds?: number

  @IsOptional()
  @IsString()
  working_dir?: string

  // User to run the command as (format: <name|uid>[:<group|gid>], same as
  // `docker exec --user`). Forwarded to the runner unchanged; the runner
  // resolves user/group against the guest's /etc/passwd before exec.
  @IsOptional()
  @IsString()
  user?: string

  @IsOptional()
  @IsBoolean()
  tty?: boolean
}

export class ExecResponseDto {
  execution_id: string
}
