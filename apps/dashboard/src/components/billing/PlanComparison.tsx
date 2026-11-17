/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Fragment, type CSSProperties, type ReactNode } from 'react'
import { OrganizationPlan, Plan } from '@/billing-api'
import { AsciiButton } from '@/components/ascii'
import { planCardCta } from '@/components/billing/planChange'
import { PLAN_BENEFITS, PLAN_PRESENTATION, planTierIndex } from '@/components/billing/planBenefits'
import { BOXLITE_CONTACT_URL, BOXLITE_SUBSCRIPTION_DOCS_URL } from '@/constants/ExternalLinks'
import { RoutePath } from '@/enums/RoutePath'
import { generatePath, useNavigate } from 'react-router-dom'
import './PlanComparison.css'

const currency = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100)
const CELL = 'border-b border-border px-4 py-2.5 text-left align-top font-normal'
const LABEL = `${CELL} sticky left-0 z-10 bg-background text-muted-foreground`

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
}: {
  plans: Plan[]
  organizationPlan?: OrganizationPlan | null
  canManage?: boolean
}) {
  const navigate = useNavigate()
  const currentId = organizationPlan?.status === 'canceled' ? undefined : organizationPlan?.planId
  const currentPriceCents = plans.find((plan) => plan.id === currentId)?.priceMonthlyCents ?? null
  const columnCount = plans.length + 2
  const custom = <td className={`${CELL} text-muted-foreground`}>By agreement</td>

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
                const priceMatches = !presentation || plan.priceMonthlyCents === presentation.priceCents
                const cta = planCardCta({ plan, organizationPlan, currentPriceCents })
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
                            {presentation
                              ? currency(presentation.priceCents)
                              : plan.priceMonthlyCents == null
                                ? 'Custom'
                                : currency(plan.priceMonthlyCents)}
                          </span>
                        )}
                      </div>
                      {!priceMatches && canManage && !cta.disabled ? (
                        <a
                          href={BOXLITE_CONTACT_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-8 items-center justify-center border border-border px-3 text-meta hover:border-border-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Contact us ↗
                        </a>
                      ) : (
                        <AsciiButton
                          className="h-8 w-auto px-3"
                          variant={cta.disabled ? 'quiet' : 'secondary'}
                          disabled={!canManage || cta.disabled}
                          onClick={() => navigate(generatePath(RoutePath.BILLING_PLAN_CHANGE, { planId: plan.id }))}
                        >
                          {canManage ? cta.label : 'Owner managed'}
                        </AsciiButton>
                      )}
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
                  {planTierIndex(plan.name) === 0 ? (
                    'Usage charged to your wallet'
                  ) : (
                    <span aria-label="Not specified" className="text-muted-foreground">
                      —
                    </span>
                  )}
                </td>
              ))}
              {custom}
            </ComparisonRow>
            <ComparisonRow label="Bonus amount">
              {plans.map((plan) => {
                const bonusCents = PLAN_PRESENTATION[planTierIndex(plan.name)]?.bonusCents
                return (
                  <td key={plan.id} className={CELL}>
                    {bonusCents != null ? (
                      currency(bonusCents)
                    ) : (
                      <span aria-label="Not specified" className="text-muted-foreground">
                        —
                      </span>
                    )}
                  </td>
                )
              })}
              {custom}
            </ComparisonRow>
            <ComparisonRow label="Trial eligibility">
              {plans.map((plan) => (
                <td key={plan.id} className={CELL}>
                  {planTierIndex(plan.name) === 1 || planTierIndex(plan.name) === 2 ? (
                    '3-day free trial · card verification required'
                  ) : (
                    <span aria-label="Not specified" className="text-muted-foreground">
                      —
                    </span>
                  )}
                </td>
              ))}
              {custom}
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
                        {row.values[planTierIndex(plan.name)] ?? (
                          <span aria-label="Not specified" className="text-muted-foreground">
                            —
                          </span>
                        )}
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
