/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { MeteringPeriod, MeteringTotals } from '@/billing-api'
import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { Button } from '@/components/ui/button'
import { Database, RefreshCw } from '@/components/ui/icon'
import { useOrganizationMeteringQuery } from '@/hooks/queries/useOrganizationMeteringQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn } from '@/lib/utils'

function hours(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function duration(value: number): string {
  if (value < 60) {
    return `${Math.round(value)}s`
  }
  if (value < 3600) {
    return `${hours(value / 60)}m`
  }
  return `${hours(value / 3600)}h`
}

function formatDate(value: string | null): string {
  if (!value) {
    return 'open'
  }
  return new Date(value).toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function truncateId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

function SectionTitle({ title, count }: { title: string; count?: string }) {
  return (
    <div className="mb-4 flex items-center gap-3 px-[2px]">
      <span className="font-mono text-[11px] uppercase tracking-[1.5px] text-foreground">
        <span className="text-cyan-300">▸</span> {title}
      </span>
      {count ? <span className="font-mono text-[11px] text-muted-foreground">{count}</span> : null}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-card px-4 py-4">
      <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">{label}</div>
      <div className="mt-3 font-mono text-[20px] font-semibold leading-none text-foreground">{value}</div>
    </div>
  )
}

function totalsToCards(totals: MeteringTotals | undefined) {
  const safeTotals = totals ?? { cpuSeconds: 0, memGibSeconds: 0, diskGibSeconds: 0, gpuSeconds: 0 }
  return [
    { label: 'CPU allocation', value: `${hours(safeTotals.cpuSeconds / 3600)} vCPU·hr` },
    { label: 'Memory allocation', value: `${hours(safeTotals.memGibSeconds / 3600)} GiB·hr` },
    { label: 'Disk allocation', value: `${hours(safeTotals.diskGibSeconds / 3600)} GiB·hr` },
    { label: 'GPU allocation', value: `${hours(safeTotals.gpuSeconds / 3600)} GPU·hr` },
  ]
}

function sourceLabel(source: MeteringPeriod['source']): string {
  return source === 'box_usage_period' ? 'open ledger' : 'closed ledger'
}

function periodNote(period: MeteringPeriod): string | null {
  if (period.kind !== 'stopped' || period.endAt) {
    return null
  }

  return 'disk only'
}

function PeriodTable({
  title,
  description,
  periods,
}: {
  title: string
  description: string
  periods: MeteringPeriod[]
}) {
  return (
    <section>
      <SectionTitle title={title} count={`${periods.length}`} />
      <p className="mb-3 font-mono text-[11px] leading-5 text-muted-foreground">{description}</p>
      <div className="overflow-hidden border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse font-mono text-[12px]">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
                <th className="px-4 py-3 font-medium">Box</th>
                <th className="px-4 py-3 font-medium">Kind</th>
                <th className="px-4 py-3 font-medium">Window</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium">CPU</th>
                <th className="px-4 py-3 font-medium">Memory</th>
                <th className="px-4 py-3 font-medium">Disk</th>
                <th className="px-4 py-3 font-medium">GPU</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {periods.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={10}>
                    No periods
                  </td>
                </tr>
              ) : (
                periods.map((period) => (
                  <tr key={`${period.source}-${period.id}`} className="border-b border-border/70 last:border-b-0">
                    <td className="px-4 py-3 text-foreground">{truncateId(period.boxId)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex border px-2 py-1 text-[10px] uppercase tracking-[1px]',
                          period.kind === 'running'
                            ? 'border-cyan-500/40 text-cyan-300'
                            : 'border-muted-foreground/30 text-muted-foreground',
                        )}
                      >
                        {period.kind}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDate(period.startAt)} → {formatDate(period.endAt)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-foreground">{duration(period.durationSeconds)}</td>
                    <td className="px-4 py-3 tabular-nums">{period.cpu}</td>
                    <td className="px-4 py-3 tabular-nums">{period.mem} GiB</td>
                    <td className="px-4 py-3 tabular-nums">{period.disk} GiB</td>
                    <td className="px-4 py-3 tabular-nums">{period.gpu}</td>
                    <td className="px-4 py-3 text-muted-foreground">{sourceLabel(period.source)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{periodNote(period) ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function Metering() {
  const { selectedOrganization } = useSelectedOrganization()
  const organizationId = selectedOrganization?.id ?? ''
  const meteringQuery = useOrganizationMeteringQuery({
    organizationId,
    enabled: Boolean(organizationId),
    params: { limit: 500 },
  })
  const data = meteringQuery.data
  const cards = totalsToCards(data?.totals)

  return (
    <PageLayout>
      <PageHeader size="full">
        <PageTitle className="font-mono text-[28px] font-semibold normal-case tracking-[-0.02em] text-foreground">
          Metering
        </PageTitle>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto font-mono"
          onClick={() => void meteringQuery.refetch()}
          disabled={meteringQuery.isFetching}
        >
          <RefreshCw className={cn('size-3.5', meteringQuery.isFetching ? 'animate-spin' : '')} />
          Refresh
        </Button>
      </PageHeader>

      <PageContent size="full" className="gap-7">
        {!selectedOrganization ? (
          <div className="border border-border bg-card px-5 py-5 font-mono text-[13px] text-muted-foreground">
            Select an organization to view metering.
          </div>
        ) : meteringQuery.isLoading ? (
          <div className="border border-border bg-card px-5 py-5 font-mono text-[13px] text-muted-foreground">
            Loading metering data…
          </div>
        ) : meteringQuery.isError ? (
          <div className="border border-destructive/40 bg-card px-5 py-5 font-mono text-[13px] text-destructive">
            Metering data failed to load.
          </div>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {cards.map((card) => (
                <StatCard key={card.label} label={card.label} value={card.value} />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3 border border-border bg-card px-4 py-3 font-mono text-[12px] text-muted-foreground">
              <Database className="size-4 text-cyan-300" />
              <span>Organization {truncateId(data?.organizationId ?? organizationId)}</span>
              <span>
                Window {formatDate(data?.from ?? null)} → {formatDate(data?.to ?? null)}
              </span>
              <span>Periods {(data?.activePeriods.length ?? 0) + (data?.archivedPeriods.length ?? 0)}</span>
              <span>Open stopped rows keep metering disk only.</span>
            </div>

            <PeriodTable
              title="Open ledger periods"
              description="Rows whose end time is still open. Running rows meter CPU, memory, disk, and GPU; stopped rows only meter retained disk."
              periods={data?.activePeriods ?? []}
            />
            <PeriodTable
              title="Closed usage periods"
              description="Historical rows whose end time is fixed. These rows are the stable output of metering."
              periods={data?.archivedPeriods ?? []}
            />
          </>
        )}
      </PageContent>
    </PageLayout>
  )
}

export default Metering
