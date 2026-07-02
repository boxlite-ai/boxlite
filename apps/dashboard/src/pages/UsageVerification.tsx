/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxUsageLedger } from '@/components/boxes/BoxUsageLedger'
import { Button } from '@/components/ui/button'
import { getBoxesQueryKey, useBoxes } from '@/hooks/useBoxes'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getBoxDisplayName } from '@/lib/box-identity'
import { cn } from '@/lib/utils'
import { ListBoxesPaginatedStatesEnum } from '@boxlite-ai/api-client'
import { useMemo, useState } from 'react'

const VISIBLE_BOX_STATES = [
  ListBoxesPaginatedStatesEnum.CREATING,
  ListBoxesPaginatedStatesEnum.STARTING,
  ListBoxesPaginatedStatesEnum.STARTED,
  ListBoxesPaginatedStatesEnum.STOPPING,
  ListBoxesPaginatedStatesEnum.STOPPED,
  ListBoxesPaginatedStatesEnum.ERROR,
  ListBoxesPaginatedStatesEnum.UNKNOWN,
]

export default function UsageVerification() {
  const { selectedOrganization } = useSelectedOrganization()
  const [selectedBoxId, setSelectedBoxId] = useState('')
  const boxesParams = useMemo(
    () => ({
      page: 1,
      pageSize: 50,
      filters: {
        states: VISIBLE_BOX_STATES,
      },
    }),
    [],
  )
  const boxesQuery = useBoxes(getBoxesQueryKey(selectedOrganization?.id, boxesParams), boxesParams)

  return (
    <main className="min-h-[var(--app-content-height,calc(100svh_-_60px))] bg-background p-4 text-foreground sm:p-5">
      <div className="mx-auto grid w-full max-w-[1320px] gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <section className="border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Usage</h1>
              <div className="mt-1 font-mono text-xs text-muted-foreground">
                org={selectedOrganization?.id ?? 'none'}
              </div>
            </div>
            <Button variant="secondary" onClick={() => boxesQuery.refetch()}>
              Refresh
            </Button>
          </div>
          <div className="mt-3 max-h-[calc(100svh-180px)] overflow-auto">
            {(boxesQuery.data?.items ?? []).map((box) => (
              <button
                type="button"
                key={box.id}
                onClick={() => setSelectedBoxId(box.id)}
                className={cn(
                  'w-full border-b border-border px-2 py-2 text-left last:border-b-0 hover:bg-accent',
                  selectedBoxId === box.id && 'bg-accent',
                )}
              >
                <div className="truncate text-sm font-medium">{getBoxDisplayName(box)}</div>
                <div className="mt-1 flex items-center justify-between gap-2 font-mono text-xs text-muted-foreground">
                  <span className="truncate">{box.id}</span>
                  <span>{box.state}</span>
                </div>
              </button>
            ))}
            {boxesQuery.data?.items.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">No boxes</div>
            )}
          </div>
        </section>

        <section>
          {selectedBoxId ? (
            <BoxUsageLedger boxId={selectedBoxId} />
          ) : (
            <div className="border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Select a box to inspect usage_period rows and aggregate usage JSON.
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
