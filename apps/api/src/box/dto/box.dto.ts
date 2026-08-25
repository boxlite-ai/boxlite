/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { BoxState } from '../enums/box-state.enum'
import { IsEnum, IsOptional } from 'class-validator'
import { Box } from '../entities/box.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxClass } from '../enums/box-class.enum'
import { resolveBoxAdvancedOptions } from '../utils/advanced-options.util'

export interface BoxCapabilities {
  add: string[]
  drop: string[]
}

// A plain `interface` has no runtime representation for Nest's Swagger
// plugin to introspect, so `@ApiProperty({ type: BoxCapabilities })` below
// would fall back to an untyped object in the generated spec (and, from
// there, an untyped map/object in every generated client). This decorated
// class gives it one, the same way BoxVolume does for `volumes`.
@ApiSchema({ name: 'BoxCapabilities' })
export class BoxCapabilitiesDto implements BoxCapabilities {
  @ApiProperty({
    description: 'Linux capabilities added to the default container capability set',
    type: [String],
    example: ['SYS_ADMIN'],
  })
  add: string[]

  @ApiProperty({
    description: 'Linux capabilities removed from the container capability set',
    type: [String],
    example: [],
  })
  drop: string[]
}

@ApiSchema({ name: 'BoxVolume' })
export class BoxVolume {
  @ApiProperty({
    description: 'The ID of the volume',
    example: 'volume123',
  })
  volumeId: string

  @ApiProperty({
    description: 'The mount path for the volume',
    example: '/data',
  })
  mountPath: string

  @ApiPropertyOptional({
    description:
      'Optional subpath within the volume to mount. When specified, only this S3 prefix will be accessible. When omitted, the entire volume is mounted.',
    example: 'users/alice',
  })
  subpath?: string
}

@ApiSchema({ name: 'Box' })
export class BoxDto {
  @ApiProperty({
    description: 'The public 12-character Box ID',
    example: 'aB3cD4eF5gH6',
  })
  id: string

  @ApiProperty({
    description: 'The organization ID of the box',
    example: 'organization123',
  })
  organizationId: string

  @ApiProperty({
    description: 'The name of the box',
    example: 'MyBox',
  })
  name: string

  @ApiProperty({
    description: 'The user associated with the project',
    example: 'boxlite',
  })
  user: string

  @ApiProperty({
    description: 'Environment variables for the box',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { NODE_ENV: 'production' },
  })
  env: Record<string, string>

  @ApiProperty({
    description: 'Labels for the box',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'boxlite.io/public': 'true' },
  })
  labels: { [key: string]: string }

  @ApiProperty({
    description: 'Whether the box http preview is public',
    example: false,
  })
  public: boolean

  @ApiProperty({
    description: 'Whether to block all network access for the box',
    example: false,
  })
  networkBlockAll: boolean

  @ApiPropertyOptional({
    description: 'Comma-separated list of allowed CIDR network addresses for the box',
    example: '192.168.1.0/16,10.0.0.0/24',
  })
  networkAllowList?: string

  @ApiProperty({
    description: 'Whether Docker-style privileged mode is enabled for the box',
    example: false,
  })
  privileged: boolean

  @ApiProperty({
    description: 'Linux capabilities added to or removed from the box processes',
    type: BoxCapabilitiesDto,
  })
  capabilities: BoxCapabilities

  @ApiProperty({
    description: 'The target environment for the box',
    example: 'local',
  })
  target: string

  @ApiPropertyOptional({
    description: 'The image used for the box',
    example: 'boxlite/base',
    required: false,
  })
  @IsOptional()
  image?: string

  @ApiProperty({
    description: 'The CPU quota for the box',
    example: 2,
  })
  cpu: number

  @ApiProperty({
    description: 'The GPU quota for the box',
    example: 0,
  })
  gpu: number

  @ApiProperty({
    description: 'The memory quota for the box',
    example: 4,
  })
  memory: number

  @ApiProperty({
    description: 'The disk quota for the box',
    example: 10,
  })
  disk: number

  @ApiPropertyOptional({
    description: 'The state of the box',
    enum: BoxState,
    enumName: 'BoxState',
    example: Object.values(BoxState)[0],
    required: false,
  })
  @IsEnum(BoxState)
  @IsOptional()
  state?: BoxState

  @ApiPropertyOptional({
    description: 'The desired state of the box',
    enum: BoxDesiredState,
    enumName: 'BoxDesiredState',
    example: Object.values(BoxDesiredState)[0],
    required: false,
  })
  @IsEnum(BoxDesiredState)
  @IsOptional()
  desiredState?: BoxDesiredState

  @ApiPropertyOptional({
    description: 'The error reason of the box',
    example: 'The box is not running',
    required: false,
  })
  @IsOptional()
  errorReason?: string

  @ApiPropertyOptional({
    description: 'Whether the box error is recoverable.',
    example: true,
    required: false,
  })
  @IsOptional()
  recoverable?: boolean

  @ApiPropertyOptional({
    description: 'Auto-stop interval in seconds (0 means disabled)',
    example: 900,
    type: 'integer',
    required: false,
  })
  @IsOptional()
  autoStop?: number

  @ApiPropertyOptional({
    description: 'Auto-delete interval in seconds (0 means disabled)',
    example: 604800,
    type: 'integer',
    required: false,
  })
  @IsOptional()
  autoDelete?: number

  @ApiPropertyOptional({
    description: 'Whether the box should be automatically resumed on proxy access',
    example: true,
    required: false,
  })
  @IsOptional()
  autoResume?: boolean

  @ApiPropertyOptional({
    description: 'Array of volumes attached to the box',
    type: [BoxVolume],
    required: false,
  })
  @IsOptional()
  volumes?: BoxVolume[]

  @ApiPropertyOptional({
    description: 'The creation timestamp of the box',
    example: '2024-10-01T12:00:00Z',
    required: false,
  })
  @IsOptional()
  createdAt?: string

  @ApiPropertyOptional({
    description: 'The last update timestamp of the box',
    example: '2024-10-01T12:00:00Z',
    required: false,
  })
  @IsOptional()
  updatedAt?: string

  @ApiPropertyOptional({
    description: 'The class of the box',
    enum: BoxClass,
    example: Object.values(BoxClass)[0],
    required: false,
    deprecated: true,
  })
  @IsEnum(BoxClass)
  @IsOptional()
  class?: BoxClass

  @ApiPropertyOptional({
    description: 'The version of the daemon running in the box',
    example: '1.0.0',
    required: false,
  })
  @IsOptional()
  daemonVersion?: string

  @ApiPropertyOptional({
    description: 'The runner ID of the box',
    example: 'runner123',
    required: false,
  })
  @IsOptional()
  runnerId?: string

  @ApiProperty({
    description: 'The toolbox proxy URL for the box',
    example: 'https://proxy.app.boxlite.io/toolbox',
  })
  toolboxProxyUrl: string

  static fromBox(box: Box, toolboxProxyUrl: string): BoxDto {
    // A stored row is not a request: it already holds the canonical shape, so
    // resolve it instead of re-running the request-time conflict rule.
    const advanced = resolveBoxAdvancedOptions({
      privileged: box.privileged,
      capabilities: box.capabilities,
    })

    return {
      id: box.id,
      organizationId: box.organizationId,
      name: box.name,
      target: box.region,
      image: box.image,
      user: box.osUser,
      env: box.env,
      cpu: box.cpu,
      gpu: box.gpu,
      memory: box.mem,
      disk: box.disk,
      public: box.public,
      networkBlockAll: box.networkBlockAll,
      networkAllowList: box.networkAllowList,
      privileged: advanced.privileged,
      capabilities: advanced.capabilities,
      labels: box.labels,
      volumes: box.volumes,
      state: this.getBoxState(box),
      desiredState: box.desiredState,
      errorReason: box.errorReason,
      recoverable: box.recoverable,
      autoStop: box.autoStop,
      autoDelete: box.autoDelete,
      autoResume: box.autoResume,
      class: box.class,
      createdAt: box.createdAt ? new Date(box.createdAt).toISOString() : undefined,
      updatedAt: box.updatedAt ? new Date(box.updatedAt).toISOString() : undefined,
      daemonVersion: box.daemonVersion,
      runnerId: box.runnerId,
      toolboxProxyUrl,
    }
  }

  private static getBoxState(box: Box): BoxState {
    switch (box.state) {
      case BoxState.STARTED:
        if (box.desiredState === BoxDesiredState.STOPPED) {
          return BoxState.STOPPING
        }
        if (box.desiredState === BoxDesiredState.DESTROYED) {
          return BoxState.DESTROYING
        }
        break
      case BoxState.STOPPED:
        if (box.desiredState === BoxDesiredState.STARTED) {
          return BoxState.STARTING
        }
        if (box.desiredState === BoxDesiredState.DESTROYED) {
          return BoxState.DESTROYING
        }
        break
      case BoxState.UNKNOWN:
        if (box.desiredState === BoxDesiredState.STARTED) {
          return BoxState.CREATING
        }
        break
    }
    return box.state
  }
}

@ApiSchema({ name: 'BoxLabels' })
export class BoxLabelsDto {
  @ApiProperty({
    description: 'Key-value pairs of labels',
    example: { environment: 'dev', team: 'backend' },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  labels: { [key: string]: string }
}
