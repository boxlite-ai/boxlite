/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { AsciiButton } from '@/components/ascii'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { useOwnerPlanQuery } from '@/hooks/queries/billingQueries'
import { usePlansQuery } from '@/hooks/queries/usePlansQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { boxSubscriptionValue, subscriptionValue } from '@/lib/subscription-value'
import { formatPriceCents, type BoxHourlyPrice, type BoxSpec } from '@/lib/box-price'
import { PLAN_PRESENTATION, planTierIndex } from '@/components/billing/planBenefits'
import { RoutePath } from '@/enums/RoutePath'

export function BoxPriceSummary({
  quote,
  spec,
  currency,
}: {
  quote: BoxHourlyPrice
  spec: BoxSpec
  currency?: string
}) {
  const catalog = usePlansQuery()
  const subscription = useOwnerPlanQuery()
  const { authenticatedUserOrganizationMember } = useSelectedOrganization()
  const owner = authenticatedUserOrganizationMember?.role === 'owner'
  const ready =
    owner &&
    currency === 'USD' &&
    catalog.isSuccess &&
    subscription.isSuccess &&
    !catalog.isPlaceholderData &&
    !subscription.isPlaceholderData &&
    !catalog.isError &&
    !subscription.isError
  const comparison = ready ? boxSubscriptionValue(catalog.data, subscription.data, spec, quote) : undefined
  const value = subscriptionValue(comparison?.plan)
  const effective = value ? quote.totalCents * value.costRatio : undefined
  const active = comparison?.active && effective != null
  const savingsPercent = value ? Math.floor((1 - value.costRatio) * 10000) / 100 : undefined
  const name =
    comparison?.plan && (PLAN_PRESENTATION[planTierIndex(comparison.plan.name)]?.name ?? comparison.plan.name)
  const price = (cents: number) => formatPriceCents(cents, 8)
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div>
          <div className="text-meta text-muted-foreground">PAYG estimate</div>
          <div className="font-mono text-em">
            {price(quote.totalCents)} <span className="font-sans text-meta text-muted-foreground">/ hr</span>
          </div>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <AsciiButton size="sm">Price breakdown</AsciiButton>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            aria-label="Price breakdown"
            className="w-[440px] max-w-[calc(100vw-32px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
          >
            <div className="mb-3 text-body font-medium">Estimated cost per hour</div>
            <div className="space-y-3">
              {quote.lines.map((line) => (
                <div
                  key={line.code}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 font-mono text-meta"
                >
                  <span className="min-w-0 flex-1 text-muted-foreground [overflow-wrap:anywhere]">
                    {line.label} · {line.quantity} {line.quantityUnit} × {formatPriceCents(line.unitPriceCents, 6)}/
                    {line.quantityUnit}·hr
                  </span>
                  <span className="tabular-nums text-foreground">{formatPriceCents(line.subtotalCents, 6)}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-border pt-3 text-body">
              <span>PAYG / quota consumption</span>
              <span className="font-mono">{price(quote.totalCents)} / hr</span>
            </div>
            {value && comparison?.plan && (
              <div className="mt-3 space-y-2 border-t border-border pt-3 text-body">
                <div className="flex flex-wrap justify-between gap-2">
                  <span>{name} effective estimate</span>
                  <span className="font-mono">{price(effective!)} / hr</span>
                </div>
                <p className="text-muted-foreground">
                  {formatPriceCents(comparison.plan.priceMonthlyCents!)} / month includes{' '}
                  {formatPriceCents(comparison.plan.includedQuotaCents!)} of usage at PAYG rates.
                </p>
                <p className="text-muted-foreground">
                  Assumes the full monthly allowance is used, at current catalog prices. Unused allowance expires;
                  actual savings depend on usage.
                </p>
              </div>
            )}
            <p className="mt-3 text-body text-muted-foreground">
              CPU, memory and disk consume included usage at the published rates above. After included usage runs out,
              the same rates apply to your wallet.
            </p>
          </PopoverContent>
        </Popover>
      </div>
      {value && effective != null && (
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-meta text-muted-foreground">
          <span>{savingsPercent}% lower effective hourly cost with a subscription</span>
          {!active && (
            <a
              className="resource-guide-link inline-flex min-h-6 items-center"
              href={`${RoutePath.BILLING}?tab=plans`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View plans (opens in a new tab)"
            >
              View plans ↗
            </a>
          )}
        </p>
      )}
      {comparison?.note && <p className="text-meta text-muted-foreground">{comparison.note}</p>}
    </div>
  )
}
