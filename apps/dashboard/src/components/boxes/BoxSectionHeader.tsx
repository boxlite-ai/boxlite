/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { ReactNode } from 'react'

export function BoxSectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex min-w-0 items-center justify-between gap-3">
      <h2 className="font-display text-em font-semibold text-foreground">{title}</h2>
      {right}
    </div>
  )
}
