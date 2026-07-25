/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsArray, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator'
import { BoxAccessGrant } from '../entities/box-access-grant.entity'
import { BoxAccessGrantScope } from '../enums/box-access-grant-scope.enum'
import { BoxAccessGrantStatus } from '../enums/box-access-grant-status.enum'

@ApiSchema({ name: 'CreateBoxAccessGrant' })
export class CreateBoxAccessGrantDto {
  @ApiProperty({
    description: 'Capability scopes requested for this box-scoped app key. Only "ssh" is supported today.',
    enum: BoxAccessGrantScope,
    isArray: true,
    example: [BoxAccessGrantScope.SSH],
  })
  @IsArray()
  @IsEnum(BoxAccessGrantScope, { each: true })
  scopes: BoxAccessGrantScope[]

  @ApiPropertyOptional({
    description: 'Grant lifetime in seconds (default 3600, min 60, max 86400)',
    example: 3600,
    minimum: 60,
    maximum: 60 * 60 * 24,
  })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(60 * 60 * 24)
  expiresInSeconds?: number
}

// Create response only: the plaintext app key is minted once and never
// recoverable afterwards, so this shape must never be reused for list/get.
@ApiSchema({ name: 'BoxAccessGrantCreated' })
export class BoxAccessGrantResponseDto {
  @ApiProperty({
    description: 'Unique identifier for the access grant',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string

  @ApiProperty({
    description: 'ID of the box this grant is scoped to',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  boxId: string

  @ApiProperty({
    description: 'Capability scopes granted',
    enum: BoxAccessGrantScope,
    isArray: true,
  })
  scopes: BoxAccessGrantScope[]

  @ApiProperty({
    description: 'When the grant expires',
    example: '2025-01-01T12:00:00.000Z',
  })
  expiresAt: Date

  @ApiProperty({
    description: 'One-time plaintext app key. Not recoverable after this response; store it now.',
    example: 'bag_svc_1234567890abcdef',
  })
  appKey: string

  static fromGrant(grant: BoxAccessGrant, appKey: string): BoxAccessGrantResponseDto {
    const dto = new BoxAccessGrantResponseDto()
    dto.id = grant.id
    dto.boxId = grant.boxId
    dto.scopes = grant.scopes
    dto.expiresAt = grant.expiresAt
    dto.appKey = appKey
    return dto
  }
}

@ApiSchema({ name: 'BoxAccessGrant' })
export class BoxAccessGrantDto {
  @ApiProperty({
    description: 'Unique identifier for the access grant',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string

  @ApiProperty({
    description: 'ID of the box this grant is scoped to',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  boxId: string

  @ApiProperty({
    description: 'Capability scopes granted',
    enum: BoxAccessGrantScope,
    isArray: true,
  })
  scopes: BoxAccessGrantScope[]

  @ApiProperty({
    description: 'Grant status',
    enum: BoxAccessGrantStatus,
  })
  status: BoxAccessGrantStatus

  @ApiProperty({
    description: 'When the grant expires',
    example: '2025-01-01T12:00:00.000Z',
  })
  expiresAt: Date

  @ApiProperty({
    description: 'ID of the authenticated user that created the grant',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  createdBy: string

  @ApiProperty({
    description: 'When the grant was created',
    example: '2025-01-01T11:00:00.000Z',
  })
  createdAt: Date

  static fromGrant(grant: BoxAccessGrant): BoxAccessGrantDto {
    const dto = new BoxAccessGrantDto()
    dto.id = grant.id
    dto.boxId = grant.boxId
    dto.scopes = grant.scopes
    dto.status = grant.status
    dto.expiresAt = grant.expiresAt
    dto.createdBy = grant.createdBy
    dto.createdAt = grant.createdAt
    return dto
  }
}
