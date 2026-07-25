/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsInt, IsOptional, IsString, Max, Min, MaxLength } from 'class-validator'
import { TemporarySshCredential } from '../entities/temporary-ssh-credential.entity'
import { TemporarySshCredentialStatus } from '../enums/temporary-ssh-credential-status.enum'

@ApiSchema({ name: 'CreateTemporarySshCredential' })
export class CreateTemporarySshCredentialDto {
  @ApiProperty({
    description: 'ID of a previously issued, active `ssh`-scoped access grant for this box',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  grantId: string

  @ApiProperty({
    description: 'Canonical OpenSSH public key line, e.g. "ssh-ed25519 AAAA... user@host"',
    example: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBb2... user@host',
  })
  @IsString()
  @MaxLength(8192)
  publicKey: string

  @ApiPropertyOptional({
    description: 'Credential lifetime in seconds (default 300, max bounded by the parent grant expiry)',
    example: 300,
    minimum: 30,
    maximum: 3600,
  })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3600)
  expiresInSeconds?: number
}

// Create response: includes the direct-tunnel connection material derived
// from the same port-22/ProxyCommand mechanism existing box previews use.
// Never includes the submitted public key body.
@ApiSchema({ name: 'TemporarySshCredentialCreated' })
export class TemporarySshCredentialResponseDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  grantId: string

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  boxId: string

  @ApiProperty({ example: 'root' })
  unixUser: string

  @ApiProperty({ example: 'SHA256:abcd1234...' })
  publicKeyFingerprint: string

  @ApiProperty({ example: '2025-01-01T12:00:00.000Z' })
  expiresAt: Date

  @ApiProperty({ example: '22-d-<hex-box-id>.proxy.dev.boxlite.ai' })
  endpoint: string

  @ApiProperty({ example: 'proxytunnel -q -E -p proxy.dev.boxlite.ai:443 -d %h:%p' })
  proxyCommand: string

  @ApiProperty({ example: 'SHA256:efgh5678...' })
  hostKeyFingerprint: string

  @ApiProperty({ example: '22-d-<hex-box-id>.proxy.dev.boxlite.ai ssh-ed25519 AAAA...' })
  knownHostsEntry: string

  @ApiProperty({
    example:
      "ssh -i <private-key> -o 'ProxyCommand=proxytunnel -q -E -p proxy.dev.boxlite.ai:443 -d %h:%p' root@22-d-<hex-box-id>.proxy.dev.boxlite.ai",
  })
  sshCommand: string

  static build(
    credential: TemporarySshCredential,
    connection: {
      endpoint: string
      proxyCommand: string
      hostPublicKey: string
      hostKeyFingerprint: string
    },
  ): TemporarySshCredentialResponseDto {
    const dto = new TemporarySshCredentialResponseDto()
    dto.id = credential.id
    dto.grantId = credential.grantId
    dto.boxId = credential.boxId
    dto.unixUser = credential.unixUser
    dto.publicKeyFingerprint = credential.publicKeyFingerprint
    dto.expiresAt = credential.expiresAt
    dto.endpoint = connection.endpoint
    dto.proxyCommand = connection.proxyCommand
    dto.hostKeyFingerprint = connection.hostKeyFingerprint
    dto.knownHostsEntry = `${connection.endpoint} ${connection.hostPublicKey}`
    dto.sshCommand = `ssh -i <private-key> -o 'ProxyCommand=${connection.proxyCommand}' ${credential.unixUser}@${connection.endpoint}`
    return dto
  }
}

@ApiSchema({ name: 'TemporarySshCredential' })
export class TemporarySshCredentialDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  grantId: string

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  boxId: string

  @ApiProperty({ example: 'SHA256:abcd1234...' })
  publicKeyFingerprint: string

  @ApiProperty({ enum: TemporarySshCredentialStatus })
  status: TemporarySshCredentialStatus

  @ApiProperty({ example: '2025-01-01T12:00:00.000Z' })
  expiresAt: Date

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  createdBy: string

  @ApiProperty({ example: '2025-01-01T11:00:00.000Z' })
  createdAt: Date

  static fromCredential(credential: TemporarySshCredential): TemporarySshCredentialDto {
    const dto = new TemporarySshCredentialDto()
    dto.id = credential.id
    dto.grantId = credential.grantId
    dto.boxId = credential.boxId
    dto.publicKeyFingerprint = credential.publicKeyFingerprint
    dto.status = credential.status
    dto.expiresAt = credential.expiresAt
    dto.createdBy = credential.createdBy
    dto.createdAt = credential.createdAt
    return dto
  }
}
