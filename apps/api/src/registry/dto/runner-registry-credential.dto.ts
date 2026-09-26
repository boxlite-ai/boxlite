/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator'
import { RegistryCredential } from '../entities/registry-credential.entity'
import { RegistryCredentialKind } from '../enums/registry-credential-kind.enum'

@ApiSchema({ name: 'RegistryCredentialLookup' })
export class RegistryCredentialLookupDto {
  @ApiProperty({ description: 'Organization the pull is for', example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsUUID()
  organizationId: string

  @ApiProperty({ description: 'Registry host as the tenant wrote it', example: 'ghcr.io' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  host: string

  @ApiProperty({ description: 'Repository on that host', example: 'acme/app' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  repository: string
}

/**
 * Where the registry proxy finds a login, not the login itself: the password
 * stays in Secret Manager, which the proxy reads and the API cannot.
 */
@ApiSchema({ name: 'RunnerRegistryCredential' })
export class RunnerRegistryCredentialDto {
  @ApiProperty({ enum: RegistryCredentialKind, enumName: 'RegistryCredentialKind', example: 'basic' })
  kind: RegistryCredentialKind

  @ApiProperty({ description: 'Username the registry expects', example: 'acme-bot' })
  username: string

  @ApiProperty({
    description: 'Secret Manager version holding the password',
    example: 'projects/123/secrets/registry-credential-123e4567-e89b-12d3-a456-426614174000/versions/1',
  })
  secretVersion: string

  static from(credential: RegistryCredential): RunnerRegistryCredentialDto {
    return { kind: credential.kind, username: credential.username, secretVersion: credential.secretVersion }
  }
}
