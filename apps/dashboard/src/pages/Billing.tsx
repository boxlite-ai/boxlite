/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BillingAlerts } from '@/components/billing/BillingAlerts'
import { PlanSection } from '@/components/billing/PlanSection'
import { UsageSection } from '@/components/billing/UsageSection'
import { WalletSection } from '@/components/billing/WalletSection'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RoutePath } from '@/enums/RoutePath'
import { useConfig } from '@/hooks/useConfig'
import { Clock, Cpu, Database, MemoryStick, type LucideIcon } from '@/components/ui/icon'
import { useState } from 'react'
import { Link } from 'react-router-dom'

// Verbatim from the design: square segments, right-divided, accent fill when active.
const TAB_TRIGGER =
  'h-full gap-1.5 rounded-none border-0 border-r border-border px-5 text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-accent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none'
const BILLING_PAGE_CONTAINER = 'mx-auto w-full max-w-[1440px] px-4 sm:px-5 2xl:px-0'
const TAB_PANE = 'py-6'
const TAB_TRIGGER_LAST =
  'h-full gap-1.5 rounded-none border-0 px-5 text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-accent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none'

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
 * One page, three tabs — the arrangement in the design. Each tab is a section
 * that keeps its own hooks; this only composes and switches them. Alerts sit
 * inside Overview, where identity and payment-setup guidance belongs.
 */
function Billing() {
  const config = useConfig()
  // Controlled, so a section can send the user to a sibling tab — the usage
  // tab's low-balance banner tops up in the wallet tab.
  const [tab, setTab] = useState('overview')

  if (!config.billingApiUrl) {
    return <BillingComingSoon />
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="w-full gap-0">
      <div className={BILLING_PAGE_CONTAINER}>
        <div className="pt-6">
          <h1 className="font-display text-2xl font-semibold leading-none tracking-tight">Billing</h1>
          <TabsList className="mt-5 h-9 gap-0 rounded-none border border-border bg-transparent p-0">
            <TabsTrigger value="overview" className={TAB_TRIGGER}>
              Overview
            </TabsTrigger>
            <TabsTrigger value="usage" className={TAB_TRIGGER}>
              Usage
            </TabsTrigger>
            <TabsTrigger value="wallet" className={TAB_TRIGGER_LAST}>
              Wallet
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview">
          <div className={TAB_PANE}>
            <div className="mb-8 flex flex-col gap-4 empty:hidden">
              <BillingAlerts />
            </div>
            <PlanSection />
          </div>
        </TabsContent>
        <TabsContent value="usage">
          <div className={TAB_PANE}>
            <UsageSection onGoToWallet={() => setTab('wallet')} />
          </div>
        </TabsContent>
        <TabsContent value="wallet">
          <div className={TAB_PANE}>
            <WalletSection />
          </div>
        </TabsContent>
      </div>
    </Tabs>
  )
}

export default Billing
