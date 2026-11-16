/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { Link } from 'react-router-dom'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { SegmentedBar } from '@/components/ascii'
import { NavigationIcon } from '@/components/NavigationIcon'
import { ArrowUpRight } from '@/components/ui/icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useOwnerPlanQuery, useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { RoutePath } from '@/enums/RoutePath'
import { cn, formatAmount } from '@/lib/utils'
import { balanceWarning } from './BalanceLowBanner'

/** Read-only shortcut to the existing organization billing page. */
export function SidebarBalance({ expanded }: { expanded: boolean }) {
  const config = useConfig()
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const wallet = useOwnerWalletQuery()
  const plan = useOwnerPlanQuery()
  if (
    !config.billingApiUrl ||
    !selectedOrganization ||
    authenticatedUserOrganizationMember?.role !== OrganizationUserRoleEnum.OWNER
  )
    return null

  const failed = wallet.isError || plan.isError
  const ready = wallet.isSuccess && plan.isSuccess
  const warning = ready ? balanceWarning(wallet.data, plan.data) : null
  const remaining = plan.data?.quotaRemainingCents
  const total = plan.data?.includedQuotaCents
  const balance = wallet.data?.ongoingBalanceCents ?? 0
  const hasAllowance = plan.data?.status !== 'canceled' && (remaining === null || (remaining ?? 0) > 0)
  // Show the current funding source; a zero wallet beside a funded plan is noise.
  const showPlan = Boolean(plan.data && balance >= 0 && (hasAllowance || balance === 0))
  const heading = ready ? (showPlan ? plan.data!.planName : 'Wallet') : 'Billing'
  const amount = showPlan ? (remaining === null ? 'Unlimited' : formatAmount(remaining ?? 0)) : formatAmount(balance)
  const used = typeof total === 'number' && typeof remaining === 'number' ? Math.max(0, total - remaining) : null
  const percentUsed =
    used !== null && typeof total === 'number' && total > 0 ? Math.min(100, Math.round((used / total) * 100)) : null
  const status = failed
    ? 'Balance unavailable'
    : !ready
      ? 'Loading billing…'
      : warning?.level === 'overdrawn'
        ? 'Wallet overdrawn'
        : warning?.level === 'empty'
          ? 'No balance remaining'
          : warning && !showPlan
            ? 'Below auto-reload threshold'
            : null
  const note = status ?? (ready && !showPlan && plan.data && !hasAllowance ? 'Plan used up · using wallet' : null)
  const attention = ready && warning && (!showPlan || warning.level === 'empty')

  if (!expanded)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={RoutePath.BILLING}
            aria-label="View billing and balance"
            className="relative flex h-[38px] w-10 items-center justify-center text-foreground hover:bg-control-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            <NavigationIcon name="billing" selected={false} />
            {attention && <span className="absolute right-1 top-1 size-1.5 bg-warning" />}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">
          {status ?? `${heading} · ${amount}${showPlan ? (remaining === null ? '' : ' left') : ' balance'}`} · View
          billing
        </TooltipContent>
      </Tooltip>
    )

  return (
    <Link
      to={RoutePath.BILLING}
      aria-label="View billing and balance"
      className="group block w-full border-t border-border px-3 pb-3 pt-4 text-body hover:bg-control-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{heading}</span>
        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
      </div>
      {ready && (
        <div className="mt-2 flex items-baseline justify-between gap-2">
          <span className={cn('font-mono tabular-nums', warning?.level === 'overdrawn' && 'text-destructive')}>
            {amount}
            <span className="ml-1 font-sans text-meta text-muted-foreground">
              {remaining === null && showPlan ? '' : showPlan ? 'left' : 'available'}
            </span>
          </span>
          {showPlan && percentUsed !== null && (
            <span className="text-meta text-muted-foreground">{percentUsed}% used</span>
          )}
        </div>
      )}
      {ready && showPlan && percentUsed !== null && (
        <div
          className="mt-2 flex items-center gap-1 font-mono text-meta text-muted-foreground"
          role="meter"
          aria-label="Plan allowance used"
          aria-valuemin={0}
          aria-valuemax={total! / 100}
          aria-valuenow={Math.min(total!, used!) / 100}
        >
          <div className="flex flex-1" aria-hidden="true">
            <SegmentedBar used={used!} limit={total!} segments={16} />
          </div>
        </div>
      )}
      {note && <p className={cn('mt-2 text-meta', attention ? 'text-warning' : 'text-muted-foreground')}>{note}</p>}
    </Link>
  )
}
