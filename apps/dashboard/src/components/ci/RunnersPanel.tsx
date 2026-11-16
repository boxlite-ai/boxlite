/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { BoxResourceIcon } from '@/components/ResourceStateIcon'
import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, generatePath } from 'react-router-dom'
import {
  ResourceFilterEmptyState,
  ResourceEmptyState,
  ResourceLoadingState,
  ResourceErrorState,
  ResourceErrorNotice,
  ResourceFilter,
  ResourceIdentity,
} from '@/components/ResourceLayout'
import { ResourcePagination } from '@/components/ResourcePagination'
import { BoxStatusIndicator } from '@/components/boxes/box-presentation'
import { Container } from '@/components/ui/icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RoutePath } from '@/enums/RoutePath'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useNotificationSocket } from '@/hooks/useNotificationSocket'
import { timeAgo } from '@/lib/format'
import { isTransitioning } from '@/lib/utils/box'
import { CapacitySummary } from './CapacitySummary'

export function RunnersPanel() {
  const api = useApi()
  const cache = useQueryClient()
  const { notificationSocket } = useNotificationSocket()
  const { selectedOrganization } = useSelectedOrganization()
  const organization = selectedOrganization!.id
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState('')
  const name = filter.trim()
  const runners = useQuery({
    queryKey: ['ci-runners', organization, name, page],
    queryFn: () => (name ? api.getCiRunners(organization, page, 25, name) : api.getCiRunners(organization, page, 25)),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 10000,
    refetchInterval: (query) => {
      if (query.state.error || !notificationSocket?.connected) return 5000
      return query.state.data?.items.some(isTransitioning) ? 3000 : 10000
    },
  })
  useEffect(() => {
    if (!notificationSocket) return
    const refresh = () => {
      void cache.invalidateQueries({ queryKey: ['ci-runners', organization] })
    }
    const events = ['box.created', 'box.state.updated', 'box.desired-state.updated', 'connect', 'disconnect']
    events.forEach((event) => notificationSocket.on(event, refresh))
    return () => {
      events.forEach((event) => notificationSocket.off(event, refresh))
    }
  }, [notificationSocket, cache, organization])
  useEffect(() => {
    if (runners.data && !runners.isPlaceholderData && page > Math.max(1, runners.data.totalPages))
      setPage(Math.max(1, runners.data.totalPages))
  }, [runners.data, runners.isPlaceholderData, page])
  const hasInventory = runners.data !== undefined
  const empty = hasInventory && !runners.isPlaceholderData && !runners.data.items.length
  const clearFilter = () => {
    setFilter('')
    setPage(1)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="resource-toolbar">
        <ResourceFilter
          label="Filter runners"
          value={filter}
          onChange={(value) => {
            setFilter(value)
            setPage(1)
          }}
          maxLength={128}
          disabled={runners.isPending}
          count={runners.isPending || runners.isPlaceholderData ? '…' : (runners.data?.total ?? '—')}
        />
        {runners.data?.capacity && <CapacitySummary capacity={runners.data.capacity} />}
      </div>
      <div className="resource-content scroll-edge mt-[14px]" aria-busy={runners.isFetching}>
        {runners.isError && hasInventory && (
          <ResourceErrorNotice
            title="Unable to refresh runners. Showing previously loaded data. Retrying automatically…"
            retrying={runners.isFetching}
            onRetry={() => void runners.refetch()}
          />
        )}
        {!!runners.data?.items.length && (
          <table className="resource-table w-full min-w-[900px] table-fixed text-left font-sans text-body">
            <colgroup>
              <col className="w-[23%]" />
              <col className="w-[14%]" />
              <col />
              <col className="w-[80px]" />
              <col className="w-[80px]" />
              <col className="w-[80px]" />
              <col className="w-[110px]" />
              <col className="w-[96px]" />
            </colgroup>
            <thead className="border-b border-border">
              <tr>
                {['Name', 'Box ID', 'Image', 'CPU', 'Memory', 'Disk', 'Status', 'Created'].map((title) => (
                  <th key={title}>{title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runners.data?.items.map((box) => (
                <tr
                  key={box.id}
                  className="border-b border-border/60 transition-colors hover:bg-accent/40 focus-within:bg-accent/40"
                >
                  <td>
                    <ResourceIdentity icon={<BoxResourceIcon box={box} />}>
                      <Link
                        className="resource-link"
                        title={box.name}
                        to={generatePath(RoutePath.BOX_DETAILS, { boxId: box.id })}
                      >
                        {box.name}
                      </Link>
                    </ResourceIdentity>
                  </td>
                  <td className="font-mono text-muted-foreground">
                    <span className="block truncate" title={box.id}>
                      {box.id}
                    </span>
                  </td>
                  <td className="font-mono text-muted-foreground">
                    <span className="block truncate" title={box.image}>
                      {box.image || '—'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap font-mono text-muted-foreground">{box.cpu ?? '—'} vCPU</td>
                  <td className="whitespace-nowrap font-mono text-muted-foreground">{box.memory ?? '—'} GiB</td>
                  <td className="whitespace-nowrap font-mono text-muted-foreground">{box.disk ?? '—'} GiB</td>
                  <td>
                    {box.errorReason ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            tabIndex={0}
                            className="inline-flex focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground"
                          >
                            <BoxStatusIndicator box={box} />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm break-words">{box.errorReason}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <BoxStatusIndicator box={box} />
                    )}
                  </td>
                  <td className="font-mono text-muted-foreground">{box.createdAt ? timeAgo(box.createdAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!hasInventory &&
          (runners.isError ? (
            <ResourceErrorState
              title="Runners could not be loaded"
              retrying={runners.isFetching}
              onRetry={() => void runners.refetch()}
            />
          ) : (
            <ResourceLoadingState title="Loading runners…" />
          ))}
        {empty &&
          (name ? (
            <ResourceFilterEmptyState title={`No runners match “${name}”.`} onClear={clearFilter} />
          ) : (
            <ResourceEmptyState
              icon={<Container />}
              title="No CI runners yet"
              description="Boxes appear here while GitHub Actions jobs run."
            />
          ))}
      </div>
      {(!!runners.data?.total || page > 1) && (
        <ResourcePagination
          pageIndex={page - 1}
          pageSize={25}
          pageCount={runners.isPlaceholderData ? 0 : (runners.data?.totalPages ?? 0)}
          totalItems={runners.isPlaceholderData ? 0 : (runners.data?.total ?? 0)}
          isPagingLocked={runners.isFetching}
          isPageFetching={runners.isFetching && runners.isPlaceholderData}
          showPageSizeSelector={false}
          itemRangeLabel={
            runners.isPlaceholderData ? 'Loading runners…' : runners.data ? `${runners.data.total} runners` : 'Runners'
          }
          onPaginationChange={({ pageIndex }) => setPage(pageIndex + 1)}
        />
      )}
    </div>
  )
}
