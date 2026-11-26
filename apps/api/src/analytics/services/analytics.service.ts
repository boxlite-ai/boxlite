/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AnalyticsConsentService, AnalyticsSubjects } from './analytics-consent.service'
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
import type { PostHog } from 'posthog-node'
import { ConsentBoundPostHog } from './consent-bound-posthog'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { Organization } from '../../organization/entities/organization.entity'
import { OrganizationEvents } from '../../organization/constants/organization-events.constant'
import { TypedConfigService } from '../../config/typed-config.service'
import { subscribeBusinessEvents } from '../../common/utils/business-event.util'

@Injectable()
export class AnalyticsService implements OnApplicationShutdown {
  private readonly logger = new Logger(AnalyticsService.name)
  private readonly posthog?: ConsentBoundPostHog
  private readonly maxConcurrent: number
  private readonly unsubscribe?: () => void

  private readonly pending = new Set<Promise<unknown>>()
  private readonly queue: (() => Promise<unknown>)[] = []
  private closing = false

  get enabled(): boolean {
    return !!this.posthog
  }

  constructor(
    private readonly configService: TypedConfigService,
    private readonly consent: AnalyticsConsentService,
  ) {
    const poolMax = this.configService.get('database.pool.max') ?? 10
    this.maxConcurrent = Math.max(0, Math.min(2, poolMax - 1))
    if (!this.maxConcurrent || !this.configService.get('posthog.apiKey')) {
      return
    }

    if (!this.configService.get('posthog.host')) {
      return
    }

    // Initialize PostHog client
    this.posthog = new ConsentBoundPostHog(this.configService.get('posthog.apiKey'), {
      host: this.configService.get('posthog.host'),
      requestTimeout: 1200,
      fetchRetryCount: 0,
    })
    this.posthog.on('error', () => this.logger.warn('PostHog analytics delivery failed'))
    this.unsubscribe = subscribeBusinessEvents((attributes) => {
      const accountEvent = attributes['event.name'] === 'user.login' || attributes['event.name'] === 'user.registration'
      const targetUser = accountEvent ? attributes['correlation.id'] : undefined
      const userId = attributes['user.id'] || targetUser
      const organizationId = attributes['organization.id']
      if (!accountEvent && !organizationId) return
      if (['user', 'admin'].includes(attributes['actor.kind']) && !attributes['user.id']) return
      this.capture(
        {
          event: attributes['event.name'],
          uuid: attributes['event.id'],
          distinctId: userId || `${attributes['actor.kind'] || 'anonymous'}:${attributes['correlation.id']}`,
          timestamp: new Date(attributes['event.timestamp']),
          groups: organizationId ? { organization: organizationId } : undefined,
          properties: {
            ...attributes,
            ...(attributes['event.name'].startsWith('cloud.')
              ? { cloud_metrics_schema: '1' }
              : { activity_schema: '1' }),
            $process_person_profile: !!userId,
          },
        },
        {
          users: [...new Set([userId, targetUser].filter((id): id is string => !!id))],
          organizations: organizationId ? [organizationId] : [],
        },
      )
    })
  }

  capture(event: Parameters<PostHog['capture']>[0], subjects: AnalyticsSubjects): void {
    const client = this.posthog
    if (
      !client ||
      this.closing ||
      this.queue.length >= 32 ||
      (!subjects.users.length && !subjects.organizations.length)
    )
      return
    const occurredAt = event.timestamp ?? new Date()
    this.queue.push(() =>
      this.consent
        .dispatch(subjects, occurredAt, () =>
          client.deliver({
            ...event,
            timestamp: occurredAt,
            properties: { ...event.properties, environment: this.configService.get('posthog.environment') },
          }),
        )
        .catch(() => this.logger.warn('PostHog analytics capture failed')),
    )
    this.dispatchNext()
  }

  private dispatchNext(): void {
    if (this.pending.size >= this.maxConcurrent) return
    const next = this.queue.shift()
    if (!next) return
    const delivery = next()
    this.pending.add(delivery)
    void delivery.finally(() => {
      this.pending.delete(delivery)
      this.dispatchNext()
    })
  }

  groupIdentify(group: Parameters<PostHog['groupIdentify']>[0], users: string[] = []): void {
    if (!group.groupKey) return
    this.capture(
      {
        event: '$groupidentify',
        distinctId: group.distinctId || `$${group.groupType}_${group.groupKey}`,
        properties: { $group_type: group.groupType, $group_key: group.groupKey, $group_set: group.properties },
      },
      { users, organizations: [group.groupKey] },
    )
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true
    this.unsubscribe?.()
    while (this.pending.size) await Promise.allSettled(this.pending)
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
        is_default_for_creator: payload.users?.some(
          (user) => user.userId === payload.createdBy && user.isDefaultForUser,
        ),
        environment: this.configService.get('posthog.environment'),
      },
    })
  }
}
