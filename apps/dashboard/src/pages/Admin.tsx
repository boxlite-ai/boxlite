/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { handleApiError } from '@/lib/error-handling'
import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RoutePath } from '@/enums/RoutePath'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import React, { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { toast } from 'sonner'

// ─── Types (not in generated api-client for these admin-only endpoints) ───────

interface AdminOverview {
  users: number
  activeBoxes: number
  boxes: {
    total: number
    byState: Record<string, number>
  }
  runners: { online: number; total: number; draining: number }
  cluster: { cpuUtil: number; oversell: number }
}

interface AdminUser {
  id: string
  email: string
  name: string
  role: string
}

interface AdminBox {
  id: string
  organizationId: string
  state: string
  runnerId: string | null
  cpu: number
  memoryGiB: number
  createdAt: string
  owner: {
    name: string
    email: string
    orgName: string
    personal: boolean
  }
}

interface AdminRunner {
  id: string
  state: string
  cpu: number
  memory: number
  currentAllocatedCpu: number
  currentAllocatedMemoryGiB: number
  currentStartedSandboxes: number
  availabilityScore: number
  draining: boolean
  unschedulable: boolean
}

interface AdminMachine {
  host: string
  region: string
  oversellCpu: number
  cpuWaterline: number
  memWaterline: number
  sandboxes: number
}

// ─── Confirmation dialog state ────────────────────────────────────────────────

interface ConfirmAction {
  title: string
  description: string
  onConfirm: () => Promise<unknown>
}

// ─── KPI card skeleton ────────────────────────────────────────────────────────

function KpiSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-16" />
      </CardContent>
    </Card>
  )
}

// ─── Table skeleton ───────────────────────────────────────────────────────────

function TableSkeleton({ cols }: { cols: number }) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: cols }).map((_, i) => (
              <TableHead key={i}>
                <Skeleton className="h-4 w-20" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              {Array.from({ length: cols }).map((_, j) => (
                <TableCell key={j}>
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ─── State badge ──────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: string }) {
  const lower = state?.toLowerCase() ?? ''
  const variant =
    lower === 'running' || lower === 'online' || lower === 'started'
      ? 'success'
      : lower === 'error' || lower === 'failed'
        ? 'destructive'
        : lower === 'draining' || lower === 'stopping'
          ? 'warning'
          : 'secondary'
  return <Badge variant={variant}>{state}</Badge>
}

const boxBreakdownPalette = {
  started: '#5aac7b',
  error: '#dd7d70',
  buildFailed: '#d6a84f',
  stopped: '#838b97',
  other: '#444a54',
}

function getBoxBreakdown(boxes: AdminOverview['boxes']) {
  const started = boxes.byState.started ?? 0
  const error = boxes.byState.error ?? 0
  const buildFailed = boxes.byState.build_failed ?? 0
  const stopped = boxes.byState.stopped ?? 0
  const knownTotal = started + error + buildFailed + stopped
  const other = Math.max(boxes.total - knownTotal, 0)

  return [
    { key: 'started', label: 'started', count: started, color: boxBreakdownPalette.started },
    { key: 'error', label: 'error', count: error, color: boxBreakdownPalette.error },
    { key: 'build_failed', label: 'build failed', count: buildFailed, color: boxBreakdownPalette.buildFailed },
    { key: 'stopped', label: 'stopped', count: stopped, color: boxBreakdownPalette.stopped },
    { key: 'other', label: 'other', count: other, color: boxBreakdownPalette.other },
  ].filter((segment) => segment.count > 0)
}

function getBoxBreakdownFromRows(boxes: AdminBox[]) {
  const byState = boxes.reduce<Record<string, number>>((acc, box) => {
    acc[box.state] = (acc[box.state] ?? 0) + 1
    return acc
  }, {})

  return getBoxBreakdown({ total: boxes.length, byState })
}

function getBoxOwnerGroups(boxes: AdminBox[]) {
  const groups = new Map<string, { owner: AdminBox['owner']; boxes: AdminBox[] }>()

  for (const box of boxes) {
    const existing = groups.get(box.organizationId)
    if (existing) {
      existing.boxes.push(box)
    } else {
      groups.set(box.organizationId, { owner: box.owner, boxes: [box] })
    }
  }

  return Array.from(groups.entries())
    .map(([organizationId, group]) => ({
      organizationId,
      owner: group.owner,
      boxes: group.boxes,
      breakdown: getBoxBreakdownFromRows(group.boxes),
    }))
    .sort((a, b) => a.owner.name.localeCompare(b.owner.name))
}

function getBoxRollupText(boxes: AdminBox[]) {
  const counts = boxes.reduce<Record<string, number>>((acc, box) => {
    acc[box.state] = (acc[box.state] ?? 0) + 1
    return acc
  }, {})
  const parts = [
    { label: 'started', count: counts.started ?? 0 },
    { label: 'error', count: counts.error ?? 0 },
    { label: 'build failed', count: counts.build_failed ?? 0 },
  ].filter((part) => part.count > 0)

  return parts.length > 0 ? parts.map((part) => `${part.count} ${part.label}`).join(' · ') : 'no active states'
}

function isReadyRunner(runner: AdminRunner) {
  return runner.state?.toLowerCase() === 'ready'
}

// ─── Main component ───────────────────────────────────────────────────────────

const Admin: React.FC = () => {
  const { axiosInstance } = useApi()
  const queryClient = useQueryClient()
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // ─── Queries ───────────────────────────────────────────────────────────────

  const overviewQuery = useQuery<AdminOverview>({
    queryKey: ['admin', 'overview'],
    queryFn: () => axiosInstance.get('/admin/overview').then((r) => r.data),
    retry: false,
  })

  const usersQuery = useQuery<AdminUser[]>({
    queryKey: ['admin', 'users'],
    queryFn: () => axiosInstance.get('/admin/overview/users').then((r) => r.data),
  })

  const boxesQuery = useQuery<AdminBox[]>({
    queryKey: ['admin', 'boxes'],
    queryFn: () => axiosInstance.get('/admin/overview/boxes').then((r) => r.data),
  })

  const runnersQuery = useQuery<AdminRunner[]>({
    queryKey: ['admin', 'runners'],
    queryFn: () => axiosInstance.get('/admin/overview/runners').then((r) => r.data),
  })

  const machinesQuery = useQuery<AdminMachine[]>({
    queryKey: ['admin', 'machines'],
    queryFn: () => axiosInstance.get('/admin/overview/machines').then((r) => r.data),
  })

  // ─── Mutations ─────────────────────────────────────────────────────────────

  const cordonMutation = useMutation({
    mutationFn: (runner: AdminRunner) =>
      axiosInstance.patch(`/admin/runners/${runner.id}/scheduling`, { unschedulable: !runner.unschedulable }),
    onSuccess: () => {
      toast.success('Runner cordoned')
      queryClient.invalidateQueries({ queryKey: ['admin', 'runners'] })
    },
    onError: (error) => handleApiError(error, 'Failed to cordon runner'),
  })

  const drainMutation = useMutation({
    mutationFn: (runnerId: string) => axiosInstance.patch(`/admin/runners/${runnerId}/draining`, { draining: true }),
    onSuccess: () => {
      toast.success('Runner draining')
      queryClient.invalidateQueries({ queryKey: ['admin', 'runners'] })
    },
    onError: (error) => handleApiError(error, 'Failed to drain runner'),
  })

  const recoverMutation = useMutation({
    mutationFn: (sandboxId: string) => axiosInstance.post(`/admin/sandbox/${sandboxId}/recover`),
    onSuccess: () => {
      toast.success('Sandbox recovery initiated')
      queryClient.invalidateQueries({ queryKey: ['admin', 'boxes'] })
    },
    onError: (error) => handleApiError(error, 'Failed to recover sandbox'),
  })

  // ─── 403 gate: redirect non-admins ────────────────────────────────────────

  const boxBreakdown = overviewQuery.data ? getBoxBreakdown(overviewQuery.data.boxes) : []
  const runners = runnersQuery.data ?? []
  const onlineRunners = runners.filter(isReadyRunner)
  const staleRunners = runners.filter((runner) => !isReadyRunner(runner))
  const boxOwnerGroups = boxesQuery.data ? getBoxOwnerGroups(boxesQuery.data) : []

  if (overviewQuery.isError && (overviewQuery.error as { response?: { status?: number } })?.response?.status === 403) {
    return <Navigate to={RoutePath.DASHBOARD} replace />
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const openConfirm = (action: ConfirmAction) => {
    setConfirmAction(action)
    setConfirmOpen(true)
  }

  const handleConfirm = async () => {
    if (!confirmAction) return
    await confirmAction.onConfirm()
    setConfirmOpen(false)
    setConfirmAction(null)
  }

  const isErrorState = (state: string) => {
    const lower = state?.toLowerCase() ?? ''
    return lower === 'error' || lower === 'failed'
  }

  const renderRunnerTable = (runnerRows: AdminRunner[], emptyText: string) => (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>State</TableHead>
            <TableHead>CPU alloc</TableHead>
            <TableHead>Mem alloc</TableHead>
            <TableHead>Sandboxes</TableHead>
            <TableHead>Score</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runnerRows.length > 0 ? (
            runnerRows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[8rem]">{r.id}</TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <StateBadge state={r.state} />
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
                <TableCell>
                  {r.currentAllocatedCpu}/{r.cpu}
                </TableCell>
                <TableCell>
                  {r.currentAllocatedMemoryGiB.toFixed(1)}/{r.memory}
                </TableCell>
                <TableCell>{r.currentStartedSandboxes}</TableCell>
                <TableCell>{r.availabilityScore?.toFixed(2) ?? '—'}</TableCell>
                <TableCell>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        openConfirm({
                          title: r.unschedulable ? 'Un-cordon runner' : 'Cordon runner',
                          description: r.unschedulable
                            ? `Allow runner ${r.id} to accept new sandboxes again?`
                            : `Prevent runner ${r.id} from accepting new sandboxes?`,
                          onConfirm: () => cordonMutation.mutateAsync(r),
                        })
                      }
                    >
                      {r.unschedulable ? 'Un-cordon' : 'Cordon'}
                    </Button>
                    {!r.draining && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() =>
                          openConfirm({
                            title: 'Drain runner',
                            description: `Drain runner ${r.id}? Existing sandboxes will be migrated away.`,
                            onConfirm: () => drainMutation.mutateAsync(r.id),
                          })
                        }
                      >
                        Drain
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                {emptyText}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )

  const renderBoxesTable = (boxRows: AdminBox[]) => (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>State</TableHead>
            <TableHead>CPU</TableHead>
            <TableHead>Mem (GiB)</TableHead>
            <TableHead>Runner</TableHead>
            <TableHead>Created</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {boxRows.map((b) => (
            <TableRow key={b.id}>
              <TableCell>
                <StateBadge state={b.state} />
              </TableCell>
              <TableCell>{b.cpu}</TableCell>
              <TableCell>{b.memoryGiB}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[8rem]">
                {b.runnerId ?? '—'}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{new Date(b.createdAt).toLocaleString()}</TableCell>
              <TableCell>
                {isErrorState(b.state) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      openConfirm({
                        title: 'Recover sandbox',
                        description: `Recover sandbox ${b.id} from error state?`,
                        onConfirm: () => recoverMutation.mutateAsync(b.id),
                      })
                    }
                  >
                    Recover
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <PageLayout>
      <PageHeader size="full">
        <PageTitle>Admin</PageTitle>
      </PageHeader>

      <PageContent size="full">
        {/* KPI cards */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {overviewQuery.isPending ? (
            <>
              <KpiSkeleton />
              <KpiSkeleton />
              <KpiSkeleton />
              <KpiSkeleton />
            </>
          ) : overviewQuery.data ? (
            <>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Users</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{overviewQuery.data.users}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    Boxes
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      total + breakdown
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-2xl font-bold">
                    {overviewQuery.data.activeBoxes}{' '}
                    <span className="text-sm font-normal text-muted-foreground">
                      active · {overviewQuery.data.boxes.total} total
                    </span>
                  </p>
                  {overviewQuery.data.boxes.total > 0 && (
                    <>
                      <div className="flex h-2 overflow-hidden rounded-full bg-muted/40">
                        {boxBreakdown.map((segment) => (
                          <div
                            key={segment.key}
                            className="h-full"
                            style={{
                              width: `${(segment.count / overviewQuery.data.boxes.total) * 100}%`,
                              backgroundColor: segment.color,
                            }}
                          />
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {boxBreakdown.map((segment) => (
                          <span key={segment.key} className="inline-flex items-center gap-1">
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: segment.color }} />
                            {segment.count} {segment.label}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Runners {overviewQuery.data.runners.online}/{overviewQuery.data.runners.total}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{overviewQuery.data.runners.online} online</p>
                  {overviewQuery.data.runners.draining > 0 && (
                    <p className="text-xs text-muted-foreground">{overviewQuery.data.runners.draining} draining</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Cluster CPU</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{(overviewQuery.data.cluster.cpuUtil * 100).toFixed(1)}%</p>
                  <p className="text-xs text-muted-foreground">
                    oversell {overviewQuery.data.cluster.oversell.toFixed(1)}x
                  </p>
                </CardContent>
              </Card>
            </>
          ) : null}
        </div>

        {/* Data tabs */}
        <Tabs defaultValue="users">
          <TabsList variant="underline">
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="boxes">Boxes</TabsTrigger>
            <TabsTrigger value="runners">Runners</TabsTrigger>
            <TabsTrigger value="machines">Machines</TabsTrigger>
          </TabsList>

          {/* ── Users tab ── */}
          <TabsContent value="users">
            {usersQuery.isPending ? (
              <TableSkeleton cols={4} />
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead className="font-mono text-xs">ID</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usersQuery.data && usersQuery.data.length > 0 ? (
                      usersQuery.data.map((u) => (
                        <TableRow key={u.id}>
                          <TableCell>{u.name}</TableCell>
                          <TableCell>{u.email}</TableCell>
                          <TableCell>
                            <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>{u.role}</Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground truncate max-w-[10rem]">
                            {u.id}
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                          No users found.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* ── Boxes tab ── */}
          <TabsContent value="boxes">
            {boxesQuery.isPending ? (
              <TableSkeleton cols={6} />
            ) : boxOwnerGroups.length > 0 ? (
              <Accordion
                type="multiple"
                defaultValue={boxOwnerGroups.map((group) => group.organizationId)}
                className="space-y-3"
              >
                {boxOwnerGroups.map((group) => (
                  <AccordionItem
                    key={group.organizationId}
                    value={group.organizationId}
                    className="rounded-md border bg-card px-4"
                  >
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex w-full flex-col gap-3 pr-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 text-left">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium">{group.owner.name}</span>
                            <Badge variant="secondary" className="text-[10px] font-normal">
                              {group.owner.personal ? 'personal' : 'team'}
                            </Badge>
                          </div>
                          <p className="truncate text-xs font-normal text-muted-foreground">
                            {group.owner.email || group.owner.orgName}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col gap-2 text-left sm:text-right">
                          <p className="text-xs font-normal text-muted-foreground">
                            {getBoxRollupText(group.boxes)} · {group.boxes.length} total
                          </p>
                          <div className="flex h-1.5 w-36 overflow-hidden rounded-full bg-muted/40 sm:ml-auto">
                            {group.breakdown.map((segment) => (
                              <div
                                key={segment.key}
                                className="h-full"
                                style={{
                                  width: `${(segment.count / group.boxes.length) * 100}%`,
                                  backgroundColor: segment.color,
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>{renderBoxesTable(group.boxes)}</AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableBody>
                    <TableRow>
                      <TableCell className="h-24 text-center text-muted-foreground">No boxes found.</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* ── Runners tab ── */}
          <TabsContent value="runners">
            {runnersQuery.isPending ? (
              <TableSkeleton cols={7} />
            ) : runners.length > 0 ? (
              <div className="space-y-4">
                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-medium">Online & active</h2>
                      <p className="text-xs text-muted-foreground">READY runners accepting work</p>
                    </div>
                    <Badge variant="success">{onlineRunners.length} online</Badge>
                  </div>
                  {renderRunnerTable(onlineRunners, 'No online runners.')}
                </section>

                <Accordion type="single" collapsible className="rounded-md border px-4">
                  <AccordionItem value="stale">
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex flex-col items-start gap-1">
                        <span className="text-sm font-medium">Unresponsive & stale</span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {staleRunners.length} runners outside READY state
                        </span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      {renderRunnerTable(staleRunners, 'No unresponsive or stale runners.')}
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            ) : (
              renderRunnerTable([], 'No runners found.')
            )}
          </TabsContent>

          {/* ── Machines tab ── */}
          <TabsContent value="machines">
            {machinesQuery.isPending ? (
              <TableSkeleton cols={6} />
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Host</TableHead>
                      <TableHead>Region</TableHead>
                      <TableHead>Oversell CPU</TableHead>
                      <TableHead>CPU waterline</TableHead>
                      <TableHead>Mem waterline</TableHead>
                      <TableHead>Sandboxes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {machinesQuery.data && machinesQuery.data.length > 0 ? (
                      machinesQuery.data.map((m) => (
                        <TableRow key={m.host}>
                          <TableCell className="font-mono text-xs">{m.host}</TableCell>
                          <TableCell>{m.region}</TableCell>
                          <TableCell>{m.oversellCpu}</TableCell>
                          <TableCell>{m.cpuWaterline.toFixed(1)}%</TableCell>
                          <TableCell>{m.memWaterline.toFixed(1)}%</TableCell>
                          <TableCell>{m.sandboxes}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                          No machines found.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </PageContent>

      {/* Confirmation dialog for ops actions */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmAction?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  )
}

export default Admin
