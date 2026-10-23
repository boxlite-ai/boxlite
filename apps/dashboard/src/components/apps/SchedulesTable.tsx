/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useRunSchedule } from '@/hooks/mutations/useAppMutations'
import { describeCron } from '@/lib/apps/cron'
import { relTime, STATUS, utcAndLocal, relFuture } from '@/lib/apps/format'
import type { AppDetail } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { useState } from 'react'
import { toast } from 'sonner'
import { GridHeader, GridRow, HoverActions, StatusBadge } from './spec'
import { ToolButton } from './SubNav'

// The scheduled jobs of the live release, one line each in the Overview's table style. The
// control plane calls each target as POST through the app's own URL (waking a sleeping Box), so
// "Run now" is exactly what the next tick does. The raw cron and the full times are on hover.

const GRID = 'grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_110px] gap-x-4'

function lastResult(status: number | null): { label: string; color: string } {
  if (status === null) return { label: 'Not run yet', color: STATUS.dim }
  return status < 400
    ? { label: `${status} OK`, color: STATUS.running }
    : { label: `${status} failed`, color: STATUS.error }
}

export function SchedulesTable({ app }: { app: AppDetail }) {
  const run = useRunSchedule()
  const [busy, setBusy] = useState<string | null>(null)
  const runNow = async (name: string) => {
    setBusy(name)
    try {
      const out = await run.mutateAsync({ appId: app.id, name })
      if (out.starting) toast.success(`${name}: the Box is waking up`, { description: 'The next tick runs it.' })
      else if (out.status < 400) toast.success(`${name} ran · ${out.status} in ${out.ms} ms`)
      else
        toast.error(`${name} answered ${out.status}`, {
          description: `POST ${app.schedules.find((s) => s.name === name)?.target}`,
        })
    } catch (error) {
      handleApiError(error, `Could not run ${name}`)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div>
      <GridHeader grid={GRID} columns={['Schedule', 'When', 'Next run', 'Last run', '']} />
      {app.schedules.map((s) => {
        const last = lastResult(s.lastStatus)
        return (
          <GridRow key={s.name} grid={GRID} className="min-h-[48px] py-0">
            <span className="flex min-w-0 items-baseline gap-2" title={`POST ${s.target}`}>
              <span className="font-semibold text-foreground">{s.name}</span>
              <span className="truncate text-[12px] text-muted-foreground">{s.target.replace(/^[^:]+:/, '')}</span>
            </span>
            <span className="truncate text-muted-foreground" title={s.cron}>
              {describeCron(s.cron)}
            </span>
            <span className="truncate text-muted-foreground" title={s.nextRun ? utcAndLocal(s.nextRun) : undefined}>
              {s.nextRun ? relFuture(s.nextRun) : 'when a deployment is live'}
            </span>
            <span className="flex min-w-0 items-center gap-2" title={s.lastRun ? utcAndLocal(s.lastRun) : undefined}>
              <StatusBadge label={last.label} color={last.color} caps />
              {s.lastRun && <span className="truncate text-[12px] text-muted-foreground">{relTime(s.lastRun)}</span>}
            </span>
            <HoverActions>
              <ToolButton loading={busy === s.name} disabled={!app.activeRelease} onClick={() => void runNow(s.name)}>
                Run now
              </ToolButton>
            </HoverActions>
          </GridRow>
        )
      })}
    </div>
  )
}
