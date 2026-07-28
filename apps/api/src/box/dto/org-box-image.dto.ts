/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty } from '@nestjs/swagger'
import { IsString, Matches, MaxLength, MinLength } from 'class-validator'
import { OrgBoxImage } from '../entities/org-box-image.entity'
import { OrgBoxImageStatus } from '../enums/org-box-image-status.enum'

export class CreateOrgBoxImageDto {
  @ApiProperty({
    description: 'Short image selector unique within the organization',
    example: 'hermes',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9._-]*$/)
  name: string

  @ApiProperty({
    description: 'OCI image reference to allow for this organization',
    example: 'sam2026go/hermes-agent:boxlite',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  ref: string
}

export class BoxImageDto {
  @ApiProperty({ example: 'hermes' })
  name: string

  @ApiProperty({ example: 'sam2026go/hermes-agent:boxlite' })
  ref: string

  @ApiProperty({ enum: ['system', 'organization'] })
  source: 'system' | 'organization'

  @ApiProperty({ enum: OrgBoxImageStatus, required: false })
  status?: OrgBoxImageStatus

  static fromOrgImage(image: OrgBoxImage): BoxImageDto {
    return {
      name: image.name,
      ref: image.ref,
      source: 'organization',
      status: image.status,
    }
  }
}
