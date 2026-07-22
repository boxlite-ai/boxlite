/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Organization } from '../organization/entities/organization.entity'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../box/constants/box.constants'
import { RatedPeriod } from './entities/rated-period.entity'
import { WalletTransaction } from './entities/wallet-transaction.entity'
import { Wallet } from './entities/wallet.entity'
import { WalletService } from './wallet.service'

interface RepositoryWithRows {
  rows: unknown[]
}

class FakeEntityManager {
  readonly repositories = new Map<unknown, RepositoryWithRows>()

  getRepository<T>(entity: unknown): T {
    const repository = this.repositories.get(entity)
    if (!repository) {
      throw new Error(`missing fake repository for ${String(entity)}`)
    }
    return repository as T
  }

  async transaction<T>(work: (manager: FakeEntityManager) => Promise<T>): Promise<T> {
    const snapshots = new Map<RepositoryWithRows, unknown[]>()
    for (const repository of this.repositories.values()) {
      snapshots.set(repository, structuredClone(repository.rows))
    }

    try {
      return await work(this)
    } catch (error) {
      for (const [repository, rows] of snapshots) {
        repository.rows.splice(0, repository.rows.length, ...rows)
      }
      throw error
    }
  }
}

class FakeWalletRepository implements RepositoryWithRows {
  rows: Wallet[] = []
  manager: FakeEntityManager
  lockModes: string[] = []

  create(input: Partial<Wallet>): Wallet {
    return input as Wallet
  }

  async findOne(options: { where: Partial<Wallet>; lock?: { mode: string } }): Promise<Wallet | null> {
    if (options.lock) {
      this.lockModes.push(options.lock.mode)
    }
    return this.rows.find((row) => row.organizationId === options.where.organizationId) ?? null
  }

  async save(wallet: Wallet): Promise<Wallet> {
    if (!wallet.id) {
      wallet.id = `wallet-${this.rows.length + 1}`
      wallet.createdAt = new Date()
    }
    wallet.updatedAt = new Date()
    const index = this.rows.findIndex((row) => row.id === wallet.id)
    if (index === -1) {
      this.rows.push(wallet)
    } else {
      this.rows[index] = wallet
    }
    return wallet
  }
}

class FakeWalletTransactionRepository implements RepositoryWithRows {
  rows: WalletTransaction[] = []
  saveError: Error | null = null

  create(input: Partial<WalletTransaction>): WalletTransaction {
    return input as WalletTransaction
  }

  async findOne(options: { where: Partial<WalletTransaction> }): Promise<WalletTransaction | null> {
    return (
      this.rows.find(
        (row) => options.where.ratedPeriodId !== undefined && row.ratedPeriodId === options.where.ratedPeriodId,
      ) ?? null
    )
  }

  async save(transaction: WalletTransaction): Promise<WalletTransaction> {
    if (this.saveError) {
      throw this.saveError
    }
    transaction.id = transaction.id ?? `transaction-${this.rows.length + 1}`
    transaction.createdAt = transaction.createdAt ?? new Date()
    this.rows.push(transaction)
    return transaction
  }
}

class FakeRatedPeriodRepository implements RepositoryWithRows {
  rows: RatedPeriod[] = []

  createQueryBuilder() {
    let excludedOrganizationId: string | undefined
    const builder = {
      leftJoin: () => builder,
      where: () => builder,
      andWhere: (_condition: string, parameters: { warmPoolOrganizationId?: string }) => {
        excludedOrganizationId = parameters.warmPoolOrganizationId
        return builder
      },
      orderBy: () => builder,
      addOrderBy: () => builder,
      take: () => builder,
      getMany: async () => this.rows.filter((row) => row.organizationId !== excludedOrganizationId),
    }
    return builder
  }
}

class FakeOrganizationRepository implements RepositoryWithRows {
  rows: Organization[] = []
  lockModes: string[] = []

  async findOne(options: { where: Partial<Organization>; lock?: { mode: string } }): Promise<Organization | null> {
    if (options.lock) {
      this.lockModes.push(options.lock.mode)
    }
    return this.rows.find((row) => row.id === options.where.id) ?? null
  }
}

class FakeBillingConfig {
  get(key: string): number {
    if (key === 'billing.trialGrantCents') {
      return 10000
    }
    if (key === 'billing.trialDurationDays') {
      return 30
    }
    throw new Error(`unexpected config key ${key}`)
  }
}

function ratedPeriod(overrides: Partial<RatedPeriod> = {}): RatedPeriod {
  return {
    id: 'rated-1',
    usagePeriodArchiveId: 'e2591ad4-2a0e-48b9-b414-75a45f56d3cc',
    organizationId: 'f5de33a9-4eb2-4279-a8de-9f02d63cc4f0',
    billingUserId: null,
    boxId: 'box-1',
    usageStartAt: new Date('2026-07-10T00:00:00Z'),
    usageEndAt: new Date('2026-07-10T00:00:01Z'),
    pricingSegments: [],
    usageTotals: { cpuSeconds: '0', memGibSeconds: '0', diskGibSeconds: '0', gpuSeconds: '0' },
    billedSeconds: '1',
    preciseCents: '1',
    ratedCents: '1',
    ratedAt: new Date('2026-07-10T00:00:00Z'),
    ...overrides,
  }
}

function createService(subscriptionSettlement?: { settle: jest.Mock }) {
  const manager = new FakeEntityManager()
  const wallets = new FakeWalletRepository()
  const transactions = new FakeWalletTransactionRepository()
  const ratedPeriods = new FakeRatedPeriodRepository()
  const organizations = new FakeOrganizationRepository()
  wallets.manager = manager
  organizations.rows.push({ id: 'f5de33a9-4eb2-4279-a8de-9f02d63cc4f0' } as Organization)
  manager.repositories.set(Wallet, wallets)
  manager.repositories.set(WalletTransaction, transactions)
  manager.repositories.set(RatedPeriod, ratedPeriods)
  manager.repositories.set(Organization, organizations)
  const eventEmitter = { emit: jest.fn() }
  const service = new WalletService(
    wallets as never,
    ratedPeriods as never,
    new FakeBillingConfig() as never,
    eventEmitter as never,
    subscriptionSettlement as never,
  )
  return { service, wallets, transactions, ratedPeriods, organizations, eventEmitter }
}

describe('WalletService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T00:00:00Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('creates one wallet with a configurable 30-day free grant', async () => {
    const { service, wallets, transactions, organizations } = createService()

    const first = await service.getOrCreateWallet('f5de33a9-4eb2-4279-a8de-9f02d63cc4f0')
    const second = await service.getOrCreateWallet('f5de33a9-4eb2-4279-a8de-9f02d63cc4f0')

    expect(first).toBe(second)
    expect(wallets.rows).toHaveLength(1)
    expect(wallets.rows[0]).toMatchObject({
      freeBalanceCents: '10000',
      paidBalanceCents: '0',
      settlementRemainderCents: '0',
      freeExpiresAt: new Date('2026-08-09T00:00:00Z'),
      billingStatus: 'trial',
    })
    expect(transactions.rows).toHaveLength(1)
    expect(transactions.rows[0]).toMatchObject({ kind: 'free_grant', amountCents: '10000' })
    expect(organizations.lockModes).toContain('pessimistic_write')
  })

  it('carries sub-cent usage and debits only whole cents from the wallet', async () => {
    const { service, wallets, transactions } = createService()
    await service.debitRatedPeriod(ratedPeriod({ id: 'rated-1', preciseCents: '0.6', ratedCents: '1' }))
    await service.debitRatedPeriod(ratedPeriod({ id: 'rated-2', preciseCents: '0.6', ratedCents: '1' }))

    expect(wallets.rows[0]).toMatchObject({ freeBalanceCents: '9999', settlementRemainderCents: '0.2' })
    expect(transactions.rows.filter((row) => row.kind === 'usage_debit').map((row) => row.amountCents)).toEqual([
      '0',
      '-1',
    ])
  })

  it('spends free balance before paid balance', async () => {
    const { service, wallets } = createService()
    const wallet = await service.getOrCreateWallet('f5de33a9-4eb2-4279-a8de-9f02d63cc4f0')
    wallet.freeBalanceCents = '100'
    wallet.paidBalanceCents = '100'

    await service.debitRatedPeriod(ratedPeriod({ preciseCents: '150', ratedCents: '150' }))

    expect(wallets.rows[0]).toMatchObject({ freeBalanceCents: '0', paidBalanceCents: '50' })
  })

  it('emits a balance-changed event only after a usage debit commits', async () => {
    const { service, eventEmitter } = createService()

    await service.debitRatedPeriod(ratedPeriod({ preciseCents: '25', ratedCents: '25' }))

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'billing.wallet.balance-changed',
      expect.objectContaining({ organizationId: 'f5de33a9-4eb2-4279-a8de-9f02d63cc4f0' }),
    )
  })

  it('preserves the usage debt as a negative paid balance', async () => {
    const { service, wallets } = createService()
    const wallet = await service.getOrCreateWallet('f5de33a9-4eb2-4279-a8de-9f02d63cc4f0')
    wallet.freeBalanceCents = '0'
    wallet.paidBalanceCents = '0'

    await service.debitRatedPeriod(ratedPeriod({ preciseCents: '25', ratedCents: '25' }))

    expect(wallets.rows[0]).toMatchObject({ paidBalanceCents: '-25', billingStatus: 'zero_balance' })
  })

  it('does not debit the same rated period twice and locks the wallet row', async () => {
    const { service, wallets, transactions } = createService()
    const period = ratedPeriod()

    expect(await service.debitRatedPeriod(period)).not.toBeNull()
    expect(await service.debitRatedPeriod(period)).toBeNull()

    expect(transactions.rows.filter((row) => row.ratedPeriodId === period.id)).toHaveLength(1)
    expect(wallets.lockModes).toContain('pessimistic_write')
  })

  it('settles subscription quota before locking and mutating the wallet', async () => {
    let wallets: FakeWalletRepository
    const subscriptionSettlement = {
      settle: jest.fn(async () => {
        expect(wallets.lockModes).toEqual([])
        return { preciseChargeCents: '0', quotaCoveredPreciseCents: '1', slices: [] }
      }),
    }
    const harness = createService(subscriptionSettlement)
    wallets = harness.wallets

    await harness.service.debitRatedPeriod(ratedPeriod())

    expect(subscriptionSettlement.settle).toHaveBeenCalledTimes(1)
    expect(wallets.lockModes).toContain('pessimistic_write')
  })

  it('does not consume quota again when the rated period was already debited', async () => {
    const subscriptionSettlement = {
      settle: jest.fn(async () => ({ preciseChargeCents: '0', quotaCoveredPreciseCents: '1', slices: [] })),
    }
    const { service } = createService(subscriptionSettlement)
    const period = ratedPeriod()

    await service.debitRatedPeriod(period)
    await service.debitRatedPeriod(period)

    expect(subscriptionSettlement.settle).toHaveBeenCalledTimes(1)
  })

  it('rolls back the wallet mutation when the ledger insert fails', async () => {
    const { service, wallets, transactions } = createService()
    const wallet = await service.getOrCreateWallet('f5de33a9-4eb2-4279-a8de-9f02d63cc4f0')
    wallet.freeBalanceCents = '100'
    transactions.saveError = new Error('ledger unavailable')

    await expect(service.debitRatedPeriod(ratedPeriod({ preciseCents: '10', ratedCents: '10' }))).rejects.toThrow(
      'ledger unavailable',
    )

    expect(wallets.rows[0].freeBalanceCents).toBe('100')
    expect(transactions.rows.filter((row) => row.kind === 'usage_debit')).toHaveLength(0)
  })

  it('expires unused trial funds before charging new usage', async () => {
    const { service, wallets, transactions } = createService()
    const wallet = await service.getOrCreateWallet('f5de33a9-4eb2-4279-a8de-9f02d63cc4f0')
    wallet.freeBalanceCents = '100'
    wallet.freeExpiresAt = new Date('2026-07-09T00:00:00Z')

    await service.debitRatedPeriod(ratedPeriod())

    expect(wallets.rows[0]).toMatchObject({ freeBalanceCents: '0', paidBalanceCents: '-1' })
    expect(transactions.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'adjustment', source: 'trial_expired', amountCents: '-100' }),
        expect.objectContaining({ kind: 'usage_debit', amountCents: '-1' }),
      ]),
    )
  })

  it('sweeps each unrated wallet debit once', async () => {
    const { service, ratedPeriods, transactions } = createService()
    ratedPeriods.rows.push(ratedPeriod({ id: 'rated-1' }), ratedPeriod({ id: 'rated-2' }))

    expect(await service.debitRatedPeriods()).toEqual({ debited: 2, skipped: 0 })
    expect(await service.debitRatedPeriods()).toEqual({ debited: 0, skipped: 2 })
    expect(transactions.rows.filter((row) => row.kind === 'usage_debit')).toHaveLength(2)
  })

  it('excludes unassigned warm-pool usage from wallet settlement', async () => {
    const { service, ratedPeriods, transactions } = createService()
    ratedPeriods.rows.push(
      ratedPeriod({ id: 'warm-pool-rated', organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION }),
      ratedPeriod({ id: 'organization-rated' }),
    )

    await expect(service.debitRatedPeriods()).resolves.toEqual({ debited: 1, skipped: 0 })
    expect(transactions.rows.filter((row) => row.kind === 'usage_debit')).toEqual([
      expect.objectContaining({ ratedPeriodId: 'organization-rated' }),
    ])
  })
})
