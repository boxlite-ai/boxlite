/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator'
import { REPOSITORY_PREFIX } from '../../registry/dto/registry-credential.dto'
import { credentialedRegistryHosts } from '../../registry/utils/registry-proxy.util'

/**
 * A new registry login, in the box API's snake_case. The rules are the
 * console's (`CreateRegistryCredentialDto`), and so is their care: every
 * validator keeps to its default message, which names the field and never the
 * value, so no refusal repeats the password.
 */
export class CreateRegistryDto {
  @IsIn(credentialedRegistryHosts())
  registry_host: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(REPOSITORY_PREFIX, { message: 'repository_prefix must be empty or path segments ending in "/"' })
  repository_prefix?: string

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  username: string

  @IsString()
  @IsNotEmpty()
  @MaxLength(8192)
  password: string
}
