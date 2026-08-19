/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { OnEvent } from '@nestjs/event-emitter'
import { InjectRepository } from '@nestjs/typeorm'
import { Between, In, LessThan, Repository } from 'typeorm'
import { BoxEvents } from '../../box/constants/box-events.constants'
import { Box } from '../../box/entities/box.entity'
import { BoxCreatedEvent } from '../../box/events/box-create.event'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { BOX_STATES_CONSUMING_COMPUTE } from '../constants/box-consuming-states.constant'
import { OrganizationConcurrencyDto } from '../dto/organization-concurrency.dto'
import { OrganizationConcurrencySample } from '../entities/organization-concurrency-sample.entity'
import { OrganizationQuota } from '../entities/organization-quota.entity'
import { DEFAULT_ORG_QUOTA } from './org-quota'

const HISTORY_RETENTION_DAYS = 30

@Injectable()
export class OrganizationConcurrencyService {
  private readonly logger = new Logger(OrganizationConcurrencyService.name)

  constructor(
    @InjectRepository(Box) private readonly boxRepository: Repository<Box>,
    @InjectRepository(OrganizationQuota) private readonly quotaRepository: Repository<OrganizationQuota>,
    @InjectRepository(OrganizationConcurrencySample)
    private readonly sampleRepository: Repository<OrganizationConcurrencySample>,
  ) {}

  async setEntitlement(organizationId: string, maxConcurrentBoxes: number | null): Promise<void> {
    await this.quotaRepository.upsert({ organizationId, maxConcurrentBoxes }, ['organizationId'])
  }

  async getConcurrency(organizationId: string, from: Date, to = new Date()): Promise<OrganizationConcurrencyDto> {
    const [current, quota, anchor, samples] = await Promise.all([
      this.countCurrent(organizationId),
      this.quotaRepository.findOne({ where: { organizationId } }),
      this.sampleRepository.findOne({
        where: { organizationId, observedAt: LessThan(from) },
        order: { observedAt: 'DESC' },
      }),
      this.sampleRepository.find({
        where: { organizationId, observedAt: Between(from, to) },
        order: { observedAt: 'ASC' },
      }),
    ])

    const points = [
      ...(anchor ? [{ observedAt: from, runningBoxes: anchor.runningBoxes }] : []),
      ...samples.map(({ observedAt, runningBoxes }) => ({ observedAt, runningBoxes })),
    ]
    const last = points.at(-1)
    if (!last || last.observedAt.getTime() !== to.getTime() || last.runningBoxes !== current) {
      points.push({ observedAt: to, runningBoxes: current })
    }

    return {
      current,
      limit: quota ? quota.maxConcurrentBoxes : DEFAULT_ORG_QUOTA.maxConcurrentBoxes,
      points,
    }
  }

  async recordCurrent(organizationId: string): Promise<void> {
    const runningBoxes = await this.countCurrent(organizationId)
    const latest = await this.sampleRepository.findOne({
      where: { organizationId },
      order: { observedAt: 'DESC' },
    })
    if (latest?.runningBoxes === runningBoxes) {
      return
    }

    await this.sampleRepository.save({ organizationId, runningBoxes })
  }

  @OnEvent(BoxEvents.CREATED)
  async handleBoxCreated(event: BoxCreatedEvent): Promise<void> {
    await this.recordFromEvent(event.box.organizationId)
  }

  @OnEvent(BoxEvents.STATE_UPDATED)
  async handleBoxStateUpdated(event: BoxStateUpdatedEvent): Promise<void> {
    const wasConsuming = BOX_STATES_CONSUMING_COMPUTE.includes(event.oldState)
    const isConsuming = BOX_STATES_CONSUMING_COMPUTE.includes(event.newState)
    const isWarmPoolAssignment = event.oldState === event.newState && isConsuming
    if (wasConsuming === isConsuming && !isWarmPoolAssignment) {
      return
    }
    await this.recordFromEvent(event.box.organizationId)
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'prune-organization-concurrency-samples' })
  async pruneHistory(): Promise<void> {
    const cutoff = new Date(Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    await this.sampleRepository.delete({ observedAt: LessThan(cutoff) })
  }

  private countCurrent(organizationId: string): Promise<number> {
    return this.boxRepository.count({
      where: { organizationId, state: In(BOX_STATES_CONSUMING_COMPUTE) },
    })
  }

  private async recordFromEvent(organizationId: string): Promise<void> {
    try {
      await this.recordCurrent(organizationId)
    } catch (error) {
      this.logger.warn(`Error recording concurrency for organization ${organizationId}: ${error}`)
    }
  }
}
