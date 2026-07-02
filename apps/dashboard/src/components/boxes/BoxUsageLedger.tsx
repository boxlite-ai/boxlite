/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useBoxUsagePeriodsQuery, useBoxUsageQuery } from '@/hooks/queries/useBoxUsageQuery'
import { formatUsageSeconds, formatUsageTimestamp } from '@/lib/usage-verification'
import { RefreshCw } from '@/components/ui/icon'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function BoxUsageLedger({ boxId }: { boxId: string }) {
  const periodsQuery = useBoxUsagePeriodsQuery(boxId, true)
  const usageQuery = useBoxUsageQuery(boxId, true)

  const refresh = () => {
    periodsQuery.refetch()
    usageQuery.refetch()
  }

  return (
    <div className="mt-4 border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">usage_period</div>
        <button
          type="button"
          onClick={refresh}
          title="refresh usage"
          className="flex size-7 items-center justify-center border border-border transition-colors hover:bg-background"
        >
          <RefreshCw
            className={periodsQuery.isFetching || usageQuery.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'}
          />
        </button>
      </div>

      <div className="mt-3 overflow-x-auto border border-border">
        <table className="w-full min-w-[720px] border-collapse font-mono text-[11px]">
          <thead className="bg-background text-muted-foreground">
            <tr>
              <th className="border-b border-border px-2 py-2 text-left font-medium">kind</th>
              <th className="border-b border-border px-2 py-2 text-left font-medium">periodStart</th>
              <th className="border-b border-border px-2 py-2 text-left font-medium">periodEnd</th>
              <th className="border-b border-border px-2 py-2 text-right font-medium">cpu</th>
              <th className="border-b border-border px-2 py-2 text-right font-medium">mem</th>
              <th className="border-b border-border px-2 py-2 text-right font-medium">disk</th>
            </tr>
          </thead>
          <tbody>
            {periodsQuery.data?.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-b-0">
                <td className="px-2 py-2">{row.kind}</td>
                <td className="px-2 py-2">{formatUsageTimestamp(row.periodStart)}</td>
                <td className="px-2 py-2">{formatUsageTimestamp(row.periodEnd)}</td>
                <td className="px-2 py-2 text-right">{row.allocCpu}</td>
                <td className="px-2 py-2 text-right">{row.allocMemGib}</td>
                <td className="px-2 py-2 text-right">{row.allocDiskGib}</td>
              </tr>
            ))}
            {periodsQuery.data?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                  No usage_period rows
                </td>
              </tr>
            )}
            {periodsQuery.isError && (
              <tr>
                <td colSpan={6} className="px-2 py-3 text-destructive">
                  {errorText(periodsQuery.error)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">
        GET /api/usage/box/{boxId}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px]">
        <div className="border border-border bg-background p-2">
          <div className="text-muted-foreground">CPU seconds</div>
          <div className="mt-1 text-foreground">{formatUsageSeconds(usageQuery.data?.totalCPUSeconds)}</div>
        </div>
        <div className="border border-border bg-background p-2">
          <div className="text-muted-foreground">RAM GB seconds</div>
          <div className="mt-1 text-foreground">{formatUsageSeconds(usageQuery.data?.totalRAMGBSeconds)}</div>
        </div>
        <div className="border border-border bg-background p-2">
          <div className="text-muted-foreground">Disk GB seconds</div>
          <div className="mt-1 text-foreground">{formatUsageSeconds(usageQuery.data?.totalDiskGBSeconds)}</div>
        </div>
      </div>
      <pre className="mt-2 max-h-[190px] overflow-auto whitespace-pre-wrap break-words border border-border bg-background p-2 font-mono text-[11px]">
        {usageQuery.isError ? errorText(usageQuery.error) : JSON.stringify(usageQuery.data ?? null, null, 2)}
      </pre>
    </div>
  )
}
