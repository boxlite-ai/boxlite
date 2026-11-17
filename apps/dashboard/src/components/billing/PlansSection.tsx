/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { PlanComparison } from './PlanComparison'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useOwnerPlanQuery } from '@/hooks/queries/billingQueries'
import { usePlansQuery } from '@/hooks/queries/usePlansQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'

export function PlansSection() {
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const catalog = usePlansQuery()
  const subscription = useOwnerPlanQuery()
  const canManage = Boolean(
    selectedOrganization && authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER,
  )
  const loading = catalog.isLoading || (canManage && subscription.isLoading)
  const error = catalog.isError || (canManage && subscription.isError)
  return (
    <section className="plans-section">
      {!canManage && (
        <p className="mb-4 text-body text-muted-foreground">Ask your organization owner to change plans.</p>
      )}
      {error ? (
        <div role="alert" className="border border-border p-6">
          <p>Unable to load plans.</p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => {
              catalog.refetch()
              if (canManage) subscription.refetch()
            }}
          >
            Retry
          </Button>
        </div>
      ) : loading ? (
        <div role="status" className="space-y-3">
          <span className="sr-only">Loading plans</span>
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <PlanComparison
          plans={catalog.data?.filter((plan) => plan.selfServe) ?? []}
          organizationPlan={subscription.data}
          canManage={canManage}
        />
      )}
    </section>
  )
}
