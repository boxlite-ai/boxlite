/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingOverview, BillingUsageBucket } from '@/billing-api'
import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { Cpu, HardDrive, MemoryStick, RefreshCw } from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { useBillingOverviewQuery } from '@/hooks/queries/useBillingOverviewQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn } from '@/lib/utils'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

const RANGE_OPTIONS = [
  { id: '1h', label: '1H', milliseconds: 60 * 60 * 1000 },
  { id: '24h', label: '24H', milliseconds: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7D', milliseconds: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30D', milliseconds: 30 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'ALL', milliseconds: null },
] as const

type RangeId = (typeof RANGE_OPTIONS)[number]['id']

function dollarsFromCents(cents: string, maximumFractionDigits = 2): string {
  const value = Number(cents) / 100
  if (!Number.isFinite(value)) return 'Unavailable'
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits,
  })
}

function hours(seconds: string): string {
  const value = Number(seconds) / 3600
  return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'Unavailable'
}

function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-3 border-b border-dashed border-border pb-3">
      <span className="size-1.5 bg-brand" />
      <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-foreground">{title}</h2>
      <span className="min-w-6 flex-1 border-t border-dashed border-border" />
      {right}
    </div>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 border border-border bg-card px-4 py-4">
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="break-words font-mono text-[22px] font-semibold leading-none tabular-nums text-foreground">
        {value}
      </div>
      {detail ? <div className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{detail}</div> : null}
    </div>
  )
}

function StatePanel({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'error' }) {
  return (
    <div
      className={cn(
        'border bg-card px-5 py-6 font-mono text-[13px]',
        tone === 'error' ? 'border-destructive/50 text-destructive' : 'border-border text-muted-foreground',
      )}
    >
      {children}
    </div>
  )
}

function UsageTrend({ buckets }: { buckets: BillingUsageBucket[] }) {
  const maxCost = Math.max(...buckets.map((bucket) => Number(bucket.costPreciseCents)), 0)

  return (
    <div className="flex h-[132px] items-end gap-1 border-x border-b border-border bg-card px-3 pb-3 pt-5 sm:gap-2 sm:px-5">
      {buckets.map((bucket) => {
        const cost = Number(bucket.costPreciseCents)
        const height = maxCost > 0 && Number.isFinite(cost) ? Math.max(4, (cost / maxCost) * 100) : 4
        return (
          <div
            key={bucket.from}
            data-usage-bucket
            className="min-w-0 flex-1 bg-brand/70 transition-colors hover:bg-brand"
            style={{ height: `${height}%` }}
            title={`${new Date(bucket.from).toLocaleString()} - ${dollarsFromCents(bucket.costPreciseCents, 4)}`}
          />
        )
      })}
    </div>
  )
}

function PricingTable({ overview }: { overview: BillingOverview }) {
  const rows = [
    ['CPU', overview.pricing.cpuRateCentsPerHour, 'vCPU hr'],
    ['Memory', overview.pricing.memRateCentsPerHour, 'GiB hr'],
    ['Disk', overview.pricing.diskRateCentsPerHour, 'GiB hr'],
  ]
  return (
    <div className="border border-border bg-card font-mono text-[12px]">
      {rows.map(([label, cents, unit], index) => (
        <div
          key={label}
          className={cn('grid grid-cols-[1fr_auto] gap-4 px-4 py-3', index > 0 && 'border-t border-border')}
        >
          <span className="text-muted-foreground">{label}</span>
          <span className="tabular-nums text-foreground">
            {dollarsFromCents(cents, 6)} / {unit}
          </span>
        </div>
      ))}
    </div>
  )
}

function Billing() {
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const [rangeId, setRangeId] = useState<RangeId>('30d')
  const [rangeEnd, setRangeEnd] = useState(() => new Date())
  const isOwner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER
  const selectedRange = RANGE_OPTIONS.find((range) => range.id === rangeId) ?? RANGE_OPTIONS[3]
  const range = useMemo(
    () => ({
      from:
        selectedRange.milliseconds == null ? new Date(0) : new Date(rangeEnd.getTime() - selectedRange.milliseconds),
      to: rangeEnd,
    }),
    [rangeEnd, selectedRange.milliseconds],
  )
  const overviewQuery = useBillingOverviewQuery({
    organizationId: selectedOrganization?.id ?? '',
    from: range.from,
    to: range.to,
    enabled: Boolean(selectedOrganization && isOwner),
  })

  const selectRange = (nextRangeId: RangeId) => {
    setRangeId(nextRangeId)
    setRangeEnd(new Date())
  }

  return (
    <PageLayout>
      <PageHeader size="full" className="pb-3">
        <PageTitle className="font-mono text-[24px] font-semibold normal-case tracking-normal text-foreground sm:text-[28px]">
          Billing
        </PageTitle>
        {selectedOrganization ? (
          <span className="font-mono text-[11px] text-muted-foreground">org / {selectedOrganization.name}</span>
        ) : null}
      </PageHeader>

      <PageContent size="full" className="gap-7 font-mono">
        {!selectedOrganization ? (
          <StatePanel>Select an organization to view billing.</StatePanel>
        ) : !isOwner ? (
          <StatePanel>Only organization owners can view billing.</StatePanel>
        ) : overviewQuery.isLoading ? (
          <StatePanel>Loading billing data...</StatePanel>
        ) : overviewQuery.isError || !overviewQuery.data ? (
          <StatePanel tone="error">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>Billing data is unavailable.</span>
              <button
                type="button"
                onClick={() => overviewQuery.refetch()}
                className="inline-flex size-8 items-center justify-center border border-destructive/40 hover:bg-destructive/10"
                title="Retry"
              >
                <RefreshCw className="size-4" />
              </button>
            </div>
          </StatePanel>
        ) : (
          <>
            <section className="space-y-4">
              <SectionHeader
                title="Balance"
                right={
                  <span className="border border-border px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {overviewQuery.data.wallet.billingStatus.replace('_', ' ')}
                  </span>
                }
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Metric label="Current balance" value={dollarsFromCents(overviewQuery.data.wallet.totalBalanceCents)} />
                <Metric
                  label="Free balance"
                  value={dollarsFromCents(overviewQuery.data.wallet.freeBalanceCents)}
                  detail={
                    overviewQuery.data.wallet.freeExpiresAt
                      ? `Expires ${new Date(overviewQuery.data.wallet.freeExpiresAt).toLocaleDateString()}`
                      : undefined
                  }
                />
                <Metric label="Paid balance" value={dollarsFromCents(overviewQuery.data.wallet.paidBalanceCents)} />
                <Metric label="Spent this month" value={dollarsFromCents(overviewQuery.data.spentThisMonthCents)} />
              </div>
            </section>

            <section className="space-y-4">
              <SectionHeader
                title="Rated usage"
                right={
                  <div className="flex items-center border border-border bg-background">
                    {RANGE_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => selectRange(option.id)}
                        className={cn(
                          'h-8 min-w-10 border-l border-border px-2 text-[10px] first:border-l-0 sm:min-w-12',
                          option.id === rangeId
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:bg-card hover:text-foreground',
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setRangeEnd(new Date())}
                      className="inline-flex size-8 items-center justify-center border-l border-border text-muted-foreground hover:bg-card hover:text-foreground"
                      title="Refresh usage"
                    >
                      <RefreshCw className={cn('size-3.5', overviewQuery.isFetching && 'animate-spin')} />
                    </button>
                  </div>
                }
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Metric
                  label="Usage cost"
                  value={dollarsFromCents(overviewQuery.data.usage.costPreciseCents, 4)}
                  detail={`${overviewQuery.data.usage.periodCount} rated periods`}
                />
                <Metric label="CPU" value={`${hours(overviewQuery.data.usage.cpuSeconds)} vCPU hr`} />
                <Metric label="Memory" value={`${hours(overviewQuery.data.usage.memGibSeconds)} GiB hr`} />
                <Metric label="Disk" value={`${hours(overviewQuery.data.usage.diskGibSeconds)} GiB hr`} />
              </div>
              <UsageTrend buckets={overviewQuery.data.usageBuckets} />
            </section>

            <div className="grid grid-cols-1 gap-7 xl:grid-cols-2">
              <section className="space-y-4">
                <SectionHeader title={`Pricing v${overviewQuery.data.pricing.version}`} />
                <PricingTable overview={overviewQuery.data} />
              </section>

              <section className="space-y-4">
                <SectionHeader
                  title="Per-box limits"
                  right={
                    <Link to={RoutePath.LIMITS} className="text-[10px] text-muted-foreground hover:text-foreground">
                      View all limits
                    </Link>
                  }
                />
                <div className="grid grid-cols-1 border border-border bg-card sm:grid-cols-3">
                  {[
                    { icon: Cpu, label: 'CPU', value: `${selectedOrganization.maxCpuPerBox ?? '-'} vCPU` },
                    { icon: MemoryStick, label: 'Memory', value: `${selectedOrganization.maxMemoryPerBox ?? '-'} GiB` },
                    { icon: HardDrive, label: 'Disk', value: `${selectedOrganization.maxDiskPerBox ?? '-'} GiB` },
                  ].map(({ icon: Icon, label, value }, index) => (
                    <div
                      key={label}
                      className={cn('px-4 py-4', index > 0 && 'border-t border-border sm:border-l sm:border-t-0')}
                    >
                      <div className="mb-3 flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                        <Icon className="size-3.5" /> {label}
                      </div>
                      <div className="text-[15px] tabular-nums text-foreground">{value}</div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </>
        )}
      </PageContent>
    </PageLayout>
  )
}

export default Billing
