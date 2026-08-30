/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AsciiButton, Panel, PanelNote, SectionTitle } from '@/components/ascii'
import { BILLING_PAGE_CONTAINER } from '@/components/billing/billingLayout'
import { PlanChangeNote, PlanComparison, planChangeSummary } from '@/components/billing/planChange'
import { ArrowLeft, RefreshCcw } from '@/components/ui/icon'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { RoutePath } from '@/enums/RoutePath'
import { useDowngradePlanMutation } from '@/hooks/mutations/useDowngradePlanMutation'
import { useUpgradePlanMutation } from '@/hooks/mutations/useUpgradePlanMutation'
import { useOwnerPlanQuery, useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { usePlansQuery } from '@/hooks/queries/usePlansQuery'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { format } from 'date-fns'
import { useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

/**
 * The confirmation step for a plan switch. Reached from a plan card, but also
 * by deep link, reload and Back — so unlike the dialog it replaced, it has to
 * establish for itself that billing is available, that the viewer owns the
 * organization, and that `:planId` names a change worth making.
 */
function BillingPlanChange() {
  const { planId = '' } = useParams<{ planId: string }>()
  const navigate = useNavigate()
  const config = useConfig()
  const { selectedOrganization, organizationMembers, authenticatedUserOrganizationMember } = useSelectedOrganization()

  const planQuery = useOwnerPlanQuery()
  const walletQuery = useOwnerWalletQuery()
  const plansQuery = usePlansQuery()
  const upgradePlan = useUpgradePlanMutation()
  const downgradePlan = useDowngradePlanMutation()
  const [leaving, setLeaving] = useState(false)

  // Members load in the background from an empty list
  // (SelectedOrganizationProvider.tsx:97-113), so a missing member means
  // "not resolved yet" just as often as "not an owner". Redirecting on it
  // would bounce a real owner off their own deep link on every refresh.
  const membersResolved = organizationMembers.length > 0
  const isOwner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER

  if (!config.billingApiUrl) {
    return <Navigate to={RoutePath.BILLING} replace />
  }
  if (!selectedOrganization || !membersResolved) {
    return <PlanChangeShell>{<Skeleton className="h-[320px] w-full" />}</PlanChangeShell>
  }
  if (!isOwner) {
    return (
      <PlanChangeShell>
        <Notice title="Plan changes are owner-only">
          Ask an owner of {selectedOrganization.name} to change the subscription.
        </Notice>
      </PlanChangeShell>
    )
  }

  const isError = planQuery.isError || plansQuery.isError || walletQuery.isError
  if (isError) {
    return (
      <PlanChangeShell>
        <Panel className="flex flex-col items-center gap-3 px-[22px] py-10">
          <span className="font-mono text-[13px] text-foreground">Oops, something went wrong</span>
          <span className="font-mono text-[11px] text-muted-foreground">There was an error loading billing data.</span>
          <Button
            variant="outline"
            className="mt-1 font-mono text-[12px]"
            onClick={() => {
              planQuery.refetch()
              plansQuery.refetch()
              walletQuery.refetch()
            }}
          >
            <RefreshCcw className="mr-2 size-4" />
            Retry
          </Button>
        </Panel>
      </PlanChangeShell>
    )
  }

  // A confirmation that briefly states the wrong price is worse than one that
  // states nothing, so nothing renders until both the catalog and the live plan
  // have actually landed — no zero-value fallbacks.
  if (!plansQuery.isSuccess || !planQuery.isSuccess) {
    return <PlanChangeShell>{<Skeleton className="h-[320px] w-full" />}</PlanChangeShell>
  }

  const summary = planChangeSummary({
    planId,
    catalog: plansQuery.data,
    plan: planQuery.data,
    wallet: walletQuery.data,
  })

  // An unknown plan id, or one the viewer already has, has no confirmation to
  // show. `replace` keeps Back from bouncing straight back into the redirect.
  if (summary.blocked?.redirect) {
    return <Navigate to={RoutePath.BILLING} replace />
  }

  const pending = upgradePlan.isPending || downgradePlan.isPending || leaving
  // Only a downgrade defers, and a downgrade always has a live cycle to defer
  // into — but read it defensively rather than asserting the branch.
  const rollDay = planQuery.data ? format(planQuery.data.cycleTo, 'MMM d, yyyy') : 'the next billing cycle'

  const handleConfirm = async () => {
    try {
      if (summary.action === 'upgrade') {
        const checkoutUrl = await upgradePlan.mutateAsync({ organizationId: selectedOrganization.id, planId })
        if (checkoutUrl) {
          // Hold the pending state through the hand-off: the browser takes a
          // moment to leave, and an idle-looking button invites a second click.
          setLeaving(true)
          window.location.href = checkoutUrl
          return
        }
        toast.success('Plan upgraded successfully')
      } else {
        await downgradePlan.mutateAsync({ organizationId: selectedOrganization.id, planId })
        // Name the plan and the day: "at the next billing cycle" left the user
        // to go looking for when that is.
        toast.success(`${summary.target?.name ?? 'Your new plan'} starts ${rollDay}`)
      }
      // `replace` so Back does not return to a confirmation for a plan the
      // organization now holds.
      navigate(RoutePath.BILLING, { replace: true })
    } catch (error) {
      handleApiError(error, `Failed to ${summary.action} organization plan`)
    }
  }

  return (
    <PlanChangeShell title={summary.title}>
      <div className="flex flex-col gap-6">
        <section>
          <SectionTitle title={summary.target?.name ?? planId} />
          <Panel className="px-[22px] py-2">
            {summary.comparisons.map((comparison) => (
              <ComparisonRow key={comparison.label} comparison={comparison} />
            ))}
          </Panel>
          <PanelNote>{summary.effect}</PanelNote>
        </section>

        {(summary.quotaNote || summary.walletNote || summary.caveats.length > 0) && (
          <section className="flex flex-col gap-2">
            {summary.caveats.map((caveat) => (
              <NoteLine key={caveat.text} note={caveat} />
            ))}
            {summary.quotaNote && <NoteLine note={{ tone: 'info', text: summary.quotaNote }} />}
            {summary.walletNote && <NoteLine note={{ tone: 'info', text: summary.walletNote }} />}
          </section>
        )}

        {summary.blocked?.kind === 'already-queued' ? (
          <Notice title="Already scheduled">{summary.blocked.text}</Notice>
        ) : (
          <div className="flex items-center gap-3">
            <AsciiButton
              variant="primary"
              disabled={pending}
              onClick={handleConfirm}
              className="inline-flex items-center gap-2"
            >
              {pending && <Spinner className="size-3.5" />}
              {leaving ? 'Redirecting to Stripe…' : summary.confirmLabel}
            </AsciiButton>
            {/* Cancelling mid-request would leave the user unsure whether the
                change went through, so it waits with the confirm button. */}
            <AsciiButton disabled={pending} onClick={() => navigate(RoutePath.BILLING)}>
              Cancel
            </AsciiButton>
          </div>
        )}
      </div>
    </PlanChangeShell>
  )
}

function PlanChangeShell({ title = 'Change plan', children }: { title?: string; children: React.ReactNode }) {
  const navigate = useNavigate()

  return (
    <div className={BILLING_PAGE_CONTAINER}>
      <div className="flex flex-col gap-6 py-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={() => navigate(RoutePath.BILLING)}>
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="font-display text-2xl font-semibold leading-none tracking-tight">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  )
}

function ComparisonRow({ comparison }: { comparison: PlanComparison }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-3 font-mono text-[12px] last:border-b-0">
      <span className="uppercase tracking-[0.5px] text-muted-foreground">{comparison.label}</span>
      <span className="flex items-baseline gap-2 tabular-nums">
        <span className="text-muted-foreground line-through decoration-muted-foreground/40">{comparison.from}</span>
        <span className="text-muted-foreground">→</span>
        <span className="font-semibold text-foreground">{comparison.to}</span>
      </span>
    </div>
  )
}

function NoteLine({ note }: { note: PlanChangeNote }) {
  return (
    <p
      className={`font-mono text-[11px] leading-relaxed ${
        note.tone === 'warn' ? 'text-warning' : 'text-muted-foreground'
      }`}
    >
      {note.text}
    </p>
  )
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Panel className="flex flex-col gap-2 px-[22px] py-6">
      <span className="font-mono text-[13px] text-foreground">{title}</span>
      <span className="font-mono text-[11px] leading-relaxed text-muted-foreground">{children}</span>
    </Panel>
  )
}

export default BillingPlanChange
