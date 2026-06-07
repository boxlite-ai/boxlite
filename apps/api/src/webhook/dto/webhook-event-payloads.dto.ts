/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { WebhookEvent } from '../constants/webhook-events.constants'
import { SandboxState } from '../../sandbox/enums/sandbox-state.enum'
import { SandboxClass } from '../../sandbox/enums/sandbox-class.enum'
import { SavedImageState } from '../../sandbox/enums/saved-image-state.enum'
import { VolumeState } from '../../sandbox/enums/volume-state.enum'
import { SandboxCreatedEvent } from '../../sandbox/events/sandbox-create.event'
import { SandboxStateUpdatedEvent } from '../../sandbox/events/sandbox-state-updated.event'
import { SavedImageCreatedEvent } from '../../sandbox/events/saved-image-created.event'
import { SavedImageStateUpdatedEvent } from '../../sandbox/events/saved-image-state-updated.event'
import { SavedImageRemovedEvent } from '../../sandbox/events/saved-image-removed.event'
import { VolumeCreatedEvent } from '../../sandbox/events/volume-created.event'
import { VolumeStateUpdatedEvent } from '../../sandbox/events/volume-state-updated.event'

export abstract class BaseWebhookEventDto {
  @ApiProperty({
    description: 'Event type identifier',
    enum: WebhookEvent,
    enumName: 'WebhookEvent',
    example: 'sandbox.created',
  })
  event: string

  @ApiProperty({
    description: 'Timestamp when the event occurred',
    example: '2025-12-19T10:30:00.000Z',
    format: 'date-time',
  })
  timestamp: string
}

@ApiSchema({ name: 'SandboxCreatedWebhook' })
export class SandboxCreatedWebhookDto extends BaseWebhookEventDto {
  @ApiProperty({
    description: 'Sandbox ID',
    example: 'sandbox123',
  })
  id: string

  @ApiProperty({
    description: 'Organization ID',
    example: 'org123',
  })
  organizationId: string

  @ApiProperty({
    description: 'Sandbox state',
    enum: SandboxState,
    enumName: 'SandboxState',
  })
  state: SandboxState

  @ApiProperty({
    description: 'Sandbox class',
    enum: SandboxClass,
    enumName: 'SandboxClass',
  })
  class: SandboxClass

  @ApiProperty({
    description: 'When the sandbox was created',
    example: '2025-12-19T10:30:00.000Z',
    format: 'date-time',
  })
  createdAt: string

  static fromEvent(event: SandboxCreatedEvent, eventType: string): SandboxCreatedWebhookDto {
    return {
      event: eventType,
      timestamp: new Date().toISOString(),
      id: event.sandbox.id,
      organizationId: event.sandbox.organizationId,
      state: event.sandbox.state,
      class: event.sandbox.class,
      createdAt: event.sandbox.createdAt.toISOString(),
    }
  }
}

@ApiSchema({ name: 'SandboxStateUpdatedWebhook' })
export class SandboxStateUpdatedWebhookDto extends BaseWebhookEventDto {
  @ApiProperty({
    description: 'Sandbox ID',
    example: 'sandbox123',
  })
  id: string

  @ApiProperty({
    description: 'Organization ID',
    example: 'org123',
  })
  organizationId: string

  @ApiProperty({
    description: 'Previous state',
    enum: SandboxState,
    enumName: 'SandboxState',
  })
  oldState: SandboxState

  @ApiProperty({
    description: 'New state',
    enum: SandboxState,
    enumName: 'SandboxState',
  })
  newState: SandboxState

  @ApiProperty({
    description: 'When the sandbox was last updated',
    example: '2025-12-19T10:30:00.000Z',
    format: 'date-time',
  })
  updatedAt: string

  static fromEvent(event: SandboxStateUpdatedEvent, eventType: string): SandboxStateUpdatedWebhookDto {
    return {
      event: eventType,
      timestamp: new Date().toISOString(),
      id: event.sandbox.id,
      organizationId: event.sandbox.organizationId,
      oldState: event.oldState,
      newState: event.newState,
      updatedAt: event.sandbox.updatedAt.toISOString(),
    }
  }
}

@ApiSchema({ name: 'SavedImageCreatedWebhook' })
export class SavedImageCreatedWebhookDto extends BaseWebhookEventDto {
  @ApiProperty({
    description: 'SavedImage ID',
    example: 'savedImage123',
  })
  id: string

  @ApiProperty({
    description: 'SavedImage name',
    example: 'my-savedImage',
  })
  name: string

  @ApiProperty({
    description: 'Organization ID',
    example: 'org123',
  })
  organizationId: string

  @ApiProperty({
    description: 'SavedImage state',
    enum: SavedImageState,
    enumName: 'SavedImageState',
  })
  state: SavedImageState

  @ApiProperty({
    description: 'When the savedImage was created',
    example: '2025-12-19T10:30:00.000Z',
    format: 'date-time',
  })
  createdAt: string

  static fromEvent(event: SavedImageCreatedEvent, eventType: string): SavedImageCreatedWebhookDto {
    return {
      event: eventType,
      timestamp: new Date().toISOString(),
      id: event.savedImage.id,
      name: event.savedImage.name,
      organizationId: event.savedImage.organizationId,
      state: event.savedImage.state,
      createdAt: event.savedImage.createdAt.toISOString(),
    }
  }
}

@ApiSchema({ name: 'SavedImageStateUpdatedWebhook' })
export class SavedImageStateUpdatedWebhookDto extends BaseWebhookEventDto {
  @ApiProperty({
    description: 'SavedImage ID',
    example: 'savedImage123',
  })
  id: string

  @ApiProperty({
    description: 'SavedImage name',
    example: 'my-savedImage',
  })
  name: string

  @ApiProperty({
    description: 'Organization ID',
    example: 'org123',
  })
  organizationId: string

  @ApiProperty({
    description: 'Previous state',
    enum: SavedImageState,
    enumName: 'SavedImageState',
  })
  oldState: SavedImageState

  @ApiProperty({
    description: 'New state',
    enum: SavedImageState,
    enumName: 'SavedImageState',
  })
  newState: SavedImageState

  @ApiProperty({
    description: 'When the savedImage was last updated',
    example: '2025-12-19T10:30:00.000Z',
    format: 'date-time',
  })
  updatedAt: string

  static fromEvent(event: SavedImageStateUpdatedEvent, eventType: string): SavedImageStateUpdatedWebhookDto {
    return {
      event: eventType,
      timestamp: new Date().toISOString(),
      id: event.savedImage.id,
      name: event.savedImage.name,
      organizationId: event.savedImage.organizationId,
      oldState: event.oldState,
      newState: event.newState,
      updatedAt: event.savedImage.updatedAt.toISOString(),
    }
  }
}

@ApiSchema({ name: 'SavedImageRemovedWebhook' })
export class SavedImageRemovedWebhookDto extends BaseWebhookEventDto {
  @ApiProperty({
    description: 'SavedImage ID',
    example: 'savedImage123',
  })
  id: string

  @ApiProperty({
    description: 'SavedImage name',
    example: 'my-savedImage',
  })
  name: string

  @ApiProperty({
    description: 'Organization ID',
    example: 'org123',
  })
  organizationId: string

  @ApiProperty({
    description: 'When the savedImage was removed',
    example: '2025-12-19T10:30:00.000Z',
    format: 'date-time',
  })
  removedAt: string

  static fromEvent(event: SavedImageRemovedEvent, eventType: string): SavedImageRemovedWebhookDto {
    return {
      event: eventType,
      timestamp: new Date().toISOString(),
      id: event.savedImage.id,
      name: event.savedImage.name,
      organizationId: event.savedImage.organizationId,
      removedAt: new Date().toISOString(),
    }
  }
}

@ApiSchema({ name: 'VolumeCreatedWebhook' })
export class VolumeCreatedWebhookDto extends BaseWebhookEventDto {
  @ApiProperty({
    description: 'Volume ID',
    example: 'vol-12345678',
  })
  id: string

  @ApiProperty({
    description: 'Volume name',
    example: 'my-volume',
  })
  name: string

  @ApiProperty({
    description: 'Organization ID',
    example: 'org123',
  })
  organizationId: string

  @ApiProperty({
    description: 'Volume state',
    enum: VolumeState,
    enumName: 'VolumeState',
  })
  state: VolumeState

  @ApiProperty({
    description: 'When the volume was created',
    example: '2025-12-19T10:30:00.000Z',
    format: 'date-time',
  })
  createdAt: string

  static fromEvent(event: VolumeCreatedEvent, eventType: string): VolumeCreatedWebhookDto {
    return {
      event: eventType,
      timestamp: new Date().toISOString(),
      id: event.volume.id,
      name: event.volume.name,
      organizationId: event.volume.organizationId,
      state: event.volume.state,
      createdAt: event.volume.createdAt.toISOString(),
    }
  }
}

@ApiSchema({ name: 'VolumeStateUpdatedWebhook' })
export class VolumeStateUpdatedWebhookDto extends BaseWebhookEventDto {
  @ApiProperty({
    description: 'Volume ID',
    example: 'vol-12345678',
  })
  id: string

  @ApiProperty({
    description: 'Volume name',
    example: 'my-volume',
  })
  name: string

  @ApiProperty({
    description: 'Organization ID',
    example: 'org123',
  })
  organizationId: string

  @ApiProperty({
    description: 'Previous state',
    enum: VolumeState,
    enumName: 'VolumeState',
  })
  oldState: VolumeState

  @ApiProperty({
    description: 'New state',
    enum: VolumeState,
    enumName: 'VolumeState',
  })
  newState: VolumeState

  @ApiProperty({
    description: 'When the volume was last updated',
    example: '2025-12-19T10:30:00.000Z',
    format: 'date-time',
  })
  updatedAt: string

  static fromEvent(event: VolumeStateUpdatedEvent, eventType: string): VolumeStateUpdatedWebhookDto {
    return {
      event: eventType,
      timestamp: new Date().toISOString(),
      id: event.volume.id,
      name: event.volume.name,
      organizationId: event.volume.organizationId,
      oldState: event.oldState,
      newState: event.newState,
      updatedAt: event.volume.updatedAt.toISOString(),
    }
  }
}
