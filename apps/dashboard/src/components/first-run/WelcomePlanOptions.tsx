/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { AsciiButton } from '@/components/ascii'
import { RoutePath } from '@/enums/RoutePath'
import { useOwnerPlanQuery, useOwnerTrialEligibilityQuery } from '@/hooks/queries/billingQueries'
import { usePlansQuery } from '@/hooks/queries/usePlansQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { isPaidSelfServePlan } from '@/lib/first-run'
import { trialDuration } from '@/lib/trial-offer'
import { formatAmount } from '@/lib/utils'
import { useAuth } from 'react-oidc-context'
import { generatePath, useNavigate } from 'react-router-dom'

export default function WelcomePlanOptions() {
  const { selectedOrganization } = useSelectedOrganization()
  const { user } = useAuth()
  const navigate = useNavigate()
  const subscription = useOwnerPlanQuery()
  const catalog = usePlansQuery()
  const eligibility = useOwnerTrialEligibilityQuery()
  const plans = catalog.data?.filter(isPaidSelfServePlan) ?? []

  if (
    !selectedOrganization ||
    !user ||
    !subscription.isSuccess ||
    (subscription.data && subscription.data.status !== 'canceled') ||
    !catalog.isSuccess ||
    !plans.length
  ) {
    return null
  }

  const welcomeSubscription = { organizationId: selectedOrganization.id, userId: user.profile.sub }
  const offers = eligibility.isSuccess && !eligibility.isFetching ? eligibility.data : undefined
  return (
    <section className="mb-6 border-b border-border pb-6" aria-labelledby="welcome-plans-heading">
      <h2 id="welcome-plans-heading" className="text-em font-medium">
        Choose a plan
      </h2>
      <ul className="mt-4 space-y-2">
        {plans.map((plan) => {
          const duration = trialDuration(offers?.find((offer) => offer.name === plan.name))
          return (
            <li
              key={plan.id}
              className="flex flex-wrap items-center justify-between gap-3 border border-border px-4 py-3"
            >
              <div>
                <div className="text-body font-medium">{plan.name}</div>
                <div className="text-meta text-muted-foreground">
                  {duration && `${duration.toLowerCase()} free, then `}
                  {formatAmount(plan.priceMonthlyCents)} / month
                </div>
              </div>
              <AsciiButton
                size="sm"
                onClick={() =>
                  navigate(generatePath(RoutePath.BILLING_PLAN_CHANGE, { planId: plan.id }), {
                    state: { welcomeSubscription },
                  })
                }
              >
                Choose {plan.name}
              </AsciiButton>
            </li>
          )
        })}
      </ul>
      {eligibility.isError && (
        <button
          type="button"
          onClick={() => void eligibility.refetch()}
          className="mt-3 text-meta underline underline-offset-4"
        >
          Retry trial eligibility
        </button>
      )}
    </section>
  )
}
