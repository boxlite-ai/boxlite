/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RoutePath } from '@/enums/RoutePath'
import { Link } from 'react-router-dom'
import { BILLING_BRAND, SectionTitle } from './ascii'

function LimitGuide() {
  return (
    <div className="flex min-w-24 flex-1 gap-[3px]" aria-hidden="true">
      {Array.from({ length: 32 }, (_, index) => (
        <span key={index} className="h-1.5 flex-1 bg-brand/15" />
      ))}
    </div>
  )
}

function LimitRow({ label, value, unit }: { label: string; value?: number | null; unit: string }) {
  const display = value && value > 0 ? `${value} ${unit}` : 'not configured'
  return (
    <div className="grid grid-cols-[70px_minmax(110px,auto)_minmax(0,1fr)] items-center gap-4 py-2 font-mono text-[13px]">
      <span className="uppercase text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{display}</span>
      <LimitGuide />
    </div>
  )
}

export function QuotaPanel({
  cpu,
  memory,
  disk,
}: {
  cpu?: number | null
  memory?: number | null
  disk?: number | null
}) {
  return (
    <section data-testid="billing-limits-panel">
      <SectionTitle
        title="Limits"
        right={
          <Link
            to={RoutePath.LIMITS}
            className="font-mono text-[10px] uppercase text-muted-foreground hover:text-foreground"
          >
            view all limits
          </Link>
        }
      />
      <p className="mb-3 px-0.5 font-mono text-[12px] leading-relaxed text-muted-foreground">
        Hard caps applied to every Box in this organization, independent of balance.
      </p>
      <div className="border border-border bg-card px-[22px] py-4">
        <div className="mb-1 font-mono text-[10px] uppercase text-muted-foreground">
          <span style={{ color: BILLING_BRAND }}>▸</span> Per-box maximums
        </div>
        <div className="divide-y divide-border/40">
          <LimitRow label="vCPU" value={cpu} unit="vCPU" />
          <LimitRow label="RAM" value={memory} unit="GiB" />
          <LimitRow label="Disk" value={disk} unit="GiB" />
        </div>
      </div>
    </section>
  )
}
