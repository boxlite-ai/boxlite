/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, SectionTitle } from '@/components/ascii'
import { CycleOverview } from '@/components/billing/CycleOverview'
import { CustomPlanCard, PlanCards, PlanCardsSkeleton } from '@/components/billing/PlanCards'
import { Button } from '@/components/ui/button'
import { useOwnerPlanQuery, useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { usePlansQuery } from '@/hooks/queries/usePlansQuery'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { RefreshCcw } from '@/components/ui/icon'

const ALL_PLANS_ANCHOR = 'all-plans'

export function PlanSection() {
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const organizationPlanQuery = useOwnerPlanQuery()
  const walletQuery = useOwnerWalletQuery()
  const plansQuery = usePlansQuery()

  const organizationPlan = organizationPlanQuery.data
  // Commerce returns the public catalog in display order. Keep that order so
  // T1/T2/T3 stay presentation labels rather than a second ranking contract.
  // Non-self-serve entries stay out of switching; the grid ends with one
  // static contact-sales card instead.
  const plans = plansQuery.data?.filter((plan) => plan.selfServe)
  const wallet = walletQuery.data
  const activeCatalogIndex = plans?.findIndex((plan) => plan.id === organizationPlan?.planId) ?? -1
  const activeCatalogPlan = activeCatalogIndex >= 0 ? plans?.[activeCatalogIndex] : undefined

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
          <span className="font-mono text-[11px] text-muted-foreground">There was an error loading billing data.</span>
          <Button variant="outline" onClick={handleRetry} className="mt-1 font-mono text-[12px]">
            <RefreshCcw className="mr-2 size-4" />
            Retry
          </Button>
        </Panel>
      ) : (
        <div className="flex flex-col gap-8">
          {config.billingApiUrl && isOwner && wallet && (
            <CycleOverview
              wallet={wallet}
              organizationPlan={organizationPlan}
              catalogPlan={activeCatalogPlan}
              catalogIndex={activeCatalogIndex >= 0 ? activeCatalogIndex : undefined}
              plansAnchorId={ALL_PLANS_ANCHOR}
            />
          )}

          {config.billingApiUrl && isOwner && selectedOrganization && (
            <section id={ALL_PLANS_ANCHOR} className="scroll-mt-6">
              <SectionTitle title="All Plans" count={plans ? `${plans.length + 1} tiers` : undefined} />
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
        </div>
      )}
    </div>
  )
}
