/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, SectionTitle } from '@/components/ascii'
import { BalanceLowBanner } from '@/components/billing/BalanceLowBanner'
import { CostOverTime } from '@/components/billing/CostOverTime'
import { ConcurrencyTimeline } from '@/components/billing/ConcurrencyTimeline'
import { ThisCycleCard } from '@/components/billing/ThisCycleCard'
import { AggregatedUsageChart, ResourceUsageBreakdown, UsageSummary } from '@/components/spending/AggregatedUsageChart'
import { BoxUsageTable } from '@/components/spending/BoxUsageTable'
import { Button } from '@/components/ui/button'
import { DateRangePicker, QuickRangesConfig } from '@/components/ui/date-range-picker'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import { FeatureFlags } from '@/enums/FeatureFlags'
import { useAggregatedUsage, useBoxesUsage } from '@/hooks/queries/useAnalyticsUsage'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { addDays, differenceInCalendarDays, subDays } from 'date-fns'
import { AlertCircle, BarChart3, RefreshCw } from '@/components/ui/icon'
import { useFeatureFlagEnabled } from 'posthog-js/react'
import { useCallback, useState } from 'react'
import { DateRange } from 'react-day-picker'

const analyticsQuickRanges: QuickRangesConfig = {
  hours: [1, 6, 12, 24],
  days: [7, 14, 30],
}

/**
 * The Usage tab, on the billing service's own numbers (Subscription.md v2):
 * a low-balance warning, the current cycle's quota meter, and cost split by
 * who funded it — then the analytics-backed resource sections when an
 * analytics deployment exists. Everything shown is served state; sections
 * whose data has no API stay absent rather than invented.
 */
export function UsageSection({ onGoToWallet }: { onGoToWallet: () => void }) {
  const { selectedOrganization } = useSelectedOrganization()
  const config = useConfig()
  const spendingEnabled = useFeatureFlagEnabled(FeatureFlags.BOX_SPENDING)
  const analyticsAvailable = spendingEnabled && !!config.analyticsApiUrl

  const [analyticsDateRange, setAnalyticsDateRange] = useState<DateRange>(() => {
    const now = new Date()
    return { from: subDays(now, 30), to: now }
  })

  const handleAnalyticsDateRangeChange = useCallback((range: DateRange) => {
    if (range.from && range.to) {
      const days = differenceInCalendarDays(range.to, range.from)
      if (days > 30) {
        setAnalyticsDateRange({ from: range.from, to: addDays(range.from, 30) })
        return
      }
    }
    setAnalyticsDateRange(range)
  }, [])

  const analyticsParams = {
    from: analyticsDateRange.from ?? subDays(new Date(), 30),
    to: analyticsDateRange.to ?? new Date(),
    enabled: analyticsAvailable && !!selectedOrganization,
  }

  const {
    data: aggregatedUsage,
    isLoading: aggregatedLoading,
    isError: aggregatedError,
    refetch: refetchAggregated,
  } = useAggregatedUsage(analyticsParams)
  const {
    data: boxesUsage,
    isLoading: boxesLoading,
    isError: boxesError,
    refetch: refetchBoxes,
  } = useBoxesUsage(analyticsParams)

  return (
    <div className="flex flex-col gap-8">
      <BalanceLowBanner onGoToWallet={onGoToWallet} />
      <ThisCycleCard />
      <CostOverTime />
      <ConcurrencyTimeline />

      {analyticsAvailable && (
        <>
          <section>
            <SectionTitle
              title="Resource Usage"
              right={
                <DateRangePicker
                  value={analyticsDateRange}
                  onChange={handleAnalyticsDateRangeChange}
                  quickRangesEnabled
                  quickRanges={analyticsQuickRanges}
                  timeSelection
                  defaultSelectedQuickRange="Last 30 days"
                  className="w-auto"
                  contentAlign="end"
                />
              }
            />
            <Panel>
              {aggregatedError ? (
                <Empty className="py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon" className="bg-destructive-background text-destructive">
                      <AlertCircle />
                    </EmptyMedia>
                    <EmptyTitle className="text-destructive">Failed to load resource usage</EmptyTitle>
                    <EmptyDescription>
                      Something went wrong while fetching usage data. Please try again.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="secondary" size="sm" onClick={() => refetchAggregated()}>
                      <RefreshCw />
                      Retry
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : !aggregatedLoading && !aggregatedUsage?.boxCount ? (
                <Empty className="py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <BarChart3 />
                    </EmptyMedia>
                    <EmptyTitle>No resource usage data</EmptyTitle>
                    <EmptyDescription>
                      Usage data will appear here once your boxes start consuming resources in the selected time range.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <>
                  <UsageSummary data={aggregatedUsage} isLoading={aggregatedLoading} />
                  <Separator />
                  <AggregatedUsageChart data={aggregatedUsage} isLoading={aggregatedLoading} />
                  <Separator />
                  <ResourceUsageBreakdown data={aggregatedUsage} />
                </>
              )}
            </Panel>
          </section>

          <section>
            <SectionTitle title="Per-Box Usage" count={boxesUsage?.length ? `${boxesUsage.length} boxes` : undefined} />
            <Panel>
              {boxesError ? (
                <Empty className="py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon" className="bg-destructive-background text-destructive">
                      <AlertCircle />
                    </EmptyMedia>
                    <EmptyTitle className="text-destructive">Failed to load box usage</EmptyTitle>
                    <EmptyDescription>
                      Something went wrong while fetching per-box data. Please try again.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="secondary" size="sm" onClick={() => refetchBoxes()}>
                      <RefreshCw />
                      Retry
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : !boxesLoading && !boxesUsage?.length ? (
                <Empty className="py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <BarChart3 />
                    </EmptyMedia>
                    <EmptyTitle>No box usage yet</EmptyTitle>
                    <EmptyDescription>
                      Once you create and run a box, its resource consumption will appear here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <BoxUsageTable data={boxesUsage} isLoading={boxesLoading} />
              )}
            </Panel>
          </section>
        </>
      )}
    </div>
  )
}
