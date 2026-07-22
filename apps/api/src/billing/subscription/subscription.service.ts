/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import Decimal from 'decimal.js'
import { EntityManager, IsNull, Repository } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { OrganizationSubscription } from '../entities/organization-subscription.entity'
import { SubscriptionEntitlement } from '../entities/subscription-entitlement.entity'
import { SubscriptionPeriod } from '../entities/subscription-period.entity'
import { SubscriptionPlan } from '../entities/subscription-plan.entity'
import { Wallet } from '../entities/wallet.entity'
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
  ProviderSubscriptionSnapshot,
  ProviderWebhookEvent,
} from '../payment/payment-provider'
import { SUBSCRIPTION_PLAN_CODES, SubscriptionPlanCode } from './subscription.types'
import { providerPlanTransition } from './subscription-transition'

@Injectable()
export class SubscriptionService {
  constructor(
    @InjectRepository(OrganizationSubscription)
    private readonly subscriptions: Repository<OrganizationSubscription>,
    @InjectRepository(SubscriptionPlan)
    private readonly plans: Repository<SubscriptionPlan>,
    @Inject(PAYMENT_PROVIDER)
    private readonly provider: PaymentProvider,
    private readonly config: TypedConfigService,
  ) {}

  async listPlans() {
    const plans = await this.plans.find({ where: { active: true }, order: { rank: 'ASC' } })
    return plans.map((plan) => this.planView(plan))
  }

  async getSubscription(organizationId: string) {
    const subscription = await this.subscriptions.findOne({ where: { organizationId } })
    if (!subscription) return { subscription: null, plans: await this.listPlans() }
    const now = new Date()
    const [plan, pendingPlan, period] = await Promise.all([
      this.plans.findOneByOrFail({ id: subscription.planId }),
      subscription.pendingPlanId ? this.plans.findOneBy({ id: subscription.pendingPlanId }) : null,
      this.subscriptions.manager
        .getRepository(SubscriptionPeriod)
        .createQueryBuilder('period')
        .where('period."subscriptionId" = :subscriptionId', { subscriptionId: subscription.id })
        .andWhere('period."periodStart" <= :now', { now })
        .andWhere('period."periodEnd" > :now', { now })
        .orderBy('period.periodStart', 'DESC')
        .getOne(),
    ])
    return {
      subscription: {
        status: subscription.status,
        plan: this.planView(plan),
        currentPeriodStart: subscription.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        pendingPlan: pendingPlan ? this.planView(pendingPlan) : null,
        pendingChangeKind: subscription.pendingChangeKind,
        pendingPlanEffectiveAt: subscription.pendingPlanEffectiveAt?.toISOString() ?? null,
        quota: period
          ? {
              grantedPreciseCents: period.quotaGrantedPreciseCents,
              consumedPreciseCents: period.quotaConsumedPreciseCents,
              remainingPreciseCents: Decimal.max(
                0,
                new Decimal(period.quotaGrantedPreciseCents).minus(period.quotaConsumedPreciseCents),
              ).toString(),
            }
          : null,
      },
      plans: await this.listPlans(),
    }
  }

  async createCheckout(organizationId: string, planCode: string, idempotencyKey: string) {
    this.assertIdempotencyKey(idempotencyKey)
    const plan = await this.getActivePlan(planCode)
    await this.subscriptions.manager.transaction(async (manager) => {
      const repository = manager.getRepository(OrganizationSubscription)
      let subscription = await repository.findOne({ where: { organizationId }, lock: { mode: 'pessimistic_write' } })
      if (subscription?.providerSubscriptionId && subscription.status !== 'canceled') {
        throw new ConflictException('organization already has a subscription; use the plan change endpoint')
      }
      if (subscription?.pendingChangeIdempotencyKey && subscription.pendingChangeIdempotencyKey !== idempotencyKey) {
        throw new ConflictException('another subscription checkout is already pending')
      }
      if (!subscription) {
        subscription = repository.create({
          organizationId,
          planId: plan.id,
          status: 'pending',
          providerSubscriptionId: null,
          providerScheduleId: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          pendingPlanId: null,
          pendingChangeKind: null,
          pendingChangeIdempotencyKey: idempotencyKey,
          pendingPlanEffectiveAt: null,
          checkoutProviderReference: null,
        })
      } else {
        subscription.planId = plan.id
        subscription.status = 'pending'
        subscription.pendingChangeIdempotencyKey = idempotencyKey
      }
      await repository.save(subscription)
    })

    const wallet = await this.subscriptions.manager.getRepository(Wallet).findOne({ where: { organizationId } })
    try {
      const result = await this.provider.createSubscriptionCheckout({
        organizationId,
        idempotencyKey,
        planCode: plan.code,
        providerPriceId: this.providerPriceId(plan.code),
        providerCustomerId: wallet?.paymentProviderCustomerId ?? null,
        ...this.returnUrls(),
      })
      await this.subscriptions.manager.transaction(async (manager) => {
        const repository = manager.getRepository(OrganizationSubscription)
        const subscription = await repository.findOne({
          where: { organizationId },
          lock: { mode: 'pessimistic_write' },
        })
        if (!subscription || subscription.pendingChangeIdempotencyKey !== idempotencyKey) return
        subscription.checkoutProviderReference = result.providerReference
        await repository.save(subscription)
        if (result.snapshot) await this.applyPeriodPaid(manager, result.snapshot)
      })
      return { checkoutUrl: result.checkoutUrl, providerReference: result.providerReference }
    } catch (error) {
      await this.clearClaim(organizationId, plan.id, idempotencyKey)
      throw error
    }
  }

  async changePlan(organizationId: string, planCode: string, idempotencyKey: string) {
    this.assertIdempotencyKey(idempotencyKey)
    const target = await this.getActivePlan(planCode)
    const claimed = await this.subscriptions.manager.transaction(async (manager) => {
      const subscription = await manager.getRepository(OrganizationSubscription).findOne({
        where: { organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!subscription?.providerSubscriptionId || subscription.status === 'canceled') {
        throw new BadRequestException('organization has no active provider subscription')
      }
      const current = await manager.getRepository(SubscriptionPlan).findOneByOrFail({ id: subscription.planId })
      if (current.id === target.id && !subscription.pendingPlanId) return null
      if (subscription.pendingPlanId) {
        if (
          subscription.pendingPlanId !== target.id ||
          subscription.pendingChangeIdempotencyKey !== idempotencyKey
        ) {
          throw new ConflictException('another subscription plan change is already pending')
        }
      }
      const kind = target.rank > current.rank ? 'upgrade' : 'downgrade'
      subscription.pendingPlanId = target.id
      subscription.pendingChangeKind = kind
      subscription.pendingChangeIdempotencyKey = idempotencyKey
      subscription.pendingPlanEffectiveAt = kind === 'downgrade' ? subscription.currentPeriodEnd : new Date()
      await manager.getRepository(OrganizationSubscription).save(subscription)
      return { subscription, current, kind }
    })
    if (!claimed) return this.getSubscription(organizationId)

    const input = {
      organizationId,
      idempotencyKey,
      providerSubscriptionId: claimed.subscription.providerSubscriptionId!,
      providerScheduleId: claimed.subscription.providerScheduleId,
      providerPriceId: this.providerPriceId(target.code),
      planCode: target.code,
    }
    try {
      const result =
        claimed.kind === 'upgrade'
          ? await this.provider.upgradeSubscription(input)
          : await this.provider.scheduleSubscriptionDowngrade(input)
      await this.subscriptions.manager.transaction(async (manager) => {
        if (claimed.kind === 'upgrade') {
          await this.applySnapshot(manager, result.snapshot)
          const subscription = await manager.getRepository(OrganizationSubscription).findOne({
            where: { organizationId },
            lock: { mode: 'pessimistic_write' },
          })
          if (!subscription || subscription.pendingPlanId !== target.id) return
          subscription.providerScheduleId = result.providerScheduleId
          subscription.pendingPlanEffectiveAt = subscription.currentPeriodEnd
          await manager.getRepository(OrganizationSubscription).save(subscription)
        }
      })
    } catch (error) {
      await this.clearClaim(organizationId, target.id, idempotencyKey)
      throw error
    }
    return this.getSubscription(organizationId)
  }

  async applyProviderEvent(manager: EntityManager, event: ProviderWebhookEvent): Promise<boolean> {
    if (event.kind === 'subscription_checkout_expired') {
      await this.clearExpiredCheckout(manager, event.organizationId, event.providerReference)
      return true
    }
    if (event.kind !== 'subscription_synced' && event.kind !== 'subscription_period_paid') return false
    if (event.kind === 'subscription_period_paid') {
      await this.applyPeriodPaid(manager, event.snapshot)
    } else {
      await this.applySnapshot(manager, event.snapshot)
    }
    return true
  }


  private async applyPeriodPaid(manager: EntityManager, snapshot: ProviderSubscriptionSnapshot): Promise<void> {
    const plan = await this.planForProviderPrice(manager, snapshot.providerPriceId)
    const subscription = await this.findOrCreateSubscription(manager, snapshot.organizationId, plan)
    const currentPlan = await manager.getRepository(SubscriptionPlan).findOneByOrFail({ id: subscription.planId })
    const transition = providerPlanTransition(subscription, currentPlan, plan, snapshot)
    if (transition === 'upgrade') {
      await this.completeUpgrade(manager, subscription, currentPlan, plan, snapshot, new Date())
      return
    }
    if (transition === 'ignore_stale') return

    this.assignSnapshot(subscription, snapshot, plan)
    this.clearAppliedChange(subscription, plan)
    await manager.getRepository(OrganizationSubscription).save(subscription)
    const period = await this.findOrCreatePeriod(manager, subscription, snapshot, plan)
    const existingEntitlement = await manager.getRepository(SubscriptionEntitlement).findOne({
      where: { subscriptionPeriodId: period.id },
      order: { effectiveFrom: 'DESC' },
    })
    if (!existingEntitlement) await this.createEntitlement(manager, period, plan, period.periodStart)
    await this.syncWalletCustomer(manager, snapshot.organizationId, snapshot.providerCustomerId)
  }

  private async applySnapshot(manager: EntityManager, snapshot: ProviderSubscriptionSnapshot): Promise<void> {
    const plan = await this.planForProviderPrice(manager, snapshot.providerPriceId)
    const subscription = await this.findOrCreateSubscription(manager, snapshot.organizationId, plan)
    const currentPlan = await manager.getRepository(SubscriptionPlan).findOneByOrFail({ id: subscription.planId })
    const transition = providerPlanTransition(subscription, currentPlan, plan, snapshot)
    if (transition === 'upgrade') {
      await this.completeUpgrade(manager, subscription, currentPlan, plan, snapshot, new Date())
      return
    }
    if (transition === 'ignore_stale') return

    this.assignSnapshot(subscription, snapshot, plan)
    this.clearAppliedChange(subscription, plan)
    await manager.getRepository(OrganizationSubscription).save(subscription)
    await this.syncWalletCustomer(manager, snapshot.organizationId, snapshot.providerCustomerId)
  }

  private async completeUpgrade(
    manager: EntityManager,
    subscription: OrganizationSubscription,
    currentPlan: SubscriptionPlan,
    targetPlan: SubscriptionPlan,
    snapshot: ProviderSubscriptionSnapshot,
    effectiveAt: Date,
  ): Promise<void> {
    const period = await this.findOrCreatePeriod(manager, subscription, snapshot, currentPlan)
    const currentEntitlement = await manager.getRepository(SubscriptionEntitlement).findOne({
      where: { subscriptionPeriodId: period.id, effectiveTo: IsNull() },
      order: { effectiveFrom: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    })
    if (currentEntitlement?.planCode !== targetPlan.code) {
      const quotaDifference = Decimal.max(0, new Decimal(targetPlan.quotaCents).minus(currentPlan.quotaCents))
      period.quotaGrantedPreciseCents = new Decimal(period.quotaGrantedPreciseCents).plus(quotaDifference).toString()
      await manager.getRepository(SubscriptionPeriod).save(period)
      await this.replaceEntitlement(manager, period, targetPlan, effectiveAt)
    }
    this.assignSnapshot(subscription, snapshot, targetPlan)
    this.clearAppliedChange(subscription, targetPlan)
    await manager.getRepository(OrganizationSubscription).save(subscription)
    await this.syncWalletCustomer(manager, subscription.organizationId, snapshot.providerCustomerId)
  }

  private clearAppliedChange(subscription: OrganizationSubscription, plan: SubscriptionPlan): void {
    if (subscription.pendingPlanId && subscription.pendingPlanId !== plan.id) return
    subscription.pendingPlanId = null
    subscription.pendingChangeKind = null
    subscription.pendingChangeIdempotencyKey = null
    subscription.pendingPlanEffectiveAt = null
  }


  private async clearExpiredCheckout(
    manager: EntityManager,
    organizationId: string,
    providerReference: string,
  ): Promise<void> {
    const repository = manager.getRepository(OrganizationSubscription)
    const subscription = await repository.findOne({
      where: { organizationId },
      lock: { mode: 'pessimistic_write' },
    })
    if (
      !subscription ||
      subscription.status !== 'pending' ||
      subscription.providerSubscriptionId ||
      (subscription.checkoutProviderReference !== null &&
        subscription.checkoutProviderReference !== providerReference)
    ) {
      return
    }
    subscription.pendingChangeIdempotencyKey = null
    subscription.checkoutProviderReference = null
    await repository.save(subscription)
  }

  private async findOrCreateSubscription(
    manager: EntityManager,
    organizationId: string,
    plan: SubscriptionPlan,
  ): Promise<OrganizationSubscription> {
    const repository = manager.getRepository(OrganizationSubscription)
    const existing = await repository.findOne({ where: { organizationId }, lock: { mode: 'pessimistic_write' } })
    return (
      existing ??
      repository.create({
        organizationId,
        planId: plan.id,
        status: 'pending',
        providerSubscriptionId: null,
        providerScheduleId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        pendingPlanId: null,
        pendingChangeKind: null,
        pendingChangeIdempotencyKey: null,
        pendingPlanEffectiveAt: null,
        checkoutProviderReference: null,
      })
    )
  }

  private async findOrCreatePeriod(
    manager: EntityManager,
    subscription: OrganizationSubscription,
    snapshot: ProviderSubscriptionSnapshot,
    plan: SubscriptionPlan,
  ): Promise<SubscriptionPeriod> {
    const repository = manager.getRepository(SubscriptionPeriod)
    const periodStart = new Date(snapshot.currentPeriodStart)
    const periodEnd = new Date(snapshot.currentPeriodEnd)
    const existing = await repository.findOne({
      where: { subscriptionId: subscription.id, periodStart },
      lock: { mode: 'pessimistic_write' },
    })
    if (existing) return existing
    return repository.save(
      repository.create({
        subscriptionId: subscription.id,
        organizationId: subscription.organizationId,
        periodStart,
        periodEnd,
        quotaGrantedPreciseCents: plan.quotaCents,
        quotaConsumedPreciseCents: '0',
      }),
    )
  }

  private async replaceEntitlement(
    manager: EntityManager,
    period: SubscriptionPeriod,
    plan: SubscriptionPlan,
    effectiveAt: Date,
  ): Promise<SubscriptionEntitlement> {
    const repository = manager.getRepository(SubscriptionEntitlement)
    const current = await repository.findOne({
      where: { subscriptionPeriodId: period.id, effectiveTo: IsNull() },
      order: { effectiveFrom: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    })
    if (current && current.planCode === plan.code) return current
    if (current) {
      current.effectiveTo = effectiveAt
      await repository.save(current)
    }
    return this.createEntitlement(manager, period, plan, effectiveAt)
  }

  private createEntitlement(
    manager: EntityManager,
    period: SubscriptionPeriod,
    plan: SubscriptionPlan,
    effectiveFrom: Date,
  ): Promise<SubscriptionEntitlement> {
    const repository = manager.getRepository(SubscriptionEntitlement)
    return repository.save(
      repository.create({
        subscriptionPeriodId: period.id,
        organizationId: period.organizationId,
        planCode: plan.code,
        effectiveFrom,
        effectiveTo: null,
        overageCpuMultiplier: plan.overageCpuMultiplier,
        overageMemMultiplier: plan.overageMemMultiplier,
        overageDiskMultiplier: plan.overageDiskMultiplier,
        overageGpuMultiplier: plan.overageGpuMultiplier,
      }),
    )
  }

  private assignSnapshot(
    subscription: OrganizationSubscription,
    snapshot: ProviderSubscriptionSnapshot,
    plan: SubscriptionPlan,
  ): void {
    subscription.planId = plan.id
    subscription.status = snapshot.status
    subscription.providerSubscriptionId = snapshot.providerSubscriptionId
    subscription.providerScheduleId = snapshot.providerScheduleId
    subscription.currentPeriodStart = new Date(snapshot.currentPeriodStart)
    subscription.currentPeriodEnd = new Date(snapshot.currentPeriodEnd)
  }

  private async syncWalletCustomer(manager: EntityManager, organizationId: string, providerCustomerId: string) {
    const repository = manager.getRepository(Wallet)
    const wallet = await repository.findOne({ where: { organizationId }, lock: { mode: 'pessimistic_write' } })
    if (wallet && wallet.paymentProviderCustomerId !== providerCustomerId) {
      wallet.paymentProviderCustomerId = providerCustomerId
      await repository.save(wallet)
    }
  }

  private async clearClaim(
    organizationId: string,
    targetPlanId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.subscriptions.manager.transaction(async (manager) => {
      const repository = manager.getRepository(OrganizationSubscription)
      const subscription = await repository.findOne({ where: { organizationId }, lock: { mode: 'pessimistic_write' } })
      if (!subscription || subscription.pendingChangeIdempotencyKey !== idempotencyKey) return
      if (subscription.pendingPlanId && subscription.pendingPlanId !== targetPlanId) return
      subscription.pendingPlanId = null
      subscription.pendingChangeKind = null
      subscription.pendingChangeIdempotencyKey = null
      subscription.pendingPlanEffectiveAt = null
      await repository.save(subscription)
    })
  }

  private assertIdempotencyKey(value: string): void {
    if (!value || value.length > 128) throw new BadRequestException('a valid Idempotency-Key header is required')
  }

  private getActivePlan(planCode: string): Promise<SubscriptionPlan> {
    if (!SUBSCRIPTION_PLAN_CODES.includes(planCode as SubscriptionPlanCode)) {
      throw new BadRequestException(`unsupported subscription plan: ${planCode}`)
    }
    return this.plans.findOne({ where: { code: planCode as SubscriptionPlanCode, active: true } }).then((plan) => {
      if (!plan) throw new NotFoundException(`subscription plan ${planCode} not found`)
      return plan
    })
  }

  private async planForProviderPrice(manager: EntityManager, providerPriceId: string): Promise<SubscriptionPlan> {
    const code = SUBSCRIPTION_PLAN_CODES.find((candidate) => this.providerPriceId(candidate) === providerPriceId)
    if (!code) throw new BadRequestException(`unknown subscription provider price: ${providerPriceId}`)
    return manager.getRepository(SubscriptionPlan).findOneByOrFail({ code })
  }

  private providerPriceId(code: SubscriptionPlanCode): string {
    const value = this.config.get(`billing.stripe.subscriptionPriceIds.${code}`)
    if (value) return value
    if (this.provider.mode === 'fake') return `fake-price-${code}`
    throw new Error(`Stripe subscription price is not configured for ${code}`)
  }

  private returnUrls() {
    const dashboardUrl = this.config.getOrThrow('dashboardUrl').replace(/\/$/, '')
    return {
      successUrl: `${dashboardUrl}/dashboard/billing?subscription=success`,
      cancelUrl: `${dashboardUrl}/dashboard/billing?subscription=cancelled`,
    }
  }

  private planView(plan: SubscriptionPlan) {
    return {
      code: plan.code,
      rank: plan.rank,
      monthlyPriceCents: plan.monthlyPriceCents,
      quotaCents: plan.quotaCents,
      overageMultipliers: {
        cpu: plan.overageCpuMultiplier,
        mem: plan.overageMemMultiplier,
        disk: plan.overageDiskMultiplier,
        gpu: plan.overageGpuMultiplier,
      },
    }
  }
}
