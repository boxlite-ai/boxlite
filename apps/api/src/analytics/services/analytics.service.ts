/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { BoxEvents } from '../../box/constants/box-events.constants'
import { BoxCreatedEvent } from '../../box/events/box-create.event'
import { BoxDesiredStateUpdatedEvent } from '../../box/events/box-desired-state-updated.event'
import { BoxDestroyedEvent } from '../../box/events/box-destroyed.event'
import { BoxPublicStatusUpdatedEvent } from '../../box/events/box-public-status-updated.event'
import { BoxStartedEvent } from '../../box/events/box-started.event'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { BoxStoppedEvent } from '../../box/events/box-stopped.event'
import { PostHog } from 'posthog-node'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { Organization } from '../../organization/entities/organization.entity'
import { OrganizationEvents } from '../../organization/constants/organization-events.constant'
import { TypedConfigService } from '../../config/typed-config.service'

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name)
  private readonly posthog?: PostHog

  constructor(private readonly configService: TypedConfigService) {
    if (!this.configService.get('posthog.apiKey')) {
      return
    }

    if (!this.configService.get('posthog.host')) {
      return
    }

    // Initialize PostHog client
    this.posthog = new PostHog(this.configService.get('posthog.apiKey'), {
      host: this.configService.get('posthog.host'),
    })
  }

  @OnEvent(BoxEvents.CREATED)
  async handleBoxCreatedEvent(event: BoxCreatedEvent) {
    this.logger.debug(`Box created: ${JSON.stringify(event)}`)
  }

  @OnEvent(BoxEvents.STARTED)
  async handleBoxStartedEvent(event: BoxStartedEvent) {
    this.logger.debug(`Box started: ${JSON.stringify(event)}`)
  }

  @OnEvent(BoxEvents.STOPPED)
  async handleBoxStoppedEvent(event: BoxStoppedEvent) {
    this.logger.debug(`Box stopped: ${JSON.stringify(event)}`)
  }

  @OnEvent(BoxEvents.DESTROYED)
  async handleBoxDestroyedEvent(event: BoxDestroyedEvent) {
    this.logger.debug(`Box destroyed: ${JSON.stringify(event)}`)
  }

  @OnEvent(BoxEvents.PUBLIC_STATUS_UPDATED)
  async handleBoxPublicStatusUpdatedEvent(event: BoxPublicStatusUpdatedEvent) {
    this.logger.debug(`Box public status updated: ${JSON.stringify(event)}`)
  }

  @OnEvent(BoxEvents.DESIRED_STATE_UPDATED)
  async handleBoxDesiredStateUpdatedEvent(event: BoxDesiredStateUpdatedEvent) {
    this.logger.debug(`Box desired state updated: ${JSON.stringify(event)}`)
  }

  @OnEvent(BoxEvents.STATE_UPDATED)
  async handleBoxStateUpdatedEvent(event: BoxStateUpdatedEvent) {
    this.logger.debug(`Box state updated: ${JSON.stringify(event)}`)
  }

  @OnAsyncEvent({
    event: OrganizationEvents.CREATED,
  })
  async handleOrganizationCreatedEvent(payload: Organization) {
    if (!this.posthog) {
      return
    }

    this.posthog.groupIdentify({
      groupType: 'organization',
      groupKey: payload.id,
      properties: {
        name: payload.name,
        created_at: payload.createdAt,
        created_by: payload.createdBy,
        is_default_for_creator: payload.users?.some(
          (user) => user.userId === payload.createdBy && user.isDefaultForUser,
        ),
        environment: this.configService.get('posthog.environment'),
      },
    })
  }
}
