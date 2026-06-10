/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import React, { useEffect, useMemo, useState } from 'react'
import { type AdminMachine, type AdminRunner, isOnlineRunner, runnerCpuPercent } from './adminHelpers'
import { AdminSectionFrame, AdminStateBadge } from './AdminPrimitives'
import { useAdminMachines, useAdminRunners, useAdminActions } from './useAdminData'

interface AdminFleetViewProps {
  query: string
  highlightRunnerId: string | null
  onShowRunnerBoxes: (runnerId: string) => void
  onDiagnoseRunner: (runner: AdminRunner) => void
  onDiagnoseMachine: (machine: AdminMachine) => void
}

interface ConfirmState {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => void
}

const AdminFleetView: React.FC<AdminFleetViewProps> = ({
  query,
  highlightRunnerId,
  onShowRunnerBoxes,
  onDiagnoseRunner,
  onDiagnoseMachine,
}) => {
  const runnersQuery = useAdminRunners()
  const machinesQuery = useAdminMachines()
  const { cordon, drain } = useAdminActions()
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const normalizedQuery = query.trim().toLowerCase()
  const runners = useMemo(() => {
    const allRunners = runnersQuery.data ?? []
    if (!normalizedQuery) return allRunners
    return allRunners.filter((runner) => {
      return (
        runner.id.toLowerCase().includes(normalizedQuery) ||
        runner.state.toLowerCase().includes(normalizedQuery) ||
        String(runner.currentStartedBoxes).includes(normalizedQuery)
      )
    })
  }, [runnersQuery.data, normalizedQuery])
  const online = useMemo(() => runners.filter(isOnlineRunner), [runners])
  const stale = useMemo(() => runners.filter((r) => !isOnlineRunner(r)), [runners])
  const machines = useMemo(() => {
    const allMachines = machinesQuery.data ?? []
    if (!normalizedQuery) return allMachines
    return allMachines.filter((machine) => {
      return (
        machine.host.toLowerCase().includes(normalizedQuery) || machine.region.toLowerCase().includes(normalizedQuery)
      )
    })
  }, [machinesQuery.data, normalizedQuery])

  useEffect(() => {
    if (!highlightRunnerId) return
    const el = document.getElementById(`admin-runner-${highlightRunnerId}`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlightRunnerId, runners])

  const renderRunnerRows = (rows: AdminRunner[], emptyText: string) =>
    rows.length > 0 ? (
      rows.map((r) => {
        const pct = Math.round(runnerCpuPercent(r) * 100)
        return (
          <TableRow
            key={r.id}
            id={`admin-runner-${r.id}`}
            className={cn(highlightRunnerId === r.id && 'bg-primary/10 transition-colors')}
          >
            <TableCell className="max-w-[8rem] truncate text-xs text-muted-foreground">{r.id}</TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <AdminStateBadge state={r.state} />
                {r.draining && (
                  <Badge variant="warning" className="w-fit">
                    draining
                  </Badge>
                )}
                {r.unschedulable && (
                  <Badge variant="secondary" className="w-fit">
                    cordoned
                  </Badge>
                )}
              </div>
            </TableCell>
            <TableCell className="tabular-nums">
              <span className="inline-flex items-baseline gap-1.5">
                <span>
                  {r.currentAllocatedCpu}/{r.cpu}
                </span>
                <span className={cn('text-xs', pct >= 80 ? 'text-destructive' : 'text-muted-foreground')}>{pct}%</span>
              </span>
            </TableCell>
            <TableCell className="tabular-nums">
              {r.currentAllocatedMemoryGiB.toFixed(1)}/{r.memory.toFixed(1)} GiB
            </TableCell>
            <TableCell>
              {r.currentStartedBoxes > 0 ? (
                <button
                  type="button"
                  className="tabular-nums text-primary hover:underline"
                  onClick={() => onShowRunnerBoxes(r.id)}
                >
                  {r.currentStartedBoxes}
                </button>
              ) : (
                <span className="tabular-nums text-muted-foreground">0</span>
              )}
            </TableCell>
            <TableCell className="tabular-nums">{r.availabilityScore?.toFixed(2) ?? '—'}</TableCell>
            <TableCell>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => onDiagnoseRunner(r)}>
                  Diagnose
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setConfirm({
                      title: r.unschedulable ? 'Un-cordon runner' : 'Cordon runner',
                      description: r.unschedulable
                        ? `Allow runner ${r.id} to accept new boxes again?`
                        : `Prevent runner ${r.id} from accepting new boxes? Existing boxes keep running.`,
                      confirmLabel: r.unschedulable ? 'Un-cordon runner' : 'Cordon runner',
                      onConfirm: () => cordon.mutate(r),
                    })
                  }
                >
                  {r.unschedulable ? 'Un-cordon' : 'Cordon'}
                </Button>
                {!r.draining && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() =>
                      setConfirm({
                        title: 'Drain runner',
                        description: `Drain runner ${r.id}? Scheduling stops immediately and existing boxes are migrated away.`,
                        confirmLabel: 'Drain runner',
                        onConfirm: () => drain.mutate(r.id),
                      })
                    }
                  >
                    Drain
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        )
      })
    ) : (
      <TableRow>
        <TableCell colSpan={7} className="h-20 text-center text-muted-foreground">
          {emptyText}
        </TableCell>
      </TableRow>
    )

  const runnerHeader = (
    <TableHeader>
      <TableRow>
        <TableHead>Runner</TableHead>
        <TableHead>State</TableHead>
        <TableHead>CPU alloc</TableHead>
        <TableHead>Mem alloc</TableHead>
        <TableHead>Boxes</TableHead>
        <TableHead>Score</TableHead>
        <TableHead className="text-right">Actions</TableHead>
      </TableRow>
    </TableHeader>
  )

  return (
    <div className="space-y-6">
      <AdminSectionFrame
        title="Runners"
        description="Scheduling surface for online, stale, cordoned, and draining runners."
        action={<Badge variant="success">{online.length} online</Badge>}
      >
        {runnersQuery.isPending ? (
          <Skeleton className="h-40 rounded-md" />
        ) : (
          <>
            <div className="overflow-hidden rounded-md border border-border">
              <Table>
                {runnerHeader}
                <TableBody>{renderRunnerRows(online, 'No online runners.')}</TableBody>
              </Table>
            </div>

            {stale.length > 0 && (
              <Accordion type="single" collapsible className="rounded-md border border-border px-4">
                <AccordionItem value="stale" className="border-0">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex flex-col items-start gap-0.5">
                      <span className="text-sm font-medium">Unresponsive &amp; stale</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {stale.length} runners outside READY state
                      </span>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="overflow-hidden rounded-md border border-border">
                      <Table>
                        {runnerHeader}
                        <TableBody>{renderRunnerRows(stale, 'No stale runners.')}</TableBody>
                      </Table>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}
          </>
        )}
      </AdminSectionFrame>

      <AdminSectionFrame title="Machines" description="Capacity and oversell per host. Oversell > 1.0x is flagged.">
        {machinesQuery.isPending ? (
          <Skeleton className="h-32 rounded-md" />
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Host</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Oversell CPU</TableHead>
                  <TableHead>CPU waterline</TableHead>
                  <TableHead>Mem waterline</TableHead>
                  <TableHead>Boxes</TableHead>
                  <TableHead className="text-right">Diagnose</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {machines.length > 0 ? (
                  machines.map((m) => (
                    <TableRow key={m.host}>
                      <TableCell className="text-xs">{m.host}</TableCell>
                      <TableCell>{m.region}</TableCell>
                      <TableCell className="tabular-nums">
                        {m.oversellCpu.toFixed(1)}×
                        {m.oversellCpu > 1 && (
                          <Badge variant="warning" className="ml-2">
                            over
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">{m.cpuWaterline.toFixed(1)}%</TableCell>
                      <TableCell className="tabular-nums">{m.memWaterline.toFixed(1)}%</TableCell>
                      <TableCell className="tabular-nums">{m.boxes}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => onDiagnoseMachine(m)}>
                          Diagnose
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7} className="h-20 text-center text-muted-foreground">
                      {normalizedQuery ? 'No machines match the current search.' : 'No machines found.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </AdminSectionFrame>

      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirm?.onConfirm()
                setConfirm(null)
              }}
            >
              {confirm?.confirmLabel ?? 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default AdminFleetView
