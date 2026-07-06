/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsNumber, IsString } from 'class-validator'

@ApiSchema({ name: 'PortPreviewUrl' })
export class PortPreviewUrlDto {
  @ApiProperty({
    description: 'ID of the box',
    example: '123456',
  })
  @IsString()
  boxId: string

  @ApiProperty({
    description: 'Preview url',
    example: 'https://{port}-{boxId}.{proxyDomain}',
  })
  @IsString()
  url: string

  @ApiProperty({
    description: 'Access token',
    example: 'ul67qtv-jl6wb9z5o3eii-ljqt9qed6l',
  })
  @IsString()
  token: string
}

@ApiSchema({ name: 'SignedPortPreviewUrl' })
export class SignedPortPreviewUrlDto {
  @ApiProperty({
    description: 'ID of the box',
    example: '123456',
  })
  @IsString()
  boxId: string

  @ApiProperty({
    description: 'Port number of the signed preview URL',
    example: 3000,
    type: 'integer',
  })
  @IsNumber()
  port: number

  @ApiProperty({
    description: 'Token of the signed preview URL',
    example: 'jl6wb9z5o3eii',
  })
  @IsString()
  token: string

  @ApiProperty({
    description: 'Signed preview url',
    example: 'https://{port}-{token}.{proxyDomain}',
  })
  @IsString()
  url: string
}

@ApiSchema({ name: 'TerminalPreviewUrl' })
export class TerminalPreviewUrlDto {
  @ApiProperty({
    description: 'ID of the box',
    example: '123456',
  })
  @IsString()
  boxId: string

  @ApiProperty({
    description: 'Terminal preview url',
    example: 'https://terminal-{boxId}.{proxyDomain}',
  })
  @IsString()
  url: string

  @ApiProperty({
    description: 'Access token',
    example: 'ul67qtv-jl6wb9z5o3eii-ljqt9qed6l',
  })
  @IsString()
  token: string
}

@ApiSchema({ name: 'SignedTerminalPreviewUrl' })
export class SignedTerminalPreviewUrlDto {
  @ApiProperty({
    description: 'ID of the box',
    example: '123456',
  })
  @IsString()
  boxId: string

  @ApiProperty({
    description: 'Token of the signed terminal preview URL',
    example: 'jl6wb9z5o3eii',
  })
  @IsString()
  token: string

  @ApiProperty({
    description: 'Signed terminal preview url',
    example: 'https://terminal-{token}.{proxyDomain}',
  })
  @IsString()
  url: string
}
