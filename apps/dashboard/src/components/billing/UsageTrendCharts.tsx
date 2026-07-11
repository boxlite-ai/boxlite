/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingUsageBucket, BillingUsageSummary } from '@/billing-api'
import { AsciiStatCard } from './ascii'

type MetricKey = 'costPreciseCents' | 'cpuSeconds' | 'memGibSeconds' | 'diskGibSeconds'

function numberValue(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatAmount(value: string, divisor: number, maximumFractionDigits = 2): string {
  return (numberValue(value) / divisor).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits,
  })
}

function series(buckets: BillingUsageBucket[], key: MetricKey, divisor: number) {
  return buckets.map((bucket) => ({ value: numberValue(bucket[key]) / divisor }))
}

function trend(buckets: BillingUsageBucket[], key: MetricKey): number | undefined {
  if (buckets.length < 2) return undefined
  const midpoint = Math.floor(buckets.length / 2)
  const previous = buckets.slice(0, midpoint).reduce((total, bucket) => total + numberValue(bucket[key]), 0)
  const current = buckets.slice(midpoint).reduce((total, bucket) => total + numberValue(bucket[key]), 0)
  if (previous <= 0) return undefined
  return Math.round(((current - previous) / previous) * 100)
}

export function UsageTrendCharts({ usage, buckets }: { usage: BillingUsageSummary; buckets: BillingUsageBucket[] }) {
  return (
    <div data-testid="billing-usage-summary" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <AsciiStatCard
        id="cost"
        label="Usage Cost"
        prefix="$"
        value={formatAmount(usage.costPreciseCents, 100, 4)}
        trendPct={trend(buckets, 'costPreciseCents')}
        data={series(buckets, 'costPreciseCents', 100)}
      />
      <AsciiStatCard
        id="cpu"
        label="vCPU Hours"
        value={formatAmount(usage.cpuSeconds, 3600)}
        unit="hrs"
        trendPct={trend(buckets, 'cpuSeconds')}
        data={series(buckets, 'cpuSeconds', 3600)}
      />
      <AsciiStatCard
        id="memory"
        label="RAM Hours"
        value={formatAmount(usage.memGibSeconds, 3600)}
        unit="GiB·hr"
        trendPct={trend(buckets, 'memGibSeconds')}
        data={series(buckets, 'memGibSeconds', 3600)}
      />
      <AsciiStatCard
        id="disk"
        label="Disk Hours"
        value={formatAmount(usage.diskGibSeconds, 3600)}
        unit="GiB·hr"
        trendPct={trend(buckets, 'diskGibSeconds')}
        data={series(buckets, 'diskGibSeconds', 3600)}
      />
    </div>
  )
}
