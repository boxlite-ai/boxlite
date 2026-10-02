/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'

/**
 * One typed mount of a create request, between the REST DTO that checked its
 * shape and the box service that resolves it.
 *
 * The service turns each one into a `BoxVolume` once its source is resolved
 * and its paths are validated, so the runner, restarts and the volume in-use
 * check see a mounted volume the same way whichever list it came from.
 */
@ApiSchema({ name: 'BoxMount' })
export class BoxMount {
  @ApiProperty({
    description: 'What `source` names. Only volume mounts reach the API; host binds are local-runtime only.',
    enum: ['volume'],
    example: 'volume',
  })
  type: 'volume'

  @ApiProperty({
    description: 'The id or name of the volume to mount',
    example: 'run42',
  })
  source: string

  @ApiProperty({
    description: 'The mount point inside the box',
    example: '/workspace',
  })
  target: string

  @ApiPropertyOptional({
    description:
      'Optional prefix within the volume to mount instead of the whole volume. When omitted, the entire volume is mounted.',
    example: 'foo/bar',
  })
  subPath?: string

  @ApiPropertyOptional({
    description: 'Mount the volume read-only. Omitted means read-write.',
    example: false,
  })
  readOnly?: boolean
}
