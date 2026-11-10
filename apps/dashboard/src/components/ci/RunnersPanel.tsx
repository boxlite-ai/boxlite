/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, generatePath } from 'react-router-dom'
import { AsciiButton } from '@/components/ascii'
import { BoxState } from '@/components/BoxTable/BoxState'
import { BoxCube } from '@/components/BoxCube'
import { Search } from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useNotificationSocket } from '@/hooks/useNotificationSocket'
import { timeAgo } from '@/lib/format'
import { isTransitioning } from '@/lib/utils/box'
import { boxCubeState } from '@/lib/box-shape'
import { CapacityBar } from './CapacityBar'

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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {runners.data?.capacity && <CapacityBar capacity={runners.data.capacity} />}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex h-11 w-full min-w-0 items-center gap-[11px] border border-dashed border-border bg-card px-[14px] sm:h-9 sm:max-w-[380px]">
          <Search className="size-[15px] shrink-0" style={{ color: 'hsl(var(--brand))' }} strokeWidth={2} />
          <input
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value)
              setPage(1)
            }}
            placeholder="Filter runners…"
            aria-label="Filter runners by name"
            maxLength={128}
            className="w-full border-0 bg-transparent p-0 text-body text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="whitespace-nowrap font-mono text-label uppercase text-muted-foreground">
            {runners.isPending || runners.isPlaceholderData ? '…' : (runners.data?.total ?? '—')}
          </span>
        </div>
      </div>
      <div className="mt-[14px] min-h-0 flex-1 overflow-auto" aria-busy={runners.isFetching}>
        <table className="w-full min-w-[720px] text-left text-body">
          <thead className="border-b border-border font-mono text-label uppercase text-muted-foreground">
            <tr>
              {['Name', 'State', 'Image', 'Resources', 'Created'].map((title) => (
                <th key={title} className="px-2 py-2 font-normal">
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runners.data?.items.map((box) => (
              <tr key={box.id} className="border-b border-border/60">
                <td className="px-2 py-[13px] font-mono font-medium">
                  <div className="flex items-center gap-3">
                    <BoxCube
                      state={isTransitioning(box) ? 'building' : box.state === 'started' ? 'ci' : boxCubeState(box)}
                      size={28}
                      className="text-muted-foreground"
                    />
                    <div className="min-w-0">
                      <Link
                        className="whitespace-nowrap text-foreground hover:underline"
                        to={generatePath(RoutePath.BOX_DETAILS, { boxId: box.id })}
                      >
                        {box.name}
                      </Link>
                      <div className="mt-1 font-mono text-meta text-muted-foreground">JIT · {box.id}</div>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-[13px]">
                  <BoxState state={box.state} errorReason={box.errorReason} />
                </td>
                <td
                  className="max-w-[260px] truncate px-2 py-[13px] font-mono text-meta text-muted-foreground"
                  title={box.image}
                >
                  {box.image || '—'}
                </td>
                <td className="px-2 py-[13px] font-mono text-meta text-muted-foreground">
                  {box.cpu} vCPU · {box.memory} GiB
                </td>
                <td className="px-2 py-[13px] font-mono text-meta text-muted-foreground">
                  {box.createdAt ? timeAgo(box.createdAt) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {runners.isPending && (
          <p role="status" className="py-10 text-center font-mono text-meta text-muted-foreground">
            Loading runners…
          </p>
        )}
        {runners.isError && (
          <p role="alert" className="py-10 text-center font-mono text-meta text-muted-foreground">
            Runners could not be loaded. Retrying automatically…
          </p>
        )}
        {runners.isSuccess && !runners.isPlaceholderData && !runners.data.items.length && (
          <div className="flex flex-col items-center py-10 text-center font-mono text-meta text-muted-foreground">
            <BoxCube state="ci" size={56} className="mb-4" />
            <p>
              {name ? `No runners match “${name}”.` : 'No CI runners. Boxes appear here while GitHub Actions jobs run.'}
            </p>
          </div>
        )}
      </div>
      {(!!runners.data?.total || page > 1) && (
        <div className="flex items-center justify-between gap-3 border-t border-border py-3 font-mono text-meta text-muted-foreground">
          <span>
            {runners.data
              ? `${runners.data.total} runners · Page ${page} of ${Math.max(1, runners.data.totalPages)}`
              : `Page ${page}`}
          </span>
          <div className="flex gap-2">
            <AsciiButton size="sm" disabled={page <= 1 || runners.isFetching} onClick={() => setPage(page - 1)}>
              Previous
            </AsciiButton>
            <AsciiButton
              size="sm"
              disabled={!runners.data || page >= runners.data.totalPages || runners.isFetching}
              onClick={() => setPage(page + 1)}
            >
              Next
            </AsciiButton>
          </div>
        </div>
      )}
    </div>
  )
}
