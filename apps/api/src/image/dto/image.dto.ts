/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsUUID, Matches } from 'class-validator'
import { TAG_PATTERN } from '../utils/image-ref.util'

/** How many tag events an image's detail carries: enough to read recent registrations, bounded however long it lives. */
export const IMAGE_HISTORY_LIMIT = 100

@ApiSchema({ name: 'ImageVersion' })
export class ImageVersionDto {
  @ApiProperty({ description: 'Version ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string

  @ApiProperty({
    description: 'OCI manifest digest this version was pulled at',
    example: 'sha256:4a1c2f...',
  })
  digest: string

  @ApiProperty({
    description: 'Sum of the layer sizes the manifest declared, in bytes',
    example: 26214400,
  })
  sizeBytes: number

  @ApiProperty({
    description: 'The reference the caller asked for, kept verbatim as provenance',
    example: 'quay.io/acme/app:v1',
  })
  sourceRef: string

  @ApiProperty({
    description: 'Aliases that point at this version now, so a reference with one of them boots it',
    example: ['stable'],
    type: [String],
  })
  aliases: string[]

  @ApiProperty({
    description: 'When a box last started from this version. Null when none has since this was recorded',
    example: '2026-01-01T00:00:00.000Z',
    nullable: true,
  })
  lastUsedAt: string | null

  @ApiProperty({
    description:
      'When a pull of this version first failed because its registry no longer has it. Runners that cached it still start it; elsewhere, create a new alias for a version the registry still has. Null while no pull has found it gone',
    example: '2026-01-02T00:00:00.000Z',
    nullable: true,
  })
  upstreamMissingAt: string | null

  @ApiProperty({ description: 'When this version was first recorded', example: '2026-01-01T00:00:00.000Z' })
  createdAt: string
}

@ApiSchema({ name: 'ImageAliasEvent' })
export class ImageAliasEventDto {
  @ApiProperty({ description: 'The alias that moved', example: 'stable' })
  aliasName: string

  @ApiProperty({
    description: 'Version the alias pointed at before. Null when the alias did not exist yet',
    example: '123e4567-e89b-12d3-a456-426614174000',
    nullable: true,
  })
  fromVersionId: string | null

  @ApiProperty({
    description: 'Previous digest in historical records. Null for alias creation',
    example: 'sha256:a3ed95caeb02ffe68cdd9fd84406680ae93d633cb16422d00e8a7c22955b46d4',
    nullable: true,
  })
  fromDigest: string | null

  @ApiProperty({
    description: 'Version selected by the alias',
    example: '123e4567-e89b-12d3-a456-426614174001',
  })
  toVersionId: string

  @ApiProperty({
    description: 'Digest selected by the alias',
    example: 'sha256:b5ed95caeb02ffe68cdd9fd84406680ae93d633cb16422d00e8a7c22955b46d4',
  })
  toDigest: string

  @ApiProperty({
    description: 'Who created the alias. Null when a registry pull seeded it',
    example: 'auth0|6512bd43d9caa6e02c990b0a',
    nullable: true,
  })
  actorId: string | null

  @ApiProperty({ description: 'When the alias was recorded', example: '2026-01-01T00:00:00.000Z' })
  createdAt: string
}

@ApiSchema({ name: 'CreateImageAlias' })
export class CreateImageAliasDto {
  @ApiProperty({ description: 'New catalog alias; existing aliases are refused', example: 'stable' })
  @Matches(TAG_PATTERN)
  alias: string

  @ApiProperty({
    description: 'Version to point the tag at. It must be a ready version of this image',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  versionId: string
}

@ApiSchema({ name: 'Image' })
export class ImageDto {
  @ApiProperty({
    description:
      'What to pass as a box image to boot from this: the curated short name, or the upstream repository path',
    example: 'quay.io/acme/app',
  })
  name: string

  @ApiProperty({
    description: 'Catalog row ID. Null for curated images, which are operator configuration rather than rows',
    example: '123e4567-e89b-12d3-a456-426614174000',
    nullable: true,
  })
  id: string | null

  @ApiProperty({
    description:
      'Whether this is one of the operator-provided images every organization shares. Curated images cannot be deleted and do not count against the organization limit',
    example: false,
  })
  curated: boolean

  @ApiProperty({
    description:
      'The exact reference a curated image resolves to. Null for catalog images, which resolve through their versions',
    example: null,
    nullable: true,
  })
  curatedRef: string | null

  @ApiProperty({
    description: 'Aliases recorded for this image. Empty for curated images, whose reference the operator pins',
    example: ['v1', 'latest'],
    type: [String],
  })
  aliases: string[]

  @ApiProperty({
    description: 'How many pulled manifest digests this image holds',
    example: 2,
  })
  versionCount: number

  @ApiProperty({
    description:
      'Sum of the pulled versions’ declared sizes, in bytes. Layers shared between versions are counted once per version. Null for curated images, whose bytes this system never measured',
    example: 26214400,
    nullable: true,
  })
  sizeBytes: number | null

  @ApiProperty({
    description: 'When a box last booted from this image',
    example: '2026-01-01T00:00:00.000Z',
    nullable: true,
  })
  lastUsedAt: string | null

  @ApiProperty({
    description: 'When this image first entered the catalog. Null for curated images',
    example: '2026-01-01T00:00:00.000Z',
    nullable: true,
  })
  createdAt: string | null
}

@ApiSchema({ name: 'ImageDetail' })
export class ImageDetailDto extends ImageDto {
  @ApiProperty({
    description: 'Every pulled version, newest first',
    type: [ImageVersionDto],
  })
  versions: ImageVersionDto[]

  @ApiProperty({
    description: `Alias registration history, newest first and at most ${IMAGE_HISTORY_LIMIT} events. Empty for curated images`,
    type: [ImageAliasEventDto],
  })
  history: ImageAliasEventDto[]
}

@ApiSchema({ name: 'ImageUsage' })
export class ImageUsageDto {
  @ApiProperty({
    description: 'Images this organization holds. Curated images are the operator’s and are not counted',
    example: 3,
  })
  count: number

  @ApiProperty({ description: 'How many images this organization may hold', example: 20 })
  limit: number

  @ApiProperty({
    description:
      'Sum of the declared sizes of every pulled version, in bytes. A lower bound on what is stored: it counts what the manifests said, and counts a layer once per version that references it',
    example: 78643200,
  })
  knownBytes: number
}
