/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsString, Length, Matches } from 'class-validator'

/**
 * A snapshot name travels in URL paths and names the snapshot across the whole
 * organization, so it is held to a path-safe alphabet rather than to the local
 * runtime's looser file-name rules.
 */
export class CreateSnapshotDto {
  @IsString()
  @Length(1, 128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message: 'name must start with a letter or digit and use only letters, digits, ".", "_" and "-"',
  })
  name: string
}
