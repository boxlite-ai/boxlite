/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsString, Length, Matches, Max, Min, NotEquals } from 'class-validator'

export const BOX_ENDPOINT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,46}[a-z0-9]$/

export class BoxEndpointNameDto {
  @ApiProperty({ description: 'Globally unique lowercase DNS label, 3–48 characters', example: 'fleet' })
  @Matches(BOX_ENDPOINT_NAME_PATTERN)
  name: string
}

export class BindBoxEndpointDto {
  @ApiProperty({ example: 'fleet' })
  @IsString()
  @Length(1, 255)
  boxIdOrName: string

  @ApiProperty({ minimum: 1, maximum: 65535, example: 8080 })
  @IsInt()
  @Min(1)
  @Max(65535)
  @NotEquals(22222)
  port: number
}

export class BoxEndpointDto {
  @ApiProperty()
  name: string

  @ApiProperty({ nullable: true })
  boxId: string | null

  @ApiProperty()
  port: number

  @ApiProperty()
  region: string

  @ApiProperty()
  url: string

  @ApiProperty({ description: 'False after revocation; the name remains reserved' })
  enabled: boolean
}
