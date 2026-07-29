/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsString, IsNotEmpty } from 'class-validator'

@ApiSchema({ name: 'CreateRegion' })
export class CreateRegionDto {
  @ApiProperty({
    description: 'Region name',
    example: 'us-east-1',
  })
  @IsString()
  @IsNotEmpty()
  name: string

  @ApiProperty({
    description: 'Proxy URL for the region',
    example: 'https://proxy.example.com',
    nullable: true,
    required: false,
  })
  proxyUrl?: string
}

@ApiSchema({ name: 'CreateRegionResponse' })
export class CreateRegionResponseDto {
  @ApiProperty({
    description: 'ID of the created region',
    example: 'region_12345',
  })
  @IsString()
  @IsNotEmpty()
  id: string

  @ApiProperty({
    description: 'Proxy API key for the region',
    example: 'proxy-api-key-xyz',
    nullable: true,
    required: false,
  })
  proxyApiKey?: string

  constructor(params: { id: string; proxyApiKey?: string }) {
    this.id = params.id
    this.proxyApiKey = params.proxyApiKey
  }
}
