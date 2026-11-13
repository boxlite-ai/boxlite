/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { type Box } from '@boxlite-ai/api-client'

/** Provisioned capacity in Overview; never a utilization gauge. */
export function BoxResourceSummary({ box }: { box: Pick<Box, 'cpu' | 'memory' | 'disk'> }) {
  return (
    <section aria-label="Box resources" className="flex-none">
      <dl className="grid grid-cols-3 gap-3">
        {[
          { label: 'CPU', value: box.cpu, unit: 'vCPU' },
          { label: 'Memory', value: box.memory, unit: 'GiB' },
          { label: 'Disk', value: box.disk, unit: 'GiB' },
        ].map(({ label, value, unit }) => (
          <div key={label} className="min-h-[72px] min-w-0 bg-muted/40 px-4 py-2.5">
            <dt className="mb-0.5 text-meta text-muted-foreground">{label}</dt>
            <dd className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="font-mono text-section font-medium leading-7 tabular-nums">{value ?? '—'}</span>
              <span className="text-meta text-muted-foreground">{unit}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
