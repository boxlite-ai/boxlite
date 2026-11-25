/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel } from '@/components/ascii'
import { CycleOverview } from '@/components/billing/CycleOverview'
import { Button } from '@/components/ui/button'
import { useOwnerPlanQuery, useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { usePlansQuery } from '@/hooks/queries/usePlansQuery'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { RefreshCcw } from '@/components/ui/icon'

export function PlanSection({ onViewPlans }: { onViewPlans?: () => void }) {
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const organizationPlanQuery = useOwnerPlanQuery()
  const walletQuery = useOwnerWalletQuery()
  const plansQuery = usePlansQuery()

  const organizationPlan = organizationPlanQuery.data
  // Use the catalogue to resolve the current account's price.
  const plans = plansQuery.data?.filter((plan) => plan.selfServe)
  const wallet = walletQuery.data
  const activeCatalogIndex = plans?.findIndex((plan) => plan.id === organizationPlan?.planId) ?? -1
  const activeCatalogPlan = activeCatalogIndex >= 0 ? plans?.[activeCatalogIndex] : undefined

  const config = useConfig()
  // Account figures are owner-only; public plan comparisons live in Plans.
  const isOwner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER

  const isError = organizationPlanQuery.isError || plansQuery.isError || walletQuery.isError

  const handleRetry = () => {
    organizationPlanQuery.refetch()
    plansQuery.refetch()
    walletQuery.refetch()
  }

  return (
    <div className="flex flex-col gap-8">
      {authenticatedUserOrganizationMember && !isOwner && (
        <p className="text-body text-muted-foreground">
          Only an organization owner can view billing details or manage the subscription.
        </p>
      )}
      {isError ? (
        <Panel className="flex flex-col items-center gap-3 px-[22px] py-10">
          <span className="font-sans text-body text-foreground">Oops, something went wrong</span>
          <span className="font-sans text-meta text-muted-foreground">There was an error loading billing data.</span>
          <Button variant="outline" onClick={handleRetry} className="mt-1 font-sans text-meta">
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
              // Unfiltered: a queued plan should still be named even when it is
              // not one the organization could have picked itself.
              catalog={plansQuery.data}
              organizationId={selectedOrganization?.id}
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
            <div>
              <h2 className="text-em font-medium">Find the right plan</h2>
              <p className="mt-1 text-body text-muted-foreground">
                Compare resource limits, data retention and capabilities.
              </p>
            </div>
            <Button variant="outline" onClick={onViewPlans}>
              View plans →
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
