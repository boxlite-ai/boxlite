/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'Box' })
export class BoxResponseDto {
  @ApiProperty({
    description: 'The public 12-character Box ID shown to users and SDK clients',
    example: 'aB3cD4eF5gH6',
  })
  box_id: string

  @ApiPropertyOptional({
    description: 'User-provided box name',
    example: 'notebook-worker',
  })
  name?: string

  @ApiProperty({
    description: 'Box runtime status',
    example: 'running',
  })
  status: string

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2026-06-04T12:00:00.000Z',
  })
  created_at: string

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2026-06-04T12:05:00.000Z',
  })
  updated_at: string

  @ApiPropertyOptional({
    description: 'Runtime process ID when available',
    example: 12345,
  })
  pid?: number

  @ApiProperty({
    description: 'Approved image/template used for the box',
    example: 'boxlite/base',
  })
  image: string

  @ApiProperty({
    description: 'Allocated CPU count',
    example: 2,
  })
  cpus: number

  @ApiProperty({
    description: 'Allocated memory in MiB',
    example: 4096,
  })
  memory_mib: number

  @ApiProperty({
    description: 'Labels attached to the box',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'boxlite.io/public': 'true' },
  })
  labels: Record<string, string>
}

@ApiSchema({ name: 'ListBoxesResponse' })
export class ListBoxesResponseDto {
  @ApiProperty({ type: [BoxResponseDto] })
  boxes: BoxResponseDto[]

  @ApiPropertyOptional({
    description: 'Token for the next page when pagination is available',
    example: 'eyJwYWdlIjoyfQ',
  })
  next_page_token?: string
}

class ErrorDetailDto {
  @ApiProperty({
    description: 'Human-readable error message',
    example: 'Box not found',
  })
  message: string

  @ApiProperty({
    description: 'Machine-readable error type',
    example: 'not_found',
  })
  type: string

  @ApiProperty({
    description: 'HTTP status code',
    example: 404,
  })
  code: number
}

@ApiSchema({ name: 'BoxLiteRestError' })
export class ErrorResponseDto {
  @ApiProperty({ type: ErrorDetailDto })
  error: ErrorDetailDto
}
