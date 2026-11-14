/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsEnum, IsNotEmpty, IsString, Matches, ValidateIf } from 'class-validator'
import { FILESTORE_INSTANCE_NAME_PATTERN } from '../../config/filestore-instances'

/**
 * A volume can be mounted by name in place of its id, so a name has to be
 * expressible as a `-v` source. Two separate constraints, both enforced by the
 * pattern below:
 *
 * - A name starting with `.`, `/` or `~` is classified as a *host path* by the
 *   CLI, which looks at the first character only (Docker's rule), so it would
 *   never reach the volume backend.
 * - A name containing `:` would be split as a field separator, and one
 *   containing `/` is not a path to the classifier but is still unusable -
 *   both make the spec mean something other than what was written.
 *
 * The pattern is Docker's own (`RestrictedNameChars` in moby), including its
 * two-character minimum: a single character cannot be told apart from a Windows
 * drive letter by any `-v` parser, Docker's included.
 */
export const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/

/**
 * The Filestore instance's logical name pattern. Shared with the API's
 * FILESTORE_INSTANCES configuration parser (FILESTORE_INSTANCE_NAME_PATTERN in
 * config/filestore-instances.ts), which validates the same names at startup:
 * the instance name becomes a component of the runner-side mount path
 * (/mnt/boxlite-filestore-<name>), so the constraints are — no path
 * separators, no relative components.
 */
export const FILESTORE_INSTANCE_PATTERN = FILESTORE_INSTANCE_NAME_PATTERN

export const VOLUME_STORAGE_BACKENDS = ['object_storage', 'filestore'] as const

export type VolumeStorageBackend = (typeof VOLUME_STORAGE_BACKENDS)[number]

@ApiSchema({ name: 'CreateVolume' })
export class CreateVolumeDto {
  @ApiProperty({ required: false, example: 'my-data' })
  // ValidateIf, not IsOptional: IsOptional also waves through an explicit
  // `null`, which would reach VolumeService.create as a non-undefined value.
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(VOLUME_NAME_PATTERN, {
    message:
      'volume name must be at least two characters of [a-zA-Z0-9][a-zA-Z0-9_.-]. ' +
      'If you intended to pass a host directory, use an absolute path.',
  })
  name?: string

  @ApiPropertyOptional({
    description: 'The storage backend that owns the volume; defaults to object_storage',
    enum: VOLUME_STORAGE_BACKENDS,
    example: 'filestore',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(VOLUME_STORAGE_BACKENDS)
  storageBackend?: VolumeStorageBackend

  /**
   * The Filestore instance this volume's data directory lives on. It is
   * accepted only with `storageBackend: "filestore"`; if omitted, Filestore
   * placement is assigned from the configured instances.
   */
  @ApiPropertyOptional({
    description:
      'The Filestore instance the volume stores its data on; filestore volumes only. Omit to assign from configured instances.',
    example: 'boxlite-dev-shared',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @Matches(FILESTORE_INSTANCE_PATTERN, {
    message:
      'instance must be the logical name of a Filestore instance: 1-63 characters of ' +
      '[a-z0-9] and -, starting alphanumeric. It must match an instance entry in the ' +
      "API's FILESTORE_INSTANCES configuration.",
  })
  instance?: string
}
