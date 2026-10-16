/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { BoxState } from '../enums/box-state.enum'
import { IsEnum, IsOptional } from 'class-validator'
import { IMAGE_PREPARATION_RETRY_AFTER_MS } from '../constants/box-progress.constant'
import { Box } from '../entities/box.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxClass } from '../enums/box-class.enum'
import { BoxProgressPhase } from '../enums/box-progress-phase.enum'
import { reportedBoxState } from '../utils/box-state.util'
import { upstreamRefOf } from '../../image/utils/image-ref.util'

@ApiSchema({ name: 'BoxProgress' })
export class BoxProgressDto {
  @ApiProperty({
    description: 'What this box is waiting on while it is being created',
    enum: BoxProgressPhase,
    enumName: 'BoxProgressPhase',
    example: BoxProgressPhase.PREPARING_IMAGE,
  })
  @IsEnum(BoxProgressPhase)
  phase: BoxProgressPhase

  @ApiProperty({
    description: 'Suggested wait before asking about this box again, in milliseconds. A hint, not a deadline',
    example: IMAGE_PREPARATION_RETRY_AFTER_MS,
  })
  retryAfterMs: number
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

@ApiSchema({ name: 'BoxSecret' })
export class BoxSecret {
  @ApiProperty({
    description: 'Human-readable secret name',
    example: 'openai',
  })
  name: string

  @ApiProperty({
    description: 'Real secret value. Never enters the guest VM.',
    example: 'sk-...',
  })
  value: string

  @ApiPropertyOptional({
    description: 'Matching hosts for this secret. Empty means no host restriction.',
    example: ['api.openai.com'],
    isArray: true,
    type: String,
  })
  hosts?: string[]

  @ApiPropertyOptional({
    description: 'Placeholder visible inside the guest. Defaults to `<BOXLITE_SECRET:{name}>` when omitted.',
    example: '<BOXLITE_SECRET:openai>',
  })
  placeholder?: string
}

/** What a conversion reads from outside the box row. See {@link BoxDto.fromBox}. */
export type BoxDtoReads = {
  lastActivityAt?: Date | null
  exitCode?: number
  preparingImage?: boolean
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
    description:
      'The timestamp of the last recorded activity on the box, absent when no activity has been recorded yet',
    example: '2024-10-01T12:00:00Z',
    required: false,
  })
  @IsOptional()
  lastActivityAt?: string

  @ApiPropertyOptional({
    description:
      "How the box's main command ended, present once the box has stopped and the runtime " +
      'recorded it: its own code when it exited, or `128 + n` when a signal ended it. Stopping ' +
      'a box signals that command, so a stop is recorded here too. `0` is a real value, so a ' +
      'client must tell the missing field from a zero one. Only reading a single box carries ' +
      'it: this schema is shared with the box list and with the ' +
      'replies that change a box, which leave it out whether or not one was recorded.',
    example: 137,
    type: 'integer',
    required: false,
  })
  @IsOptional()
  exitCode?: number

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

  @ApiPropertyOptional({
    description:
      'What a box still being created is waiting on. Absent once it has started, and absent while it is being created from an image that has already been pulled',
    type: BoxProgressDto,
    required: false,
  })
  @IsOptional()
  progress?: BoxProgressDto

  // `lastActivityAt` is passed in rather than read off the entity: the freshest
  // value lives in the activity service's Redis buffer, and the entity's
  // same-named relation is a `BoxLastActivity` row that read paths do not join.
  // It is reported raw, without the auto-stop sweeper's fallback to
  // `updatedAt` — that fallback is a stop policy, not recorded activity.
  // `exitCode` arrives the same way for the same reason: the control plane
  // does not store it. It is read from the runner that owns the box, and an
  // unreadable one degrades to absent.
  //
  // `preparingImage` too: answering it needs the organization's catalog, which
  // is a query, and a DTO mapper is not where a query belongs. The caller
  // decides whether it is worth asking — for a box that has already started it
  // is not.
  //
  // The three arrive as one object because each is optional: as trailing
  // positional arguments, a caller wanting only the last spells the others as
  // `undefined`, and two of them are one slip from trading places.
  static fromBox(box: Box, toolboxProxyUrl: string, reads: BoxDtoReads = {}): BoxDto {
    const { lastActivityAt, exitCode, preparingImage = false } = reads
    // Read once: the state this payload reports and the state the progress
    // field is gated on are the same claim, and deriving it twice is what
    // would let them drift.
    const state = reportedBoxState(box)

    return {
      id: box.id,
      organizationId: box.organizationId,
      name: box.name,
      target: box.region,
      // The upstream ref the tenant asked for, not the registry proxy ref its
      // runner pulls: a caller that creates a box from what it read back has
      // to be handed something admission accepts.
      image: box.image && upstreamRefOf(box.image),
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
      state,
      desiredState: box.desiredState,
      errorReason: box.errorReason,
      recoverable: box.recoverable,
      // Absent, never null: the runner read yields a number or nothing, and
      // that is what the generated clients type against. `0` is a real exit
      // code, so this passes the value through rather than testing it.
      exitCode,
      autoStop: box.autoStop,
      autoDelete: box.autoDelete,
      autoResume: box.autoResume,
      class: box.class,
      createdAt: box.createdAt ? new Date(box.createdAt).toISOString() : undefined,
      updatedAt: box.updatedAt ? new Date(box.updatedAt).toISOString() : undefined,
      lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : undefined,
      daemonVersion: box.daemonVersion,
      runnerId: box.runnerId,
      toolboxProxyUrl,
      // Only while the box reads as being created. A started box is not
      // waiting on anything, so reporting what it once waited on would be a
      // field that never clears.
      ...(preparingImage && state === BoxState.CREATING
        ? {
            progress: {
              phase: BoxProgressPhase.PREPARING_IMAGE,
              retryAfterMs: IMAGE_PREPARATION_RETRY_AFTER_MS,
            },
          }
        : {}),
    }
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
