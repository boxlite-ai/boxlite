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

type ListQuery = { query?: string; cursor?: string; limit: number }
type DetailQuery = { memberCursor?: string; boxCursor?: string; memberLimit: number; boxLimit: number }
type ImpactState = 'impacted' | 'not_impacted'
type UsagePeriod = Pick<BoxUsagePeriod, 'startAt' | 'endAt' | 'cpu' | 'disk'>
type Fraction = { numerator: bigint; denominator: bigint }

const GIB = 1024 * 1024 * 1024
const inactiveBoxStates = [BoxState.DESTROYED, BoxState.ARCHIVED]
const escapedLike = (value: string): string => `%${value.replace(/[\\%_]/g, '\\$&')}%`
const timestamp = (value: Date): string => value.toISOString()
const impactState = (impacted: boolean): ImpactState => (impacted ? 'impacted' : 'not_impacted')
const isActiveBox = (box: Pick<Box, 'state'>): boolean => !inactiveBoxStates.includes(box.state)
const isImpactedBox = (box: Pick<Box, 'state' | 'desiredState'>): boolean =>
  box.state === BoxState.ERROR || String(box.state) !== String(box.desiredState)
const latestDate = (dates: Date[]): Date => dates.reduce((latest, value) => (latest >= value ? latest : value))
const groupBy = <T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> => {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFor(item)
    const group = grouped.get(key)
    if (group) group.push(item)
    else grouped.set(key, [item])
  }
  return grouped
}
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
    @InjectRepository(BoxUsagePeriodArchive)
    private readonly usagePeriodArchiveRepository: Repository<BoxUsagePeriodArchive>,
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
    const organizationIds = page.map((organization) => organization.id)
    const [memberships, boxes] = organizationIds.length
      ? await Promise.all([
          this.organizationUserRepository.find({
            where: { organizationId: In(organizationIds) },
            select: { organizationId: true, userId: true },
          }),
          this.boxRepository.find({
            where: { organizationId: In(organizationIds) },
            select: { organizationId: true, state: true, desiredState: true, updatedAt: true },
          }),
        ])
      : [[], []]
    const nextOrganization = organizations.length > input.limit ? page.at(-1) : undefined
    const membershipsByOrganization = groupBy(memberships, (membership) => membership.organizationId)
    const boxesByOrganization = groupBy(boxes, (box) => box.organizationId)
    const summaries = page.map((organization) => {
      const organizationBoxes = boxesByOrganization.get(organization.id) ?? []
      const activeBoxes = organizationBoxes.filter(isActiveBox)
      const observedAt = latestDate([organization.updatedAt, ...organizationBoxes.map((box) => box.updatedAt)])
      return {
        organizationId: organization.id,
        name: organization.name,
        memberCount: membershipsByOrganization.get(organization.id)?.length ?? 0,
        boxCount: activeBoxes.length,
        impactState: impactState(activeBoxes.some(isImpactedBox)),
        observedAt: timestamp(observedAt),
      }
    })
    return {
      items: summaries,
      nextCursor: nextOrganization ? cursorFor(nextOrganization.id) : null,
      limit: input.limit,
      observedAt: summaries.length
        ? latestDate(summaries.map((summary) => new Date(summary.observedAt))).toISOString()
        : null,
    }
  }

  async detail(organizationId: string, input: DetailQuery) {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, name: true, updatedAt: true },
    })
    if (!organization) return null

    const memberAfter = cursorValue(input.memberCursor)
    const boxAfter = cursorValue(input.boxCursor)
    const [memberships, organizationBoxes, usage] = await Promise.all([
      this.organizationUserRepository.find({
        where: { organizationId, ...(memberAfter ? { userId: MoreThan(memberAfter) } : {}) },
        select: { userId: true, role: true, createdAt: true },
        order: { userId: 'ASC' },
        take: input.memberLimit + 1,
      }),
      this.boxRepository.find({
        where: { organizationId, state: Not(In(inactiveBoxStates)) },
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
      }),
      this.currentMonthUsage(organizationId),
    ])
    const users = memberships.length
      ? await this.userRepository.find({
          where: { id: In(memberships.map((membership) => membership.userId)) },
          select: { id: true, email: true, name: true },
        })
      : []
    const usersById = new Map(users.map((user) => [user.id, user]))
    const memberPage = memberships.slice(0, input.memberLimit)
    const eligibleBoxes = organizationBoxes.filter((box) => !boxAfter || box.id > boxAfter)
    const boxPage = eligibleBoxes.slice(0, input.boxLimit)
    const impactedBoxes = organizationBoxes.filter(isImpactedBox).slice(0, input.boxLimit)
    const nextMember = memberships.length > input.memberLimit ? memberPage.at(-1) : undefined
    const nextBox = eligibleBoxes.length > input.boxLimit ? boxPage.at(-1) : undefined

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
    const [currentPeriods, archivedPeriods] = await Promise.all([
      this.usagePeriodRepository.find({
        where: [
          { organizationId, startAt: LessThan(periodEnd), endAt: IsNull() },
          { organizationId, startAt: LessThan(periodEnd), endAt: MoreThan(periodStart) },
        ],
        select: { startAt: true, endAt: true, cpu: true, disk: true },
      }),
      this.usagePeriodArchiveRepository.find({
        where: { organizationId, startAt: LessThan(periodEnd), endAt: MoreThan(periodStart) },
        select: { startAt: true, endAt: true, cpu: true, disk: true },
      }),
    ])
    const totals = [...currentPeriods, ...archivedPeriods].reduce(
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
