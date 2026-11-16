/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Box } from '@boxlite-ai/api-client'
import { BoxDetailField } from './BoxDetailFields'

function duration(seconds: number): string {
  const parts: string[] = []
  for (const [unit, size] of [
    ['d', 86400],
    ['h', 3600],
    ['min', 60],
    ['sec', 1],
  ] as const) {
    const count = Math.floor(seconds / size)
    if (count) parts.push(`${count} ${unit}`)
    seconds %= size
  }
  return parts.join(' ')
}

function IntervalValue({ value, deletion = false }: { value: unknown; deletion?: boolean }) {
  if (value == null) return <>Not available</>
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return (
      <>
        <span>Not available</span>
        <p className="mt-1 text-meta text-muted-foreground">
          Unrecognized value: <code>{String(value)}</code>
        </p>
      </>
    )
  }
  if (value === 0) return <>Disabled</>
  return (
    <>
      <span>After {duration(value)} idle</span>
      {deletion && <p className="mt-1 text-meta text-muted-foreground">Only applies while the Box is stopped.</p>}
    </>
  )
}

/** Server policy only: creation defaults and form validation do not describe existing Boxes. */
export function BoxLifecycle({ box }: { box: Box }) {
  return (
    <section aria-label="Lifecycle" className="px-4 pb-3 pt-1">
      <h3 className="mb-1 text-body font-semibold">Lifecycle</h3>
      <dl className="[&>div]:grid-cols-[88px_minmax(0,1fr)]">
        <BoxDetailField label="Auto-stop" className="font-sans">
          <IntervalValue value={box.autoStop} />
        </BoxDetailField>
        <BoxDetailField label="Auto-delete" className="font-sans">
          <IntervalValue value={box.autoDelete} deletion />
        </BoxDetailField>
        <BoxDetailField label="Auto-resume" className="font-sans">
          {box.autoResume === true ? 'Enabled' : box.autoResume === false ? 'Disabled' : 'Not available'}
        </BoxDetailField>
      </dl>
    </section>
  )
}
