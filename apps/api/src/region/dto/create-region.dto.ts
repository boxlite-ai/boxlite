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

  @ApiProperty({
    description: 'SSH Gateway URL for the region',
    example: 'ssh://ssh-gateway.example.com',
    nullable: true,
    required: false,
  })
  sshGatewayUrl?: string

  @ApiProperty({
    description: 'Artifact Registry URL for the region',
    example: 'https://artifact-registry.example.com',
    nullable: true,
    required: false,
  })
  artifactRegistryUrl?: string
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

  @ApiProperty({
    description: 'SSH Gateway API key for the region',
    example: 'ssh-gateway-api-key-abc',
    nullable: true,
    required: false,
  })
  sshGatewayApiKey?: string

  @ApiProperty({
    description: 'Artifact Registry username for the region',
    example: 'boxlite',
    nullable: true,
    required: false,
  })
  artifactRegistryUsername?: string

  @ApiProperty({
    description: 'Artifact Registry password for the region',
    nullable: true,
    required: false,
  })
  artifactRegistryPassword?: string

  constructor(params: {
    id: string
    proxyApiKey?: string
    sshGatewayApiKey?: string
    artifactRegistryUsername?: string
    artifactRegistryPassword?: string
  }) {
    this.id = params.id
    this.proxyApiKey = params.proxyApiKey
    this.sshGatewayApiKey = params.sshGatewayApiKey
    this.artifactRegistryUsername = params.artifactRegistryUsername
    this.artifactRegistryPassword = params.artifactRegistryPassword
  }
}
