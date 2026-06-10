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
    description: 'The internal UUID of the box',
    example: 'fd955d93-e74a-48e7-9f2d-fcbe6dd9e920',
  })
  id: string

  @ApiProperty({
    description: 'The public Box ID shown to users and SDK clients',
    example: 'aB3cD4eF5gH6',
  })
  boxId: string

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
    description: 'The target environment for the box',
    example: 'local',
  })
  target: string

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
    description: 'Auto-stop interval in minutes (0 means disabled)',
    example: 30,
    required: false,
  })
  @IsOptional()
  autoStopInterval?: number

  @ApiPropertyOptional({
    description:
      'Auto-delete interval in minutes (negative value means disabled, 0 means delete immediately upon stopping)',
    example: 30,
    required: false,
  })
  @IsOptional()
  autoDeleteInterval?: number

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
    return {
      id: box.id,
      boxId: box.boxId,
      organizationId: box.organizationId,
      name: box.name,
      target: box.region,
      user: box.osUser,
      env: box.env,
      cpu: box.cpu,
      gpu: box.gpu,
      memory: box.mem,
      disk: box.disk,
      public: box.public,
      networkBlockAll: box.networkBlockAll,
      networkAllowList: box.networkAllowList,
      labels: box.labels,
      volumes: box.volumes,
      state: this.getBoxState(box),
      desiredState: box.desiredState,
      errorReason: box.errorReason,
      recoverable: box.recoverable,
      autoStopInterval: box.autoStopInterval,
      autoDeleteInterval: box.autoDeleteInterval,
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
