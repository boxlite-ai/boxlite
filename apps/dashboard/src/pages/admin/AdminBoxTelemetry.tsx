/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogsTab, MetricsTab, TracesTab } from '@/components/telemetry'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { RoutePath } from '@/enums/RoutePath'
import { useApi } from '@/hooks/useApi'
import { handleApiError } from '@/lib/error-handling'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import React from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

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

function isErrorState(state: string) {
  const lower = state?.toLowerCase() ?? ''
  return lower === 'error' || lower === 'failed'
}

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

function jaegerSearchHref(_sandboxId: string) {
  // POL-14 Phase 3 Plan B: platform telemetry is emitted under one service name
  // (boxlite-api, see apps/api/src/tracing.ts), not a per-sandbox service.
  return `/jaeger/search?service=${encodeURIComponent('boxlite-api')}`
}

function jaegerTraceHref(traceId: string) {
  return `/jaeger/trace/${encodeURIComponent(traceId)}`
}

const AdminBoxTelemetry: React.FC = () => {
  const { boxId } = useParams<{ boxId: string }>()
  const navigate = useNavigate()
  const { axiosInstance } = useApi()
  const queryClient = useQueryClient()

  const boxesQuery = useQuery<AdminBox[]>({
    queryKey: ['admin', 'boxes'],
    queryFn: () => axiosInstance.get('/admin/overview/boxes').then((r) => r.data),
    enabled: !!boxId,
  })

  const recoverMutation = useMutation({
    mutationFn: (sandboxId: string) => axiosInstance.post(`/admin/sandbox/${sandboxId}/recover`),
    onSuccess: () => {
      toast.success('Sandbox recovery initiated')
      queryClient.invalidateQueries({ queryKey: ['admin', 'boxes'] })
    },
    onError: (error) => handleApiError(error, 'Failed to recover sandbox'),
  })

  if (!boxId) {
    return <Navigate to={RoutePath.ADMIN} replace />
  }

  if (boxesQuery.isError && (boxesQuery.error as { response?: { status?: number } })?.response?.status === 403) {
    return <Navigate to={RoutePath.DASHBOARD} replace />
  }

  const box = boxesQuery.data?.find((item) => item.id === boxId)

  return (
    <PageLayout>
      <PageHeader size="full">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon-sm" onClick={() => navigate(RoutePath.ADMIN)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <PageTitle>Box telemetry</PageTitle>
          </div>
          <Button asChild variant="outline" size="sm">
            <a href={jaegerSearchHref(boxId)} target="_blank" rel="noreferrer">
              Open in Jaeger
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </PageHeader>

      <PageContent size="full">
        {boxesQuery.isPending ? (
          <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
            <Skeleton className="h-80 rounded-md" />
            <Skeleton className="h-[40rem] rounded-md" />
          </div>
        ) : !box ? (
          <Card>
            <CardContent className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              Box not found.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
            <Card className="h-fit">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="truncate font-mono text-base">{box.id}</CardTitle>
                  <StateBadge state={box.state} />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-4 border-t pt-2">
                    <dt className="text-muted-foreground">owner</dt>
                    <dd className="truncate font-medium">{box.owner.name}</dd>
                  </div>
                  <div className="flex justify-between gap-4 border-t pt-2">
                    <dt className="text-muted-foreground">org</dt>
                    <dd className="truncate">{box.owner.personal ? 'personal' : box.owner.orgName}</dd>
                  </div>
                  <div className="flex justify-between gap-4 border-t pt-2">
                    <dt className="text-muted-foreground">runner</dt>
                    <dd className="truncate font-mono text-xs">{box.runnerId ?? '—'}</dd>
                  </div>
                  <div className="flex justify-between gap-4 border-t pt-2">
                    <dt className="text-muted-foreground">specs</dt>
                    <dd className="font-mono text-xs">
                      {box.cpu}c / {box.memoryGiB}G
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 border-t pt-2">
                    <dt className="text-muted-foreground">created</dt>
                    <dd className="text-xs">{new Date(box.createdAt).toLocaleString()}</dd>
                  </div>
                </dl>

                <div className="flex gap-2">
                  {isErrorState(box.state) && (
                    <Button size="sm" onClick={() => recoverMutation.mutate(box.id)}>
                      Recover
                    </Button>
                  )}
                  <Button asChild variant="outline" size="sm">
                    <a href={jaegerSearchHref(box.id)} target="_blank" rel="noreferrer">
                      Jaeger
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="min-w-0 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">State</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <StateBadge state={box.state} />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">CPU</CardTitle>
                  </CardHeader>
                  <CardContent className="font-mono text-2xl font-bold">{box.cpu}</CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Memory</CardTitle>
                  </CardHeader>
                  <CardContent className="font-mono text-2xl font-bold">{box.memoryGiB}G</CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Runner</CardTitle>
                  </CardHeader>
                  <CardContent className="truncate font-mono text-xs">{box.runnerId ?? '—'}</CardContent>
                </Card>
              </div>

              <Tabs defaultValue="traces" className="flex min-h-[40rem] flex-col rounded-md border bg-card">
                <TabsList variant="underline" className="justify-start rounded-none border-b px-4">
                  <TabsTrigger value="logs">Logs</TabsTrigger>
                  <TabsTrigger value="traces">Traces</TabsTrigger>
                  <TabsTrigger value="metrics">Metrics</TabsTrigger>
                </TabsList>
                <TabsContent value="logs" className="m-0 min-h-0 flex-1 overflow-hidden">
                  <LogsTab sandboxId={box.id} />
                </TabsContent>
                <TabsContent value="traces" className="m-0 min-h-0 flex-1 overflow-hidden">
                  <TracesTab sandboxId={box.id} getTraceHref={jaegerTraceHref} />
                </TabsContent>
                <TabsContent value="metrics" className="m-0 min-h-0 flex-1 overflow-hidden">
                  <MetricsTab sandboxId={box.id} />
                </TabsContent>
              </Tabs>
            </div>
          </div>
        )}
      </PageContent>
    </PageLayout>
  )
}

export default AdminBoxTelemetry
