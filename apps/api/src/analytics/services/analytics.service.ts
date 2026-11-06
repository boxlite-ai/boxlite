/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { BoxEvents } from '../../box/constants/box-events.constants'
import { BoxCreatedEvent } from '../../box/events/box-create.event'
import { BoxDesiredStateUpdatedEvent } from '../../box/events/box-desired-state-updated.event'
import { BoxDestroyedEvent } from '../../box/events/box-destroyed.event'
import { BoxInboundModeUpdatedEvent } from '../../box/events/box-inbound-mode-updated.event'
import { BoxStartedEvent } from '../../box/events/box-started.event'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { BoxStoppedEvent } from '../../box/events/box-stopped.event'
import { PostHog } from 'posthog-node'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { Organization } from '../../organization/entities/organization.entity'
import { OrganizationEvents } from '../../organization/constants/organization-events.constant'
import { TypedConfigService } from '../../config/typed-config.service'
import { subscribeBusinessEvents } from '../../common/utils/business-event.util'

@Injectable()
export class AnalyticsService implements OnApplicationShutdown {
  private readonly logger = new Logger(AnalyticsService.name)
  private readonly posthog?: PostHog
  private readonly unsubscribe?: () => void

  get enabled(): boolean {
    return !!this.posthog
  }

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
    this.posthog.on('error', () => this.logger.warn('PostHog analytics delivery failed'))
    this.unsubscribe = subscribeBusinessEvents((attributes) => {
      const userId =
        attributes['user.id'] ||
        (attributes['event.name'].startsWith('user.') ? attributes['correlation.id'] : undefined)
      const organizationId = attributes['organization.id']
      this.capture({
        event: attributes['event.name'],
        distinctId: userId || `${attributes['actor.kind'] || 'anonymous'}:${attributes['correlation.id']}`,
        timestamp: new Date(attributes['event.timestamp']),
        groups: organizationId ? { organization: organizationId } : undefined,
        properties: {
          ...attributes,
          activity_schema: '1',
          environment: this.configService.get('posthog.environment'),
          $process_person_profile: !!userId,
        },
      })
    })
  }

  capture(event: Parameters<PostHog['capture']>[0]): void {
    try {
      this.posthog?.capture(event)
    } catch {
      this.logger.warn('PostHog analytics capture failed')
    }
  }

  groupIdentify(group: Parameters<PostHog['groupIdentify']>[0]): void {
    try {
      this.posthog?.groupIdentify(group)
    } catch {
      this.logger.warn('PostHog organization identification failed')
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.unsubscribe?.()
    try {
      await this.posthog?.shutdown(5000)
    } catch {
      this.logger.warn('PostHog analytics shutdown failed')
    }
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

  @OnEvent(BoxEvents.INBOUND_MODE_UPDATED)
  async handleBoxInboundModeUpdatedEvent(event: BoxInboundModeUpdatedEvent) {
    this.logger.debug(`Box inbound mode updated: ${JSON.stringify(event)}`)
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

    this.groupIdentify({
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
