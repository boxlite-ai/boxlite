/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { PlanComparison } from './PlanComparison'
import { SubscriptionCancellationAction } from './SubscriptionCancellation'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useOwnerPlanQuery, useOwnerTrialEligibilityQuery } from '@/hooks/queries/billingQueries'
import { usePlansQuery } from '@/hooks/queries/usePlansQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { prepareSignIn } from '@/lib/auth-session'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { isAxiosError } from 'axios'
import { useAuth } from 'react-oidc-context'
import { useLocation } from 'react-router-dom'

export function PlansSection() {
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const catalog = usePlansQuery()
  const subscription = useOwnerPlanQuery()
  const eligibility = useOwnerTrialEligibilityQuery()
  const { signinRedirect } = useAuth()
  const location = useLocation()
  const canManage = Boolean(
    selectedOrganization && authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER,
  )
  const loading = catalog.isLoading || (canManage && subscription.isLoading)
  const error = catalog.isError || (canManage && subscription.isError)
  const cause = eligibility.error?.cause
  const status = isAxiosError(cause) ? cause.response?.status : undefined
  const checkingTrials = canManage && eligibility.isFetching
  const trialOffers = canManage && eligibility.isSuccess && !checkingTrials ? eligibility.data : undefined
  function signInAgain() {
    const returnTo = location.pathname + location.search + location.hash
    prepareSignIn(returnTo)
    void signinRedirect({ state: { returnTo } })
  }
  return (
    <section className="plans-section">
      {!canManage && (
        <p className="mb-4 text-body text-muted-foreground">
          Ask your organization owner to check free trials or change plans.
        </p>
      )}
      {canManage && eligibility.isError && (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 text-body">
          {status === 403 ? (
            'Only an organization owner can check free trial eligibility.'
          ) : status === 401 ? (
            <>
              Sign in again to check free trial eligibility.
              <Button size="sm" variant="outline" onClick={signInAgain}>
                Sign in again
              </Button>
            </>
          ) : (
            <>
              Trial eligibility is temporarily unavailable.
              <Button size="sm" variant="outline" onClick={() => void eligibility.refetch()}>
                Retry trial eligibility
              </Button>
            </>
          )}
        </div>
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
          trialOffers={trialOffers}
          checkingTrials={checkingTrials}
          subscriptionAction={
            canManage && subscription.data && selectedOrganization ? (
              <SubscriptionCancellationAction
                plan={subscription.data}
                organizationId={selectedOrganization.id}
                compact
              />
            ) : undefined
          }
        />
      )}
    </section>
  )
}
