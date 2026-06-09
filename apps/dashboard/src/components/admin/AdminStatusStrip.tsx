/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import React, { useMemo } from 'react'
import { getBoxBreakdown } from './adminHelpers'
import { BreakdownBar, BreakdownLegend } from './AdminPrimitives'
import { useAdminBoxes, useAdminOverview } from './useAdminData'

function KpiCard({ children }: { children: React.ReactNode }) {
  return <Card className="p-0">{children}</Card>
}

function formatCpuPercent(cpuUtil: number): string {
  const percent = Math.max(cpuUtil * 100, 0)
  if (percent === 0) return '0%'
  if (percent > 0 && percent < 0.1) return '<0.1%'
  return `${percent.toFixed(1)}%`
}

function cpuBarWidthPercent(cpuUtil: number): number {
  const percent = Math.min(Math.max(cpuUtil * 100, 0), 100)
  if (percent === 0) return 0
  return Math.max(percent, 3)
}

const AdminStatusStrip: React.FC = () => {
  const overviewQuery = useAdminOverview()
  const boxesQuery = useAdminBoxes()
  const boxes = boxesQuery.data ?? []
  const breakdown = useMemo(() => getBoxBreakdown(boxes), [boxes])
  const overview = overviewQuery.data
  const clusterCpuBarWidth = overview ? cpuBarWidthPercent(overview.cluster.cpuUtil) : 0

  if (overviewQuery.isPending || !overview) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <KpiCard>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Users</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-medium tabular-nums">{overview.users}</p>
          <p className="mt-1 text-xs text-muted-foreground">across all orgs</p>
        </CardContent>
      </KpiCard>

      <KpiCard>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Boxes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-3xl font-medium tabular-nums">
            {overview.activeBoxes}{' '}
            <span className="text-sm font-normal text-muted-foreground">active · {overview.boxes.total} total</span>
          </p>
          {boxes.length > 0 && (
            <>
              <BreakdownBar segments={breakdown} total={boxes.length} className="h-2" />
              <BreakdownLegend segments={breakdown} />
            </>
          )}
        </CardContent>
      </KpiCard>

      <KpiCard>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Runners</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-medium tabular-nums">
            {overview.runners.online}{' '}
            <span className="text-sm font-normal text-muted-foreground">/ {overview.runners.total} online</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {overview.runners.draining > 0 ? `${overview.runners.draining} draining` : 'none draining'}
          </p>
        </CardContent>
      </KpiCard>

      <KpiCard>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Cluster CPU</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-medium tabular-nums">{formatCpuPercent(overview.cluster.cpuUtil)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {overview.cluster.oversell.toFixed(1)}x oversell · online runners
          </p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${clusterCpuBarWidth}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
            <span>0</span>
            <span>100%</span>
          </div>
        </CardContent>
      </KpiCard>
    </div>
  )
}

export default AdminStatusStrip
