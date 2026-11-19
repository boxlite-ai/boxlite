/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AsciiButton, Panel, PanelNote, SectionTitle } from '@/components/ascii'
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
import { useEffect, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { savePlanSetup, discardPlanSetup } from '@/components/billing/planSetupIntent'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { usePageTitle } from '@/hooks/usePageTitle'

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
  const {
    selectedOrganization,
    organizationMembersStatus,
    authenticatedUserOrganizationMember,
    refreshOrganizationMembers,
  } = useSelectedOrganization()

  const planQuery = useOwnerPlanQuery()
  const walletQuery = useOwnerWalletQuery()
  const plansQuery = usePlansQuery()
  const upgradePlan = useUpgradePlanMutation()
  const downgradePlan = useDowngradePlanMutation()
  const [checkoutLink, setCheckoutLink] = useState<string | null>(null)
  const leaving = checkoutLink !== null
  const { user } = useAuth()
  const [params] = useSearchParams()
  const returned = params.get('setup') === 'return'
  const subject = user?.profile.sub ?? ''
  const organizationId = selectedOrganization?.id ?? ''
  const context = JSON.stringify([
    subject,
    organizationId,
    planId,
    authenticatedUserOrganizationMember?.role,
    organizationMembersStatus,
  ])
  const currentContext = useRef(context)
  const contextGeneration = useRef(0)
  if (currentContext.current !== context) contextGeneration.current += 1
  currentContext.current = context
  const [checkedContext, setCheckedContext] = useState('')
  const [resumeSaved, setResumeSaved] = useState(true)
  useEffect(() => {
    let active = true
    currentContext.current = context
    setCheckoutLink(null)
    if (
      config.billingApiUrl &&
      organizationMembersStatus === 'ready' &&
      subject &&
      organizationId &&
      authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER
    ) {
      void Promise.all([walletQuery.refetch(), planQuery.refetch(), plansQuery.refetch()]).then(() => {
        if (active) setCheckedContext(context)
      })
    }
    return () => {
      active = false
      currentContext.current = ''
      contextGeneration.current += 1
    }
  }, [context, returned])

  // Members load in the background from an empty list
  // (SelectedOrganizationProvider.tsx:97-113), so a missing member means
  // "not resolved yet" just as often as "not an owner". Redirecting on it
  // would bounce a real owner off their own deep link on every refresh.
  const membersResolved = organizationMembersStatus === 'ready'
  const isOwner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER

  if (!config.billingApiUrl) {
    return <Navigate to={RoutePath.BILLING} replace />
  }
  if (selectedOrganization && organizationMembersStatus === 'error') {
    return (
      <PlanChangeShell>
        <Notice title="Could not verify billing permissions">
          Try again to check your role in {selectedOrganization.name}.
          <AsciiButton className="mt-3" onClick={() => void refreshOrganizationMembers().catch(() => undefined)}>
            Retry permissions
          </AsciiButton>
        </Notice>
      </PlanChangeShell>
    )
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
          <span className="font-sans text-body text-foreground">Oops, something went wrong</span>
          <span className="font-sans text-meta text-muted-foreground">There was an error loading billing data.</span>
          <Button
            variant="outline"
            className="mt-1 font-sans text-meta"
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
  if (
    !plansQuery.isSuccess ||
    !planQuery.isSuccess ||
    !walletQuery.isSuccess ||
    checkedContext !== context ||
    walletQuery.isFetching ||
    planQuery.isFetching ||
    plansQuery.isFetching ||
    walletQuery.isPlaceholderData ||
    planQuery.isPlaceholderData ||
    plansQuery.isPlaceholderData
  ) {
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
    if (pending || (returned && !walletQuery.data?.creditCardConnected)) return
    const generation = contextGeneration.current
    const isCurrent = () => currentContext.current === context && contextGeneration.current === generation
    try {
      if (summary.action === 'upgrade') {
        const checkoutUrl = await upgradePlan.mutateAsync({ organizationId: selectedOrganization.id, planId })
        if (!isCurrent()) return
        if (checkoutUrl) {
          if (!walletQuery.data?.creditCardConnected && subject) {
            setResumeSaved(savePlanSetup(subject, organizationId, planId))
          }
          // Hold the pending state through the hand-off: the browser takes a
          // moment to leave, and an idle-looking button invites a second click.
          setCheckoutLink(checkoutUrl)
          window.location.href = checkoutUrl
          return
        }
        toast.success('Plan upgraded successfully')
      } else {
        await downgradePlan.mutateAsync({ organizationId: selectedOrganization.id, planId })
        if (!isCurrent()) return
        // Name the plan and the day: "at the next billing cycle" left the user
        // to go looking for when that is.
        toast.success(`${summary.target?.name ?? 'Your new plan'} starts ${rollDay}`)
      }
      // `replace` so Back does not return to a confirmation for a plan the
      // organization now holds.
      discardPlanSetup(subject, organizationId)
      navigate(RoutePath.BILLING, { replace: true })
    } catch (error) {
      if (!isCurrent()) return
      handleApiError(error, `Failed to ${summary.action} organization plan`)
    }
  }

  return (
    <PlanChangeShell title={summary.direction === 'subscribe' ? `Subscribe to ${summary.target?.name}` : summary.title}>
      <div className="flex max-w-2xl flex-col gap-6">
        {returned && (
          <Notice
            title={
              walletQuery.data?.creditCardConnected
                ? 'Card added. Confirm your plan.'
                : 'Card setup is not confirmed yet.'
            }
          >
            {walletQuery.data?.creditCardConnected
              ? `Your ${summary.target?.name} selection is ready. Review the details and confirm to continue.`
              : 'Complete card verification, then check again. Your selected plan is saved on this page.'}
            {!walletQuery.data?.creditCardConnected && (
              <AsciiButton
                className="mt-3"
                onClick={() => {
                  void walletQuery.refetch()
                }}
              >
                Check card status
              </AsciiButton>
            )}
          </Notice>
        )}
        {returned && (
          <PanelNote>
            Trial eligibility is checked when you confirm. If you are not eligible, the plan’s subscription price may be
            charged.
          </PanelNote>
        )}

        <section>
          <SectionTitle title={summary.target?.name ?? planId} />
          <Panel className="px-[22px] py-2">
            {summary.comparisons.map((comparison) =>
              summary.direction === 'subscribe' ? (
                <div
                  key={comparison.label}
                  className="flex justify-between gap-6 border-b border-border py-4 last:border-0"
                >
                  <span className="text-body text-muted-foreground">
                    {comparison.label === 'Included quota'
                      ? 'Included usage / month'
                      : comparison.label === 'Concurrency'
                        ? 'Concurrent Boxes'
                        : 'Monthly price'}
                  </span>
                  <span className="font-mono text-body">{comparison.to}</span>
                </div>
              ) : (
                <ComparisonRow key={comparison.label} comparison={comparison} />
              ),
            )}
          </Panel>
          {!returned && (
            <PanelNote>
              {summary.action === 'upgrade' && !walletQuery.data?.creditCardConnected
                ? 'Verify your card in Stripe, then return here to confirm your selected plan.'
                : summary.effect}
            </PanelNote>
          )}
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

        {!resumeSaved && (
          <PanelNote>
            Your browser could not save the selection. Return to Plans after card setup to select this plan again.
          </PanelNote>
        )}
        {checkoutLink && (
          <p role="status" className="text-body text-muted-foreground">
            Checkout not opening?{' '}
            <a href={checkoutLink} className="underline">
              Continue to Stripe →
            </a>
          </p>
        )}
        {summary.blocked?.kind === 'already-queued' ? (
          <Notice title="Already scheduled">{summary.blocked.text}</Notice>
        ) : (
          <div className="flex items-center gap-3">
            <AsciiButton
              variant="primary"
              disabled={pending || (returned && !walletQuery.data?.creditCardConnected)}
              onClick={handleConfirm}
              className="inline-flex items-center gap-2"
            >
              {pending && <Spinner className="size-3.5" />}
              {leaving
                ? 'Redirecting to Stripe…'
                : returned
                  ? 'Confirm subscription'
                  : summary.action === 'upgrade' && !walletQuery.data?.creditCardConnected
                    ? 'Verify card to continue'
                    : summary.confirmLabel}
            </AsciiButton>
            {/* Once checkout exists, leaving this page does not cancel the payment. */}
            <AsciiButton
              disabled={upgradePlan.isPending || downgradePlan.isPending}
              onClick={() => {
                discardPlanSetup(subject, organizationId)
                navigate(RoutePath.BILLING)
              }}
            >
              Back to Billing
            </AsciiButton>
          </div>
        )}
      </div>
    </PlanChangeShell>
  )
}

function PlanChangeShell({ title = 'Change plan', children }: { title?: string; children: React.ReactNode }) {
  usePageTitle(title)
  const navigate = useNavigate()
  const { user } = useAuth()
  const { selectedOrganization } = useSelectedOrganization()

  return (
    <div className="page-container">
      <div className="flex flex-col gap-6 py-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label="Back to Billing"
            title="Back to Billing"
            onClick={() => {
              if (user?.profile.sub && selectedOrganization) discardPlanSetup(user.profile.sub, selectedOrganization.id)
              navigate(RoutePath.BILLING)
            }}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="font-display text-page font-semibold leading-none tracking-tight">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  )
}

function ComparisonRow({ comparison }: { comparison: PlanComparison }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-3 font-sans text-meta last:border-b-0">
      <span className="uppercase tracking-[0.5px] text-muted-foreground">{comparison.label}</span>
      <span className="flex items-baseline gap-2 font-mono tabular-nums">
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
      className={`font-sans text-meta leading-relaxed ${
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
      <span className="font-sans text-body text-foreground">{title}</span>
      <span className="font-sans text-meta leading-relaxed text-muted-foreground">{children}</span>
    </Panel>
  )
}

export default BillingPlanChange
