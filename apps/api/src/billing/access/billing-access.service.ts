/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, Repository } from 'typeorm'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { Box } from '../../box/entities/box.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { TypedConfigService } from '../../config/typed-config.service'
import { BoxUsagePeriodArchive } from '../../usage/entities/box-usage-period-archive.entity'
import { BoxUsagePeriod } from '../../usage/entities/box-usage-period.entity'
import { PricingPlan } from '../entities/pricing-plan.entity'
import { RatedPeriod } from '../entities/rated-period.entity'
import { WalletTransaction } from '../entities/wallet-transaction.entity'
import { Wallet } from '../entities/wallet.entity'
import { WalletService } from '../wallet.service'
import {
  calculateBillingAccess,
  type BillingAccessResult,
  type BillingAllocation,
  type UnbilledUsagePeriod,
} from './billing-access'

export interface BillingAccessEvaluation extends BillingAccessResult {
  organizationId: string
  activeBoxIds: string[]
}

@Injectable()
export class BillingAccessService {
  constructor(
    @InjectRepository(Wallet)
    private readonly wallets: Repository<Wallet>,
    private readonly walletService: WalletService,
    @InjectRepository(BoxUsagePeriod)
    private readonly usagePeriods: Repository<BoxUsagePeriod>,
    @InjectRepository(BoxUsagePeriodArchive)
    private readonly usageArchives: Repository<BoxUsagePeriodArchive>,
    @InjectRepository(RatedPeriod)
    private readonly ratedPeriods: Repository<RatedPeriod>,
    @InjectRepository(PricingPlan)
    private readonly pricingPlans: Repository<PricingPlan>,
    @InjectRepository(Box)
    private readonly boxes: Repository<Box>,
    private readonly config: TypedConfigService,
  ) {}

  evaluate(
    organizationId: string,
    candidateAllocation: BillingAllocation | null = null,
    now = new Date(),
  ): Promise<BillingAccessEvaluation> {
    return this.evaluateMany(
      [organizationId],
      candidateAllocation ? new Map([[organizationId, candidateAllocation]]) : new Map(),
      now,
    ).then((evaluations) => evaluations[0])
  }

  async evaluateMany(
    organizationIds: string[],
    candidateAllocations = new Map<string, BillingAllocation>(),
    now = new Date(),
  ): Promise<BillingAccessEvaluation[]> {
    const uniqueOrganizationIds = [...new Set(organizationIds)]
    if (uniqueOrganizationIds.length === 0) return []

    const [existingWallets, usagePeriods, usageArchives, ratedPeriods, pricingPlans, activeBoxes] = await Promise.all([
      this.wallets.findBy({ organizationId: In(uniqueOrganizationIds) }),
      this.usagePeriods.findBy({ organizationId: In(uniqueOrganizationIds) }),
      this.findUnratedArchives(uniqueOrganizationIds),
      this.findUnsettledRatedPeriods(uniqueOrganizationIds),
      this.pricingPlans.find({ order: { effectiveFrom: 'ASC', version: 'ASC' } }),
      this.boxes.findBy({
        organizationId: In(uniqueOrganizationIds),
        desiredState: BoxDesiredState.STARTED,
        state: BoxState.STARTED,
      }),
    ])

    const walletsByOrganization = new Map(existingWallets.map((wallet) => [wallet.organizationId, wallet]))
    for (const organizationId of uniqueOrganizationIds) {
      if (!walletsByOrganization.has(organizationId)) {
        walletsByOrganization.set(organizationId, await this.walletService.getOrCreateWallet(organizationId))
      }
    }

    return uniqueOrganizationIds.map((organizationId) => {
      const wallet = walletsByOrganization.get(organizationId)
      if (!wallet) throw new Error(`billing wallet missing for organization ${organizationId}`)

      const organizationUsagePeriods = usagePeriods.filter((period) => period.organizationId === organizationId)
      const organizationArchives = usageArchives.filter((period) => period.organizationId === organizationId)
      const organizationRatedPeriods = ratedPeriods.filter((period) => period.organizationId === organizationId)
      const organizationBoxes = activeBoxes.filter((box) => box.organizationId === organizationId)
      const ongoingAllocations = new Map<string, BillingAllocation>()

      for (const period of organizationUsagePeriods) {
        if (!period.endAt) {
          ongoingAllocations.set(
            period.boxId,
            this.ongoingAllocation(period.boxId, period, period.computeBillableUntil, now),
          )
        }
      }
      for (const box of organizationBoxes) {
        if (!ongoingAllocations.has(box.id)) {
          ongoingAllocations.set(box.id, { boxId: box.id, cpu: 0, mem: 0, disk: box.disk, gpu: 0 })
        }
      }

      const result = calculateBillingAccess({
        freeBalanceCents:
          wallet.freeExpiresAt && wallet.freeExpiresAt.getTime() <= now.getTime() ? '0' : wallet.freeBalanceCents,
        paidBalanceCents: wallet.paidBalanceCents,
        settlementRemainderCents: wallet.settlementRemainderCents,
        unbilledPeriods: [
          ...organizationUsagePeriods.flatMap((period) => this.unbilledPeriods(period, now)),
          ...organizationArchives.map((period) => ({
            ...this.allocation(period.boxId, period),
            startAt: period.startAt,
            endAt: period.endAt,
          })),
        ],
        unsettledRatedCents: organizationRatedPeriods.map((period) => period.preciseCents),
        ongoingAllocations: [...ongoingAllocations.values()],
        candidateAllocation: candidateAllocations.get(organizationId) ?? null,
        pricingPlans,
        now,
        riskWindowSeconds: this.config.get('billing.enforcementRiskWindowSeconds'),
      })

      return {
        organizationId,
        activeBoxIds: organizationBoxes.map((box) => box.id),
        ...result,
      }
    })
  }

  assertHasAccess(
    organizationId: string,
    candidateAllocation: BillingAllocation,
    now = new Date(),
  ): Promise<BillingAccessEvaluation | null> {
    if (!this.config.get('billing.enforcementEnabled')) return Promise.resolve(null)
    return this.evaluate(organizationId, candidateAllocation, now).then((evaluation) => {
      if (!evaluation.hasAccess) {
        throw new HttpException(
          {
            statusCode: HttpStatus.PAYMENT_REQUIRED,
            error: 'Payment Required',
            code: 'BILLING_BALANCE_REQUIRED',
            message: 'Insufficient billing balance to start this Box',
          },
          HttpStatus.PAYMENT_REQUIRED,
        )
      }
      return evaluation
    })
  }

  isEnabled(): boolean {
    return this.config.get('billing.enforcementEnabled')
  }

  async listActiveOrganizationIds(): Promise<string[]> {
    const rows = await this.boxes
      .createQueryBuilder('box')
      .select('DISTINCT box."organizationId"', 'organizationId')
      .where('box."desiredState" = :desiredState', { desiredState: BoxDesiredState.STARTED })
      .andWhere('box.state = :state', { state: BoxState.STARTED })
      .andWhere('box."organizationId" <> :warmPoolOrganizationId', {
        warmPoolOrganizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
      })
      .orderBy('box."organizationId"', 'ASC')
      .getRawMany<{ organizationId: string }>()
    return rows.map((row) => row.organizationId)
  }

  private findUnratedArchives(organizationIds: string[]): Promise<BoxUsagePeriodArchive[]> {
    return this.usageArchives
      .createQueryBuilder('archive')
      .leftJoin(RatedPeriod, 'rated', 'rated."usagePeriodArchiveId" = archive.id')
      .where('archive."organizationId" IN (:...organizationIds)', { organizationIds })
      .andWhere('rated.id IS NULL')
      .getMany()
  }

  private findUnsettledRatedPeriods(organizationIds: string[]): Promise<RatedPeriod[]> {
    return this.ratedPeriods
      .createQueryBuilder('rated')
      .leftJoin(WalletTransaction, 'transaction', 'transaction."ratedPeriodId" = rated.id')
      .where('rated."organizationId" IN (:...organizationIds)', { organizationIds })
      .andWhere('transaction.id IS NULL')
      .getMany()
  }

  private unbilledPeriods(period: BoxUsagePeriod, now: Date): UnbilledUsagePeriod[] {
    const endAt = period.endAt ?? now
    if (endAt.getTime() < period.startAt.getTime() || !this.hasComputeAllocation(period)) {
      return [{ ...this.allocation(period.boxId, period), startAt: period.startAt, endAt }]
    }

    const computeBillableUntil = period.computeBillableUntil
    const computeEndAt = computeBillableUntil
      ? new Date(Math.min(endAt.getTime(), computeBillableUntil.getTime()))
      : period.startAt
    const boundedComputeEndAt = computeEndAt.getTime() > period.startAt.getTime() ? computeEndAt : period.startAt
    const billablePeriods: UnbilledUsagePeriod[] = []

    if (boundedComputeEndAt.getTime() > period.startAt.getTime()) {
      billablePeriods.push({
        ...this.allocation(period.boxId, period),
        startAt: period.startAt,
        endAt: boundedComputeEndAt,
      })
    }
    if (endAt.getTime() > boundedComputeEndAt.getTime() && period.disk > 0) {
      billablePeriods.push({
        boxId: period.boxId,
        cpu: 0,
        mem: 0,
        disk: period.disk,
        gpu: 0,
        startAt: boundedComputeEndAt,
        endAt,
      })
    }
    return billablePeriods
  }

  private ongoingAllocation(
    boxId: string,
    resources: Pick<Box | BoxUsagePeriod, 'cpu' | 'mem' | 'disk' | 'gpu'>,
    computeBillableUntil: Date | null | undefined,
    now: Date,
  ): BillingAllocation {
    if (
      !this.hasComputeAllocation(resources) ||
      (computeBillableUntil != null && computeBillableUntil.getTime() > now.getTime())
    ) {
      return this.allocation(boxId, resources)
    }
    return { boxId, cpu: 0, mem: 0, disk: resources.disk, gpu: 0 }
  }

  private hasComputeAllocation(resources: Pick<Box | BoxUsagePeriod, 'cpu' | 'mem' | 'gpu'>): boolean {
    return resources.cpu > 0 || resources.mem > 0 || resources.gpu > 0
  }

  private allocation(
    boxId: string,
    resources: Pick<Box | BoxUsagePeriod | BoxUsagePeriodArchive, 'cpu' | 'mem' | 'disk' | 'gpu'>,
  ): BillingAllocation {
    return {
      boxId,
      cpu: resources.cpu,
      mem: resources.mem,
      disk: resources.disk,
      gpu: resources.gpu,
    }
  }
}
