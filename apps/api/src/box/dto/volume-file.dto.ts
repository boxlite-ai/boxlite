/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator'

/** S3 caps DeleteObjects at 1000 keys per call; mirrored here for presign
 * batches too so one request can't force unbounded signing/S3 work. */
const MAX_BATCH_SIZE = 1000

/**
 * A raw `@Query('path') path: string` accepts whatever Express hands it -
 * including an array, if the caller sends the key twice (`?path=a&path=b`)
 * or with explicit array syntax (`?path[]=a`). `@IsString()` on a DTO bound
 * through the app's global `ValidationPipe` rejects that with 400 before
 * any downstream string method (`.slice`, `.normalize`, ...) runs on a
 * value it wasn't written to expect.
 */
export class ListVolumeFilesQueryDto {
  @ApiPropertyOptional({ description: 'Prefix to list under, relative to the volume root' })
  @IsOptional()
  @IsString()
  path?: string

  @ApiPropertyOptional({ description: 'Pass the previous response\'s nextCursor to fetch the next page' })
  @IsOptional()
  @IsString()
  cursor?: string
}

export class VolumeFilePathQueryDto {
  @ApiProperty({ description: 'Object key, relative to the volume root' })
  @IsString()
  @IsNotEmpty()
  path: string
}

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
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_BATCH_SIZE)
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
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_BATCH_SIZE)
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

export class CopyVolumeFilesDto {
  @ApiPropertyOptional({
    description: 'Volume to copy from. Defaults to the destination volume (a same-volume prefix-to-prefix copy).',
  })
  @IsOptional()
  @IsString()
  sourceVolumeId?: string

  @ApiProperty({ description: 'Prefix to copy from, relative to the source volume root (empty copies everything)' })
  @IsString()
  sourcePrefix: string

  @ApiProperty({ description: 'Prefix to copy into, relative to the destination volume root' })
  @IsString()
  destPrefix: string
}

export class CopyVolumeFilesResponseDto {
  @ApiProperty({ type: [String], description: 'Destination keys that were copied' })
  copied: string[]

  @ApiProperty({ type: [BatchOperationErrorDto] })
  errors: BatchOperationErrorDto[]
}
