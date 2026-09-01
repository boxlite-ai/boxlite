import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { And, Equal, ILike, In, IsNull, LessThan, MoreThan, Not, Repository } from 'typeorm'
import { validate as isUuid } from 'uuid'
import { Box } from '../../box/entities/box.entity'
import { BoxState } from '../../box/enums/box-state.enum'
import { OrganizationUser } from '../../organization/entities/organization-user.entity'
import { Organization } from '../../organization/entities/organization.entity'
import { BoxUsagePeriodArchive } from '../../usage/entities/box-usage-period-archive.entity'
import { BoxUsagePeriod } from '../../usage/entities/box-usage-period.entity'
import { User } from '../../user/user.entity'
import { cursorFor, cursorValue, uuidCursorValue } from '../utils/pagination'
import { GIB, INACTIVE_BOX_STATES, latestDate } from '../utils/projection'

type ListQuery = { query?: string; cursor?: string; limit: number }
type DetailQuery = { memberCursor?: string; boxCursor?: string; memberLimit: number; boxLimit: number }
type ImpactState = 'impacted' | 'not_impacted'
type UsagePeriod = Pick<BoxUsagePeriod, 'startAt' | 'endAt' | 'cpu' | 'disk'>
type Fraction = { numerator: bigint; denominator: bigint }
// One row per (organization, state, desiredState) rather than one row per box.
type BoxGroupRow = { organizationId: string; state: BoxState; desiredState: string; boxCount: string; observedAt: Date }
type MemberCountRow = { organizationId: string; memberCount: string }
type OrganizationStats = {
  memberCount: number
  boxCount: number
  impactedBoxCount: number
  observedAt: Date | null
}

const escapedLike = (value: string): string => `%${value.replace(/[\\%_]/g, '\\$&')}%`
const timestamp = (value: Date): string => value.toISOString()
const impactState = (impacted: boolean): ImpactState => (impacted ? 'impacted' : 'not_impacted')
// state and desiredState are separate enums, so the comparison goes through their text form.
const isImpactedBox = (box: { state: BoxState; desiredState: string }): boolean =>
  box.state === BoxState.ERROR || String(box.state) !== String(box.desiredState)
const count = (value: string | number | null | undefined): number => Number(value ?? 0) || 0
const emptyStats = (): OrganizationStats => ({
  memberCount: 0,
  boxCount: 0,
  impactedBoxCount: 0,
  observedAt: null,
})
const decimalFraction = (value: number): Fraction => {
  const [coefficient, exponentText] = value.toString().toLowerCase().split('e')
  const exponent = Number(exponentText ?? 0)
  const negative = coefficient.startsWith('-')
  const unsigned = negative ? coefficient.slice(1) : coefficient
  const [whole, fraction = ''] = unsigned.split('.')
  const digits = BigInt(`${whole}${fraction}`)
  const decimalPlaces = fraction.length - exponent
  const numerator = (negative ? -digits : digits) * (decimalPlaces < 0 ? 10n ** BigInt(-decimalPlaces) : 1n)
  const denominator = decimalPlaces > 0 ? 10n ** BigInt(decimalPlaces) : 1n
  return { numerator, denominator }
}
const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
  let a = left < 0n ? -left : left
  let b = right < 0n ? -right : right
  while (b !== 0n) [a, b] = [b, a % b]
  return a
}
const addFraction = (left: Fraction, right: Fraction): Fraction => {
  const denominatorGcd = greatestCommonDivisor(left.denominator, right.denominator)
  const leftMultiplier = right.denominator / denominatorGcd
  const rightMultiplier = left.denominator / denominatorGcd
  const numerator = left.numerator * leftMultiplier + right.numerator * rightMultiplier
  const denominator = left.denominator * leftMultiplier
  const resultGcd = greatestCommonDivisor(numerator, denominator)
  return { numerator: numerator / resultGcd, denominator: denominator / resultGcd }
}
const weightedSeconds = (durationMs: number, resource: number, multiplier = 1n): Fraction => {
  const quantity = decimalFraction(resource)
  return {
    numerator: BigInt(durationMs) * quantity.numerator * multiplier,
    denominator: 1000n * quantity.denominator,
  }
}

@Injectable()
export class AdminOrganizationOverviewService {
  constructor(
    @InjectRepository(Organization) private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(OrganizationUser)
    private readonly organizationUserRepository: Repository<OrganizationUser>,
    @InjectRepository(User) private readonly userRepository: Repository<User>,
    @InjectRepository(Box) private readonly boxRepository: Repository<Box>,
    @InjectRepository(BoxUsagePeriod)
    private readonly usagePeriodRepository: Repository<BoxUsagePeriod>,
  ) {}

  async list(input: ListQuery) {
    const after = uuidCursorValue(input.cursor)
    const search = input.query
      ? [
          ...(isUuid(input.query)
            ? [{ id: after ? And(Equal(input.query), MoreThan(after)) : Equal(input.query) }]
            : []),
          { name: ILike(escapedLike(input.query)), ...(after ? { id: MoreThan(after) } : {}) },
        ]
      : undefined
    const organizations = await this.organizationRepository.find({
      where: search ? search : after ? { id: MoreThan(after) } : {},
      select: { id: true, name: true, updatedAt: true },
      order: { id: 'ASC' },
      take: input.limit + 1,
    })
    const page = organizations.slice(0, input.limit)
    const nextOrganization = organizations.length > input.limit ? page.at(-1) : undefined
    const stats = await this.organizationStats(page.map((organization) => organization.id))
    const summaries = page.map((organization) => {
      const organizationStats = stats.get(organization.id) ?? emptyStats()
      return {
        organizationId: organization.id,
        name: organization.name,
        memberCount: organizationStats.memberCount,
        boxCount: organizationStats.boxCount,
        impactState: impactState(organizationStats.impactedBoxCount > 0),
        observedAt: timestamp(
          latestDate([organization.updatedAt, organizationStats.observedAt]) ?? organization.updatedAt,
        ),
      }
    })
    return {
      items: summaries,
      nextCursor: nextOrganization ? cursorFor(nextOrganization.id) : null,
      limit: input.limit,
      observedAt: latestDate(summaries.map((summary) => new Date(summary.observedAt)))?.toISOString() ?? null,
    }
  }

  /**
   * Counts each organization's members and boxes in the database. The page above is
   * bounded, so the work behind it must be too: grouping by the box state enums keeps the
   * result set sized by the enum cross-product rather than by how many boxes exist.
   */
  private async organizationStats(organizationIds: string[]): Promise<Map<string, OrganizationStats>> {
    const stats = new Map<string, OrganizationStats>()
    if (organizationIds.length === 0) return stats

    const [memberCounts, boxGroups] = await Promise.all([
      this.organizationUserRepository
        .createQueryBuilder('member')
        .select('member."organizationId"', 'organizationId')
        .addSelect('COUNT(*)', 'memberCount')
        .where('member."organizationId" IN (:...organizationIds)', { organizationIds })
        .groupBy('member."organizationId"')
        .getRawMany<MemberCountRow>(),
      this.boxRepository
        .createQueryBuilder('box')
        .select('box."organizationId"', 'organizationId')
        .addSelect('box.state', 'state')
        .addSelect('box."desiredState"', 'desiredState')
        .addSelect('COUNT(*)', 'boxCount')
        .addSelect('MAX(box."updatedAt")', 'observedAt')
        .where('box."organizationId" IN (:...organizationIds)', { organizationIds })
        .groupBy('box."organizationId"')
        .addGroupBy('box.state')
        .addGroupBy('box."desiredState"')
        .getRawMany<BoxGroupRow>(),
    ])

    const statsFor = (organizationId: string): OrganizationStats => {
      const existing = stats.get(organizationId)
      if (existing) return existing
      const created = emptyStats()
      stats.set(organizationId, created)
      return created
    }
    for (const group of memberCounts) statsFor(group.organizationId).memberCount = count(group.memberCount)
    for (const group of boxGroups) {
      const organization = statsFor(group.organizationId)
      organization.observedAt = latestDate([organization.observedAt, group.observedAt])
      if (INACTIVE_BOX_STATES.includes(group.state)) continue
      const boxes = count(group.boxCount)
      organization.boxCount += boxes
      if (isImpactedBox(group)) organization.impactedBoxCount += boxes
    }
    return stats
  }

  async detail(organizationId: string, input: DetailQuery) {
    const memberAfter = cursorValue(input.memberCursor)
    const boxAfter = cursorValue(input.boxCursor)
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, name: true, updatedAt: true },
    })
    if (!organization) return null

    const [memberships, organizationBoxes, usage, impactedBoxes] = await Promise.all([
      this.organizationUserRepository.find({
        where: { organizationId, ...(memberAfter ? { userId: MoreThan(memberAfter) } : {}) },
        select: { userId: true, role: true, createdAt: true },
        order: { userId: 'ASC' },
        take: input.memberLimit + 1,
      }),
      this.boxRepository.find({
        where: {
          organizationId,
          state: Not(In(INACTIVE_BOX_STATES)),
          ...(boxAfter ? { id: MoreThan(boxAfter) } : {}),
        },
        select: {
          id: true,
          organizationId: true,
          name: true,
          state: true,
          desiredState: true,
          runnerId: true,
          region: true,
          updatedAt: true,
        },
        order: { id: 'ASC' },
        take: input.boxLimit + 1,
      }),
      this.currentMonthUsage(organizationId),
      // Impact is a property of the whole organization, not of the requested page, so it
      // gets its own bounded query instead of a scan the page happens to have loaded.
      // The row count is bounded by `take`, and the row width by this projection: an
      // unprojected getMany() would also read `secrets`, `env`, and `authToken`, none of
      // which the evidence below renders.
      // state and desiredState are separate Postgres enum types; ::text makes them comparable.
      this.boxRepository
        .createQueryBuilder('box')
        .select(['box.id', 'box.name', 'box.state', 'box.desiredState', 'box.updatedAt'])
        .where('box."organizationId" = :organizationId', { organizationId })
        .andWhere('box.state NOT IN (:...inactive)', { inactive: INACTIVE_BOX_STATES })
        .andWhere('(box.state = :error OR box.state::text <> box."desiredState"::text)', { error: BoxState.ERROR })
        .orderBy('box.id', 'ASC')
        .take(input.boxLimit)
        .getMany(),
    ])
    const users = memberships.length
      ? await this.userRepository.find({
          where: { id: In(memberships.map((membership) => membership.userId)) },
          select: { id: true, email: true, name: true },
        })
      : []
    const usersById = new Map(users.map((user) => [user.id, user]))
    const memberPage = memberships.slice(0, input.memberLimit)
    const boxPage = organizationBoxes.slice(0, input.boxLimit)
    const nextMember = memberships.length > input.memberLimit ? memberPage.at(-1) : undefined
    const nextBox = organizationBoxes.length > input.boxLimit ? boxPage.at(-1) : undefined

    return {
      organizationId,
      name: organization.name,
      members: {
        items: memberPage.flatMap((membership) => {
          const user = usersById.get(membership.userId)
          return user
            ? [
                {
                  userId: membership.userId,
                  email: user.email,
                  displayName: user.name,
                  organizationRole: membership.role,
                  joinedAt: timestamp(membership.createdAt),
                },
              ]
            : []
        }),
        nextCursor: nextMember ? cursorFor(nextMember.userId) : null,
        limit: input.memberLimit,
      },
      boxes: {
        items: boxPage.map((box) => ({
          id: box.id,
          name: box.name,
          observedState: box.state,
          desiredState: box.desiredState,
          runnerId: box.runnerId ?? null,
          region: box.region,
          observedAt: timestamp(box.updatedAt),
        })),
        nextCursor: nextBox ? cursorFor(nextBox.id) : null,
        limit: input.boxLimit,
      },
      impact: {
        state: impactState(impactedBoxes.length > 0),
        evidence: impactedBoxes.map((box) => ({
          boxId: box.id,
          observedAt: timestamp(box.updatedAt),
          summary: `${box.name}: ${box.state} (desired ${box.desiredState})`,
        })),
      },
      usage,
      observedAt: timestamp(organization.updatedAt),
    }
  }

  private async currentMonthUsage(organizationId: string) {
    const periodEnd = new Date()
    const periodStart = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), 1))
    // Rollover deletes the live row and inserts a fresh-id archive copy in one transaction
    // (usage.service.ts). Two reads on two pool connections straddle that commit and count
    // the period twice or lose it, and the archive row's new id rules out de-duplication.
    // One repeatable-read snapshot puts both reads on the same side of the rollover.
    const periods = await this.usagePeriodRepository.manager.transaction(
      'REPEATABLE READ',
      async (snapshot): Promise<UsagePeriod[]> => {
        const [currentPeriods, archivedPeriods] = await Promise.all([
          snapshot.find(BoxUsagePeriod, {
            where: [
              { organizationId, startAt: LessThan(periodEnd), endAt: IsNull() },
              { organizationId, startAt: LessThan(periodEnd), endAt: MoreThan(periodStart) },
            ],
            select: { startAt: true, endAt: true, cpu: true, disk: true },
          }),
          snapshot.find(BoxUsagePeriodArchive, {
            where: { organizationId, startAt: LessThan(periodEnd), endAt: MoreThan(periodStart) },
            select: { startAt: true, endAt: true, cpu: true, disk: true },
          }),
        ])
        return [...currentPeriods, ...archivedPeriods]
      },
    )
    const totals = periods.reduce(
      (sum, period: UsagePeriod) => {
        const overlapStart = Math.max(period.startAt.getTime(), periodStart.getTime())
        const overlapEnd = Math.min((period.endAt ?? periodEnd).getTime(), periodEnd.getTime())
        const durationMs = Math.max(0, overlapEnd - overlapStart)
        return {
          compute: addFraction(sum.compute, weightedSeconds(durationMs, period.cpu)),
          storage: addFraction(sum.storage, weightedSeconds(durationMs, period.disk, BigInt(GIB))),
        }
      },
      {
        compute: { numerator: 0n, denominator: 1n },
        storage: { numerator: 0n, denominator: 1n },
      },
    )
    return {
      periodStart: timestamp(periodStart),
      periodEnd: timestamp(periodEnd),
      computeSeconds: String(totals.compute.numerator / totals.compute.denominator),
      storageByteSeconds: String(totals.storage.numerator / totals.storage.denominator),
    }
  }
}
