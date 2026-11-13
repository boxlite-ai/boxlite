/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { TypedConfigService } from '../../config/typed-config.service'
import { CustomDomainWorkflowService } from './custom-domain-workflow.service'

/** Best effort while the API has CPU; durable progress belongs to the workflow. */
@Injectable()
export class CustomDomainSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CustomDomainSchedulerService.name)
  private activeRound?: Promise<void>
  private stopping = false

  constructor(
    private readonly config: TypedConfigService,
    private readonly workflow: CustomDomainWorkflowService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.checkDue()
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true
    await this.activeRound
  }

  @Interval(60_000)
  async checkDue(): Promise<void> {
    if (this.stopping || !this.config.get('customDomains.enabled') || this.config.get('skipConnections')) return
    if (this.activeRound) return this.activeRound
    this.activeRound = this.reconcile()
    try {
      await this.activeRound
    } finally {
      this.activeRound = undefined
    }
  }

  private async reconcile(): Promise<void> {
    const results = await Promise.allSettled([this.workflow.advancePending(), this.workflow.maintain()])
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.logger.error(
          `Custom domain ${index === 0 ? 'advancement' : 'maintenance'} round failed`,
          result.reason instanceof Error ? result.reason.message : 'unknown',
        )
      }
    }
  }
}
