/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsNotEmpty, IsString, Matches, ValidateIf } from 'class-validator'

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
 * The Filestore instance's logical name pattern. Must stay in agreement with
 * the runner's registry pattern (`filestoreInstanceNamePattern` in the runner
 * config): the instance name becomes a component of the runner-side mount path
 * (/mnt/boxlite-filestore-<name>), so the same constraints apply — no path
 * separators, no relative components.
 */
export const FILESTORE_INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

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

  /**
   * The Filestore instance this volume's data directory lives on. Presence
   * makes the volume a filestore volume (data on NFS); absence keeps it an
   * object-storage volume (data in `boxlite-volume-<id>`). The name must
   * appear in the API's FILESTORE_INSTANCES configuration, which is checked
   * at create time.
   */
  @ApiPropertyOptional({
    description: 'The Filestore instance the volume stores its data on; filestore volumes only',
    example: 'ml-scratch',
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
