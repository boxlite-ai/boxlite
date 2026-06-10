/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { WebhookService } from './webhook.service'
import { BoxEvents } from '../../box/constants/box-events.constants'
import { VolumeEvents } from '../../box/constants/volume-events'
import { BoxCreatedEvent } from '../../box/events/box-create.event'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { VolumeCreatedEvent } from '../../box/events/volume-created.event'
import { VolumeStateUpdatedEvent } from '../../box/events/volume-state-updated.event'
import { WebhookEvent } from '../constants/webhook-events.constants'
import {
  BoxCreatedWebhookDto,
  BoxStateUpdatedWebhookDto,
  VolumeCreatedWebhookDto,
  VolumeStateUpdatedWebhookDto,
} from '../dto/webhook-event-payloads.dto'

@Injectable()
export class WebhookEventHandlerService {
  private readonly logger = new Logger(WebhookEventHandlerService.name)

  constructor(private readonly webhookService: WebhookService) {}

  @OnEvent(BoxEvents.CREATED)
  async handleBoxCreated(event: BoxCreatedEvent) {
    if (!this.webhookService.isEnabled()) {
      return
    }

    try {
      const payload = BoxCreatedWebhookDto.fromEvent(event, WebhookEvent.BOX_CREATED)
      await this.webhookService.sendWebhook(event.box.organizationId, WebhookEvent.BOX_CREATED, payload)
    } catch (error) {
      this.logger.error(`Failed to send webhook for box created: ${error.message}`)
    }
  }

  @OnEvent(BoxEvents.STATE_UPDATED)
  async handleBoxStateUpdated(event: BoxStateUpdatedEvent) {
    if (!this.webhookService.isEnabled()) {
      return
    }

    try {
      const payload = BoxStateUpdatedWebhookDto.fromEvent(event, WebhookEvent.BOX_STATE_UPDATED)
      await this.webhookService.sendWebhook(event.box.organizationId, WebhookEvent.BOX_STATE_UPDATED, payload)
    } catch (error) {
      this.logger.error(`Failed to send webhook for box state updated: ${error.message}`)
    }
  }

  // TODO(image-rewrite): box_template webhook handlers removed with box_template; rebuild here.

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
