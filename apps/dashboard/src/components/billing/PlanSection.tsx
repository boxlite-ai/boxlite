/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, PanelNote, SectionTitle } from '@/components/ascii'
import { CycleOverview } from '@/components/billing/CycleOverview'
import { CustomPlanCard, PlanCards, PlanCardsSkeleton } from '@/components/billing/PlanCards'
import { Button } from '@/components/ui/button'
import { useOwnerPlanQuery, useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { usePlansQuery } from '@/hooks/queries/usePlansQuery'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { cn } from '@/lib/utils'
import { RefreshCcw } from '@/components/ui/icon'
import { ReactNode } from 'react'

export function PlanSection() {
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const organizationPlanQuery = useOwnerPlanQuery()
  const walletQuery = useOwnerWalletQuery()
  const plansQuery = usePlansQuery()

  const organizationPlan = organizationPlanQuery.data
  // Sort a copy: the array belongs to the query cache, so reordering it in place would leave a
  // second consumer reading a mutated array behind a reference that never changed. This is the
  // only consumer today, and the sort is idempotent, so nothing observes it yet. Non-self-serve
  // entries are filtered out here: they have no price to switch to. The grid adds one static
  // Custom card as the contact-sales path instead.
  const plans = plansQuery.data
    ?.filter((plan) => plan.selfServe)
    .slice()
    .sort((a, b) => (a.priceMonthlyCents ?? 0) - (b.priceMonthlyCents ?? 0))
  const wallet = walletQuery.data

  const config = useConfig()
  // usePlansQuery is gated only on config.billingApiUrl, so plan switching is gated here.
  const isOwner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER

  const isLoading = organizationPlanQuery.isLoading || plansQuery.isLoading || walletQuery.isLoading
  const isError = organizationPlanQuery.isError || plansQuery.isError || walletQuery.isError

  const handleRetry = () => {
    organizationPlanQuery.refetch()
    plansQuery.refetch()
    walletQuery.refetch()
  }

  return (
    <div className="flex flex-col gap-8">
      {isError ? (
        <Panel className="flex flex-col items-center gap-3 px-[22px] py-10">
          <span className="font-mono text-[13px] text-foreground">Oops, something went wrong</span>
          <span className="font-mono text-[11px] text-muted-foreground">There was an error loading your limits.</span>
          <Button variant="outline" onClick={handleRetry} className="mt-1 font-mono text-[12px]">
            <RefreshCcw className="mr-2 size-4" />
            Retry
          </Button>
        </Panel>
      ) : (
        <div className="flex flex-col gap-8">
          {config.billingApiUrl && isOwner && wallet && (
            <section>
              <SectionTitle title="Active Plan" />
              <CycleOverview wallet={wallet} organizationPlan={organizationPlan} />
            </section>
          )}

          {config.billingApiUrl && isOwner && selectedOrganization && (
            <section>
              <SectionTitle title="All Plans" count={plans ? `${plans.length + 1} plans` : undefined} />
              {isLoading ? (
                <PlanCardsSkeleton count={4} />
              ) : (
                <PlanCards
                  plans={plans || []}
                  organizationPlan={organizationPlan}
                  organizationId={selectedOrganization.id}
                />
              )}
            </section>
          )}

          {/* The old contact-sales row was available to every member. Owners see
              Custom in the plan grid; other members keep the same contact path. */}
          {!isOwner && (
            <section>
              <SectionTitle title="Custom Plan" />
              <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2 xl:grid-cols-4">
                <CustomPlanCard />
              </div>
            </section>
          )}

          <section>
            <SectionTitle title="Resource Ceilings" count="per-organization" />
            <Panel>
              <RateLimits
                title="Box Limits"
                description="Resources limit per box."
                rateLimits={[
                  { label: 'Compute', value: selectedOrganization?.maxCpuPerBox, unit: 'vCPU' },
                  { label: 'Memory', value: selectedOrganization?.maxMemoryPerBox, unit: 'GiB' },
                  { label: 'Storage', value: selectedOrganization?.maxDiskPerBox, unit: 'GiB' },
                ]}
              />

              <RateLimits
                title="Rate Limits"
                description="How many requests you can make."
                className="border-t border-border"
                rateLimits={[
                  {
                    value: selectedOrganization?.authenticatedRateLimit || config?.rateLimit?.authenticated?.limit,
                    label: 'General Requests',
                    ttlSeconds:
                      selectedOrganization?.authenticatedRateLimitTtlSeconds ?? config?.rateLimit?.authenticated?.ttl,
                  },
                  {
                    value: selectedOrganization?.boxCreateRateLimit || config?.rateLimit?.boxCreate?.limit,
                    label: 'Box Creation',
                    ttlSeconds: selectedOrganization?.boxCreateRateLimitTtlSeconds ?? config?.rateLimit?.boxCreate?.ttl,
                  },
                  {
                    value: selectedOrganization?.boxLifecycleRateLimit || config?.rateLimit?.boxLifecycle?.limit,
                    label: 'Box Lifecycle',
                    ttlSeconds:
                      selectedOrganization?.boxLifecycleRateLimitTtlSeconds ?? config?.rateLimit?.boxLifecycle?.ttl,
                  },
                ]}
              />
            </Panel>
            <PanelNote>
              Limits mitigate misuse and keep box and compute capacity fairly available across all users.
            </PanelNote>
          </section>
        </div>
      )}
    </div>
  )
}

interface LimitItem {
  value?: number | null
  unit?: string
  label: string
  ttlSeconds?: number | null
}

function RateLimits({
  rateLimits,
  className,
  title,
  description,
}: {
  rateLimits: LimitItem[]
  className?: string
  title: ReactNode
  description: ReactNode
}) {
  const isEmpty = rateLimits.every(({ value }) => !value)
  if (isEmpty) {
    return null
  }

  return (
    <div className={cn('flex flex-col gap-4 px-[22px] py-5', className)}>
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[11px] uppercase tracking-[1.5px] text-foreground">{title}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{description}</div>
      </div>
      <div className="grid grid-cols-3 gap-3 sm:gap-4">
        {rateLimits.map(({ label, value, unit, ttlSeconds }) =>
          // Ternary, not &&: a 0 limit is falsy but renders as a bare "0" in the grid.
          value ? <RateLimitItem key={label} label={label} value={value} unit={unit} ttlSeconds={ttlSeconds} /> : null,
        )}
      </div>
    </div>
  )
}

function formatTtl(ttlSeconds?: number | null): string {
  if (!ttlSeconds) return ' / min'
  if (ttlSeconds % 60 === 0) return ` / ${ttlSeconds / 60}min`
  return ` / ${ttlSeconds}s`
}

function RateLimitItem({ label, value, unit, ttlSeconds }: LimitItem) {
  if (!value) {
    return null
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">{label}</div>
      <div className="font-mono text-[18px] font-semibold leading-none tabular-nums text-foreground">
        {value?.toLocaleString()}
        <span className="ml-1 text-[10px] font-normal uppercase tracking-[0.5px] text-muted-foreground">
          {unit ? unit : formatTtl(ttlSeconds)}
        </span>
      </div>
    </div>
  )
}
