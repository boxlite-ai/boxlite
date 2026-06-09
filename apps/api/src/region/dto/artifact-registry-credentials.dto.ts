/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiSchema, ApiProperty } from '@nestjs/swagger'
import { IsString, IsNotEmpty } from 'class-validator'

@ApiSchema({ name: 'ArtifactRegistryCredentials' })
export class ArtifactRegistryCredentialsDto {
  @ApiProperty({
    description: 'Artifact Registry username for the region',
    example: 'boxlite',
  })
  @IsString()
  @IsNotEmpty()
  username: string

  @ApiProperty({
    description: 'Artifact Registry password for the region',
  })
  @IsString()
  @IsNotEmpty()
  password: string

  constructor(params: { username: string; password: string }) {
    this.username = params.username
    this.password = params.password
  }
}
