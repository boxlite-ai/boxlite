/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { WebhookService } from './webhook.service'
import { SandboxEvents } from '../../sandbox/constants/sandbox-events.constants'
import { SavedImageEvents } from '../../sandbox/constants/saved-image-events'
import { VolumeEvents } from '../../sandbox/constants/volume-events'
import { SandboxCreatedEvent } from '../../sandbox/events/sandbox-create.event'
import { SandboxStateUpdatedEvent } from '../../sandbox/events/sandbox-state-updated.event'
import { SavedImageCreatedEvent } from '../../sandbox/events/saved-image-created.event'
import { SavedImageStateUpdatedEvent } from '../../sandbox/events/saved-image-state-updated.event'
import { SavedImageRemovedEvent } from '../../sandbox/events/saved-image-removed.event'
import { VolumeCreatedEvent } from '../../sandbox/events/volume-created.event'
import { VolumeStateUpdatedEvent } from '../../sandbox/events/volume-state-updated.event'
import { WebhookEvent } from '../constants/webhook-events.constants'
import {
  SandboxCreatedWebhookDto,
  SandboxStateUpdatedWebhookDto,
  SavedImageCreatedWebhookDto,
  SavedImageStateUpdatedWebhookDto,
  SavedImageRemovedWebhookDto,
  VolumeCreatedWebhookDto,
  VolumeStateUpdatedWebhookDto,
} from '../dto/webhook-event-payloads.dto'

@Injectable()
export class WebhookEventHandlerService {
  private readonly logger = new Logger(WebhookEventHandlerService.name)

  constructor(private readonly webhookService: WebhookService) {}

  @OnEvent(SandboxEvents.CREATED)
  async handleSandboxCreated(event: SandboxCreatedEvent) {
    if (!this.webhookService.isEnabled()) {
      return
    }

    try {
      const payload = SandboxCreatedWebhookDto.fromEvent(event, WebhookEvent.SANDBOX_CREATED)
      await this.webhookService.sendWebhook(event.sandbox.organizationId, WebhookEvent.SANDBOX_CREATED, payload)
    } catch (error) {
      this.logger.error(`Failed to send webhook for sandbox created: ${error.message}`)
    }
  }

  @OnEvent(SandboxEvents.STATE_UPDATED)
  async handleSandboxStateUpdated(event: SandboxStateUpdatedEvent) {
    if (!this.webhookService.isEnabled()) {
      return
    }

    try {
      const payload = SandboxStateUpdatedWebhookDto.fromEvent(event, WebhookEvent.SANDBOX_STATE_UPDATED)
      await this.webhookService.sendWebhook(event.sandbox.organizationId, WebhookEvent.SANDBOX_STATE_UPDATED, payload)
    } catch (error) {
      this.logger.error(`Failed to send webhook for sandbox state updated: ${error.message}`)
    }
  }

  @OnEvent(SavedImageEvents.CREATED)
  async handleSavedImageCreated(event: SavedImageCreatedEvent) {
    if (!this.webhookService.isEnabled()) {
      return
    }

    try {
      const payload = SavedImageCreatedWebhookDto.fromEvent(event, WebhookEvent.SAVED_IMAGE_CREATED)
      await this.webhookService.sendWebhook(event.savedImage.organizationId, WebhookEvent.SAVED_IMAGE_CREATED, payload)
    } catch (error) {
      this.logger.error(`Failed to send webhook for savedImage created: ${error.message}`)
    }
  }

  @OnEvent(SavedImageEvents.STATE_UPDATED)
  async handleSavedImageStateUpdated(event: SavedImageStateUpdatedEvent) {
    if (!this.webhookService.isEnabled()) {
      return
    }

    try {
      const payload = SavedImageStateUpdatedWebhookDto.fromEvent(event, WebhookEvent.SAVED_IMAGE_STATE_UPDATED)
      await this.webhookService.sendWebhook(event.savedImage.organizationId, WebhookEvent.SAVED_IMAGE_STATE_UPDATED, payload)
    } catch (error) {
      this.logger.error(`Failed to send webhook for savedImage state updated: ${error.message}`)
    }
  }

  @OnEvent(SavedImageEvents.REMOVED)
  async handleSavedImageRemoved(event: SavedImageRemovedEvent) {
    if (!this.webhookService.isEnabled()) {
      return
    }

    try {
      const payload = SavedImageRemovedWebhookDto.fromEvent(event, WebhookEvent.SAVED_IMAGE_REMOVED)
      await this.webhookService.sendWebhook(event.savedImage.organizationId, WebhookEvent.SAVED_IMAGE_REMOVED, payload)
    } catch (error) {
      this.logger.error(`Failed to send webhook for savedImage removed: ${error.message}`)
    }
  }

  @OnEvent(VolumeEvents.CREATED)
  async handleVolumeCreated(event: VolumeCreatedEvent) {
    if (!this.webhookService.isEnabled()) {
      return
    }

    try {
      const payload = VolumeCreatedWebhookDto.fromEvent(event, WebhookEvent.VOLUME_CREATED)
      await this.webhookService.sendWebhook(event.volume.organizationId, WebhookEvent.VOLUME_CREATED, payload)
    } catch (error) {
      this.logger.error(`Failed to send webhook for volume created: ${error.message}`)
    }
  }

  @OnEvent(VolumeEvents.STATE_UPDATED)
  async handleVolumeStateUpdated(event: VolumeStateUpdatedEvent) {
    if (!this.webhookService.isEnabled()) {
      return
    }

    try {
      const payload = VolumeStateUpdatedWebhookDto.fromEvent(event, WebhookEvent.VOLUME_STATE_UPDATED)
      await this.webhookService.sendWebhook(event.volume.organizationId, WebhookEvent.VOLUME_STATE_UPDATED, payload)
    } catch (error) {
      this.logger.error(`Failed to send webhook for volume state updated: ${error.message}`)
    }
  }

  /**
   * Send a custom webhook event
   */
  async sendCustomWebhook(organizationId: string, eventType: string, payload: any, eventId?: string): Promise<void> {
    if (!this.webhookService.isEnabled()) {
      return
    }

    try {
      await this.webhookService.sendWebhook(organizationId, eventType, payload, eventId)
    } catch (error) {
      this.logger.error(`Failed to send custom webhook: ${error.message}`)
    }
  }
}
