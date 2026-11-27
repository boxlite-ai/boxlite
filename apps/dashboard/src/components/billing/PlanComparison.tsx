/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Fragment, type CSSProperties, type ReactNode } from 'react'
import type { OrganizationPlan, Plan, PlanTrialEligibility } from '@/billing-api'
import { AsciiButton } from '@/components/ascii'
import { planCardCta } from '@/components/billing/planChange'
import { PLAN_BENEFITS, PLAN_PRESENTATION, planTierIndex } from '@/components/billing/planBenefits'
import { BOXLITE_CONTACT_URL, BOXLITE_SUBSCRIPTION_DOCS_URL } from '@/constants/ExternalLinks'
import { RoutePath } from '@/enums/RoutePath'
import { generatePath, useNavigate } from 'react-router-dom'
import './PlanComparison.css'
import { subscriptionValue, formatUsageMultiple } from '@/lib/subscription-value'

const currency = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100)
const CELL = 'border-b border-border px-4 py-2.5 text-left align-top font-normal'
const LABEL = `${CELL} sticky left-0 z-10 bg-background text-muted-foreground`

function formatTrialDuration(seconds: number) {
  const units = [
    [86400, 'Day', 'd'],
    [3600, 'Hour', 'h'],
    [60, 'Minute', 'm'],
    [1, 'Second', 's'],
  ] as const
  const parts: string[] = []
  let remaining = seconds
  for (const [size, name, suffix] of units) {
    const count = Math.floor(remaining / size)
    if (!count) continue
    if (count * size === seconds) return `${count} ${name}${count === 1 ? '' : 's'}`
    parts.push(`${count}${suffix}`)
    remaining %= size
  }
  return parts.join(' ')
}

function UnspecifiedValue() {
  return (
    <>
      <span aria-hidden="true" className="text-muted-foreground">
        —
      </span>
      <span className="sr-only">Not specified</span>
    </>
  )
}

function ComparisonRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <th scope="row" className={LABEL}>
        {label}
      </th>
      {children}
    </tr>
  )
}

/** Show documented plans; permit self-serve switching only when the catalogue price matches. */
export function PlanComparison({
  plans,
  organizationPlan,
  canManage = true,
  subscriptionAction,
  trialOffers,
  checkingTrials = false,
}: {
  plans: Plan[]
  organizationPlan?: OrganizationPlan | null
  canManage?: boolean
  subscriptionAction?: ReactNode
  trialOffers?: PlanTrialEligibility[]
  checkingTrials?: boolean
}) {
  const navigate = useNavigate()
  // No live subscription is wallet-funded PAYG, as in the account Overview.
  const currentId =
    organizationPlan && organizationPlan.status !== 'canceled'
      ? organizationPlan.planId
      : canManage
        ? plans.find((plan) => planTierIndex(plan.name) === 0 && plan.priceMonthlyCents === 0)?.id
        : undefined
  const currentPriceCents = plans.find((plan) => plan.id === currentId)?.priceMonthlyCents ?? null
  const columnCount = plans.length + 2
  const custom = <td className={`${CELL} text-muted-foreground`}>By agreement</td>
  const durations = new Map<string, string | null>()
  for (const offer of trialOffers ?? []) {
    if (offer.eligible === false) durations.set(offer.name, null)
    else if (offer.eligible === true && Number.isSafeInteger(offer.durationSeconds) && offer.durationSeconds > 0) {
      durations.set(offer.name, formatTrialDuration(offer.durationSeconds))
    }
  }

  function trialDetails(name: string) {
    if (checkingTrials) return 'Checking eligibility…'
    const duration = durations.get(name)
    if (duration === null) return 'Not eligible'
    if (!duration) return <UnspecifiedValue />
    return <>{duration.toLowerCase()} · card verification required</>
  }

  if (!plans.length) {
    return (
      <div className="border border-border p-6 text-body">
        <p>No plans are available right now.</p>
        <a
          className="resource-guide-link mt-2 inline-block"
          href={BOXLITE_CONTACT_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Contact us ↗
        </a>
      </div>
    )
  }

  return (
    <div>
      <div
        role="region"
        aria-label="Plan comparison"
        tabIndex={0}
        className="plan-comparison-scroll border-y border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table
          className="plan-comparison-table w-full table-fixed border-separate border-spacing-0 font-sans text-body"
          style={{ '--plan-table-width': `${144 + (columnCount - 1) * 210}px` } as CSSProperties}
        >
          <caption className="sr-only">Compare plan prices, resource limits and benefits</caption>
          <colgroup>
            <col className="w-[144px] sm:w-1/5" />
            {plans.map((plan) => (
              <col key={plan.id} className={plan.id === currentId ? 'bg-muted/40' : undefined} />
            ))}
            <col />
          </colgroup>
          <thead className="sticky top-0 z-20 bg-background">
            <tr>
              <th scope="col" className={`${LABEL} z-30 align-bottom`}>
                <span className="sr-only">Plan features</span>
              </th>
              {plans.map((plan) => {
                const index = planTierIndex(plan.name)
                const presentation = PLAN_PRESENTATION[index]
                const trialDuration = durations.get(plan.name)
                const priceMatches = !presentation || plan.priceMonthlyCents === presentation.priceCents
                const cta =
                  plan.id === currentId
                    ? { label: 'Current plan', disabled: true }
                    : planCardCta({ plan, organizationPlan, currentPriceCents })
                return (
                  <th
                    scope="col"
                    key={plan.id}
                    className={`${CELL} ${plan.id === currentId ? 'bg-secondary' : 'bg-background'}`}
                  >
                    <div className="flex flex-col items-start gap-3">
                      <div className="flex w-full items-baseline justify-between gap-3 whitespace-nowrap text-em font-medium text-foreground">
                        <span>{presentation?.name ?? plan.name}</span>
                        {index !== 0 && (
                          <span className="font-mono text-em font-normal text-foreground">
                            {plan.priceMonthlyCents == null ? 'Custom' : currency(plan.priceMonthlyCents)}
                          </span>
                        )}
                      </div>
                      <div className="flex w-full items-center gap-1.5">
                        {!priceMatches && canManage && !cta.disabled ? (
                          <a
                            href={BOXLITE_CONTACT_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap border border-border px-3 text-meta hover:border-border-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            Contact us ↗
                          </a>
                        ) : (
                          <AsciiButton
                            className="h-8 w-auto px-3"
                            variant={cta.disabled ? 'quiet' : 'secondary'}
                            disabled={!canManage || cta.disabled}
                            data-console-action="select_plan"
                            onClick={() => navigate(generatePath(RoutePath.BILLING_PLAN_CHANGE, { planId: plan.id }))}
                          >
                            {canManage ? cta.label : 'Owner managed'}
                          </AsciiButton>
                        )}
                        {trialDuration && (
                          <span className="plan-trial-space">
                            <span className="plan-trial-ribbon" title={`Free Trial ${trialDuration}`}>
                              <span className="plan-trial-face">
                                Free Trial <span>{trialDuration}</span>
                              </span>
                            </span>
                          </span>
                        )}
                      </div>
                      {canManage && plan.id === currentId && subscriptionAction}
                    </div>
                  </th>
                )
              })}
              <th scope="col" className={`${CELL} bg-background`}>
                <div className="flex flex-col items-start gap-3">
                  <div className="text-em font-medium">Custom</div>

                  <a
                    href={BOXLITE_CONTACT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-8 items-center justify-center border border-border px-3 text-meta hover:border-border-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Book a call ↗
                  </a>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th
                colSpan={columnCount}
                className="border-b border-border bg-muted/20 px-4 py-2.5 text-left font-medium"
              >
                <span className="sticky left-4">Billing & allowances</span>
              </th>
            </tr>
            <ComparisonRow label="Usage funding">
              {plans.map((plan) => (
                <td key={plan.id} className={CELL}>
                  {planTierIndex(plan.name) === 0 ? 'Usage charged to your wallet' : <UnspecifiedValue />}
                </td>
              ))}
              {custom}
            </ComparisonRow>
            <ComparisonRow label="Included usage value">
              {plans.map((plan) => {
                const includedCents = plan.includedQuotaCents
                return (
                  <td key={plan.id} className={CELL}>
                    {includedCents === null ? (
                      'Unlimited'
                    ) : includedCents != null ? (
                      currency(includedCents)
                    ) : (
                      <UnspecifiedValue />
                    )}
                  </td>
                )
              })}
              {custom}
            </ComparisonRow>
            <ComparisonRow label="Usage per dollar">
              {plans.map((plan) => {
                const value = subscriptionValue(plan)
                return (
                  <td key={plan.id} className={CELL}>
                    {value ? `${formatUsageMultiple(value.usageMultiple)}× PAYG` : <UnspecifiedValue />}
                  </td>
                )
              })}
              {custom}
            </ComparisonRow>
            <ComparisonRow label="Trial eligibility">
              {plans.map((plan) => (
                <td key={plan.id} className={CELL}>
                  {trialDetails(plan.name)}
                </td>
              ))}
              <td className={`${CELL} text-muted-foreground`}>{trialDetails('Enterprise')}</td>
            </ComparisonRow>
            {PLAN_BENEFITS.map((group) => (
              <Fragment key={group.title}>
                <tr>
                  <th
                    colSpan={columnCount}
                    className="border-b border-border bg-muted/20 px-4 py-2.5 text-left font-medium"
                  >
                    <div className="sticky left-4 w-[calc(100vw-64px)] sm:w-auto sm:max-w-3xl">{group.title}</div>
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <ComparisonRow key={row.label} label={row.label}>
                    {plans.map((plan) => (
                      <td key={plan.id} className={CELL}>
                        {row.values[planTierIndex(plan.name)] ?? <UnspecifiedValue />}
                      </td>
                    ))}
                    {custom}
                  </ComparisonRow>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-body text-muted-foreground">
        Monthly fees and included usage come from the current plan catalog. The effective cost assumes the full
        allowance is used; unused allowance expires. Additional usage is charged at PAYG rates.
      </p>
      <a
        href={BOXLITE_SUBSCRIPTION_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="resource-guide-link mt-4 inline-block text-body"
      >
        Subscription docs ↗
      </a>
    </div>
  )
}
