/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BillingAlerts } from '@/components/billing/BillingAlerts'
import { RoutePath } from '@/enums/RoutePath'
import { useConfig } from '@/hooks/useConfig'
import { Clock, Cpu, Database, MemoryStick, type LucideIcon } from '@/components/ui/icon'
import { Link } from 'react-router-dom'
import Limits from './Limits'
import Spending from './Spending'
import Wallet from './Wallet'

const DIMENSIONS: { icon: LucideIcon; name: string; unit: string }[] = [
  { icon: Cpu, name: 'CPU', unit: 'per vCPU·hr' },
  { icon: MemoryStick, name: 'Memory', unit: 'per GiB·hr' },
  { icon: Database, name: 'Disk', unit: 'per GiB·mo' },
  { icon: Clock, name: 'Runtime', unit: 'per second' },
]

function SegBars() {
  return (
    <div className="mt-3 flex w-full gap-[3px]">
      {Array.from({ length: 8 }).map((_, i) => (
        <span key={i} className="h-[5px] flex-1 bg-brand/15" />
      ))}
    </div>
  )
}

/** Stands in until a billing service is deployed — nothing below it can load without one. */
function BillingComingSoon() {
  return (
    <div className="flex min-h-[calc(100svh-60px)] items-center justify-center px-6 py-14 lg:px-[40px]">
      <div className="w-full max-w-[560px] text-center" style={{ animation: 'stat-in 0.5s ease both' }}>
        <h1 className="mb-3 text-[26px] font-semibold leading-tight tracking-[-0.5px]">Billing is on the way</h1>
        <p className="mx-auto mb-2 max-w-[440px] text-[13px] leading-relaxed text-muted-foreground">
          BoxLite is <span className="text-foreground">free while we finish metering</span>. Nothing is charged today —
          run as many boxes as you need.
        </p>
        <p className="mx-auto mb-[30px] max-w-[440px] text-[12.5px] leading-relaxed text-muted-foreground">
          When billing launches, usage will be metered across four dimensions:
        </p>

        <div className="mb-[34px] grid grid-cols-4 gap-[10px]">
          {DIMENSIONS.map(({ icon: Icon, name, unit }) => (
            <div
              key={name}
              className="flex flex-col items-center gap-[9px] border border-border bg-card px-[10px] pb-[14px] pt-4"
            >
              <Icon className="size-[18px] text-muted-foreground" strokeWidth={1.6} />
              <div className="text-[11px] uppercase tracking-[1px] text-foreground">{name}</div>
              <div className="text-[9.5px] tracking-[0.5px] text-muted-foreground">{unit}</div>
              <SegBars />
            </div>
          ))}
        </div>

        <Link
          to={RoutePath.BOXES}
          className="inline-flex items-center gap-[9px] bg-primary px-[22px] py-3 text-[12.5px] font-semibold tracking-[0.3px] text-primary-foreground transition-opacity hover:opacity-85"
        >
          Back to Boxes
          <span className="text-[14px] leading-none">→</span>
        </Link>
      </div>
    </div>
  )
}

/**
 * One page for the whole billing surface — plan, wallet and usage stacked as
 * sections rather than split across tabs or separate nav entries. Each section
 * keeps its own hooks; this only composes them.
 */
function Billing() {
  const config = useConfig()

  if (!config.billingApiUrl) {
    return <BillingComingSoon />
  }

  return (
    <div className="flex flex-col px-[34px] pb-14 pt-[26px] lg:px-[40px]">
      {/* header — same hierarchy as the Boxes/Keys pages */}
      <div className="mb-[22px] flex items-end justify-between">
        <h1 className="font-mono text-[22px] font-medium leading-none tracking-[-0.5px]">Billing</h1>
      </div>

      <div className="flex flex-col gap-8">
        <BillingAlerts />
        <Limits />
        <Wallet />
        <Spending />
      </div>
    </div>
  )
}

export default Billing
