/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsArray, IsNotEmpty, IsString } from 'class-validator'

export class VolumeFileEntryDto {
  @ApiProperty({ description: 'Entry name relative to the listed path' })
  name: string

  @ApiProperty({ description: 'Whether this entry is a "directory" (a common key prefix), not a real object' })
  isDirectory: boolean

  @ApiPropertyOptional({ description: 'Object size in bytes. Absent for directories.' })
  size?: number

  @ApiPropertyOptional({ description: 'Last-modified timestamp (UTC). Absent for directories.' })
  lastModified?: Date
}

export class ListVolumeFilesResponseDto {
  @ApiProperty({ type: [VolumeFileEntryDto] })
  entries: VolumeFileEntryDto[]

  @ApiPropertyOptional({ description: 'Pass back as `cursor` to fetch the next page' })
  nextCursor?: string

  @ApiProperty()
  hasMore: boolean
}

export class VolumeFileStatDto {
  @ApiProperty()
  path: string

  @ApiProperty()
  size: number

  @ApiProperty()
  lastModified: Date
}

export class PresignedUrlResponseDto {
  @ApiProperty({ description: 'Short-lived signed URL. The caller transfers bytes directly against this URL.' })
  url: string

  @ApiProperty()
  expiresAt: Date
}

export class BatchDeleteVolumeFilesDto {
  @ApiProperty({ type: [String], description: 'Object keys to delete, relative to the volume root' })
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  paths: string[]
}

export class BatchOperationErrorDto {
  @ApiProperty()
  path: string

  @ApiProperty()
  message: string
}

export class BatchDeleteVolumeFilesResponseDto {
  @ApiProperty({ type: [String] })
  deleted: string[]

  @ApiProperty({ type: [BatchOperationErrorDto] })
  errors: BatchOperationErrorDto[]
}

export class PresignBatchWriteVolumeFilesDto {
  @ApiProperty({ type: [String], description: 'Object keys to presign for upload, relative to the volume root' })
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  paths: string[]
}

export class PresignedWriteUrlDto extends PresignedUrlResponseDto {
  @ApiProperty()
  path: string
}

export class PresignBatchWriteVolumeFilesResponseDto {
  @ApiProperty({ type: [PresignedWriteUrlDto] })
  urls: PresignedWriteUrlDto[]

  @ApiProperty({ type: [BatchOperationErrorDto] })
  errors: BatchOperationErrorDto[]
}
