/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Type } from 'class-transformer'
import { ArrayMaxSize, IsArray, IsString, ValidateNested } from 'class-validator'

const MAX_SECRETS = 32
const MAX_SECRET_HOSTS = 64

export class UpdateBoxSecretDto {
  @IsString()
  name: string

  @IsString()
  value: string

  @IsArray()
  @ArrayMaxSize(MAX_SECRET_HOSTS)
  @IsString({ each: true })
  hosts: string[]

  @IsString()
  placeholder: string
}

export class UpdateBoxSecretsDto {
  @Type(() => UpdateBoxSecretDto)
  @ValidateNested({ each: true })
  @IsArray()
  @ArrayMaxSize(MAX_SECRETS)
  secrets: UpdateBoxSecretDto[]
}
