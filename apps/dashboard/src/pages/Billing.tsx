/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// TEMP(preview): Billing 入口下分 Overview / Usage / Wallet 三个 Tab。
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BillingPanel } from '@/components/billing/BillingPanel'
import { SubscriptionPlans } from '@/components/billing/SubscriptionPlans'
import Spending from './Spending'

const TAB_TRIGGER =
  'h-full gap-1.5 rounded-none border-0 border-r border-border px-5 text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-accent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none'
const TAB_TRIGGER_LAST =
  'h-full gap-1.5 rounded-none border-0 px-5 text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-accent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none'

function Billing() {
  return (
    <Tabs defaultValue="overview" className="w-full gap-0">
      <div className="px-6 pt-6">
        <h1 className="font-display text-2xl font-semibold leading-none tracking-tight">Billing</h1>
        <TabsList className="mt-5 h-9 gap-0 rounded-none border border-border bg-transparent p-0">
          <TabsTrigger value="overview" className={TAB_TRIGGER}>
            Overview
          </TabsTrigger>
          <TabsTrigger value="usage" className={TAB_TRIGGER}>
            Usage
          </TabsTrigger>
          <TabsTrigger value="billing" className={TAB_TRIGGER_LAST}>
            Wallet
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="overview" className="mt-0">
        <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-5 2xl:px-0">
          <SubscriptionPlans />
        </div>
      </TabsContent>
      <TabsContent value="usage" className="pt-6">
        <Spending />
      </TabsContent>
      <TabsContent value="billing" className="mt-0">
        <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-5 2xl:px-0">
          <BillingPanel />
        </div>
      </TabsContent>
    </Tabs>
  )
}

export default Billing
