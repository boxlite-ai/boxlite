/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator'
import { RegistryCredential } from '../entities/registry-credential.entity'
import { RegistryCredentialKind } from '../enums/registry-credential-kind.enum'
import { credentialedRegistryHosts } from '../utils/registry-proxy.util'

/**
 * Whole path segments ending in '/', or nothing for the whole host — the shape
 * the table's CHECK holds, refused here first with a message a caller can act on.
 */
export const REPOSITORY_PREFIX = /^([a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*\/)*$/

/**
 * A new login. The password travels in this body and nowhere else, and no
 * message about it repeats what was sent: every validator here keeps to its
 * default message, which names the field and never the value.
 */
@ApiSchema({ name: 'CreateRegistryCredential' })
export class CreateRegistryCredentialDto {
  @ApiProperty({ description: 'Registry the login is for', example: 'ghcr.io' })
  @IsIn(credentialedRegistryHosts())
  registryHost: string

  @ApiPropertyOptional({
    description: 'Repositories it covers, as whole path segments ending in "/"; empty for the whole registry',
    example: 'acme/',
    default: '',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(REPOSITORY_PREFIX, { message: 'repositoryPrefix must be empty or path segments ending in "/"' })
  repositoryPrefix?: string

  @ApiProperty({ description: 'Username the registry expects', example: 'acme-bot' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  username: string

  // Checked for presence and length only. Whether it works is the registry's
  // to say, and a format rule here would be one more message to keep clean.
  @ApiProperty({ description: 'Password or access token. Never returned.', writeOnly: true })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8192)
  password: string
}

/** A login as the API reports it. There is no password field to leave out. */
@ApiSchema({ name: 'RegistryCredential' })
export class RegistryCredentialDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string

  @ApiProperty({ enum: RegistryCredentialKind, enumName: 'RegistryCredentialKind', example: 'basic' })
  kind: RegistryCredentialKind

  @ApiProperty({ example: 'ghcr.io' })
  registryHost: string

  @ApiProperty({ description: 'Empty for the whole registry', example: 'acme/' })
  repositoryPrefix: string

  @ApiProperty({ example: 'acme-bot' })
  username: string

  @ApiProperty({ description: 'The user who added it', nullable: true, type: String })
  createdBy: string | null

  @ApiProperty({ example: '2026-01-01T00:00:00.000Z' })
  createdAt: string

  static from(credential: RegistryCredential): RegistryCredentialDto {
    return {
      id: credential.id,
      kind: credential.kind,
      registryHost: credential.registryHost,
      repositoryPrefix: credential.repositoryPrefix,
      username: credential.username,
      createdBy: credential.createdBy,
      createdAt: credential.createdAt.toISOString(),
    }
  }
}
