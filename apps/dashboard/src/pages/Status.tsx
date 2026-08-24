import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { ChevronDown } from '@/components/ui/icon'
import { fetchStatusSnapshot, type ServiceStatus } from '@/lib/status-snapshot'
import { cn } from '@/lib/utils'

const PUBLIC_STATUS_SNAPSHOT_PATH = '/public-status.json'

const statusLabels: Record<ServiceStatus, string> = {
  operational: 'Operational',
  disruption: 'Disruption',
  partial_outage: 'Partial outage',
  outage: 'Outage',
  maintenance: 'Under maintenance',
}

const statusClasses: Record<ServiceStatus, string> = {
  operational: 'bg-emerald-500',
  disruption: 'bg-amber-400',
  partial_outage: 'bg-orange-500',
  outage: 'bg-red-500',
  maintenance: 'bg-blue-500',
}

function StatusLabel({ status }: { status: ServiceStatus }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs text-muted-foreground">
      <span className={cn('size-2 shrink-0 rounded-full', statusClasses[status])} aria-hidden="true" />
      {statusLabels[status]}
    </span>
  )
}

function StatusUnavailable() {
  return (
    <div className="border border-border bg-card px-5 py-8" role="status">
      <div className="flex items-center gap-3">
        <span className="size-2 rounded-full bg-muted-foreground" aria-hidden="true" />
        <h2 className="font-mono text-base font-medium">Status unavailable</h2>
      </div>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        The public status snapshot could not be verified. No operational claim is being made until a fresh snapshot is
        available.
      </p>
    </div>
  )
}

function RegionStatus({
  region,
}: {
  region: {
    id: string
    name: string
    status: ServiceStatus
    services: Array<{ id: string; name: string; status: ServiceStatus }>
  }
}) {
  const [isExpanded, setIsExpanded] = useState(true)
  const serviceListId = `region-services-${region.id}`

  return (
    <section className="border border-border bg-card">
      <header>
        <h2>
          <button
            type="button"
            aria-controls={serviceListId}
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded((expanded) => !expanded)}
            className="flex w-full items-center justify-between gap-4 border-b border-border px-5 py-4 text-left transition-colors hover:bg-accent/40"
          >
            <span className="flex min-w-0 items-center gap-3">
              <ChevronDown
                className={cn(
                  'size-4 shrink-0 text-muted-foreground transition-transform',
                  !isExpanded && '-rotate-90',
                )}
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block truncate font-mono text-base font-medium">{region.id}</span>
                <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">{region.name}</span>
              </span>
            </span>
            <StatusLabel status={region.status} />
          </button>
        </h2>
      </header>
      <ul id={serviceListId} hidden={!isExpanded} className="ml-8 divide-y divide-border border-l border-border">
        {region.services.map((service) => (
          <li key={service.id} className="flex items-center justify-between gap-4 px-5 py-4 pl-7">
            <span className="text-sm font-medium">{service.name}</span>
            <StatusLabel status={service.status} />
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function Status() {
  const statusQuery = useQuery({
    queryKey: ['public-status-snapshot'],
    queryFn: ({ signal }) => fetchStatusSnapshot(PUBLIC_STATUS_SNAPSHOT_PATH, signal),
    refetchInterval: 60_000,
    retry: false,
  })

  const snapshot = statusQuery.data

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-5 lg:p-8">
      <div className="mb-8">
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Platform availability
        </p>
        <h1 className="font-mono text-[22px] font-medium leading-none tracking-[-0.5px]">Status</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          Current availability of BoxLite services by AWS region. This view contains public, aggregated service state
          only.
        </p>
      </div>

      {statusQuery.isPending ? (
        <div className="border border-border bg-card px-5 py-8 font-mono text-sm text-muted-foreground" role="status">
          Loading current status…
        </div>
      ) : statusQuery.isError || !snapshot ? (
        <StatusUnavailable />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-5 py-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Last updated</p>
              <time className="mt-1 block font-mono text-sm" dateTime={snapshot.generatedAt}>
                {new Date(snapshot.generatedAt).toLocaleString()}
              </time>
            </div>
            <span className="font-mono text-xs text-muted-foreground">AWS</span>
          </div>

          {snapshot.regions.map((region) => (
            <RegionStatus key={region.id} region={region} />
          ))}
        </div>
      )}
    </main>
  )
}
