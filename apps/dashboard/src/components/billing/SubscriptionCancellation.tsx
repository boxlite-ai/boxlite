/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { format } from 'date-fns'
import type { OrganizationPlan } from '@/billing-api'
import type { CancellationFeedbackInput } from '@/api/apiClient'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { FormDialogBody, FormDialogContent, FormDialogFooter, FormDialogHeader } from '@/components/ui/form-dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { useKeepPlanMutation } from '@/hooks/mutations/useKeepPlanMutation'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'

const reasons = [
  ['not_tried', 'I haven’t had time to try it'],
  ['no_workload', 'No workloads to run right now'],
  ['setup', 'Getting started was too difficult'],
  ['missing_features', 'Missing features I need'],
  ['reliability', 'Reliability or data concerns'],
  ['performance', 'Performance or resources don’t fit'],
  ['pricing', 'Pricing or billing doesn’t fit'],
  ['limits', 'Plan limits got in the way'],
  ['alternative', 'Using another service or self-hosting'],
  ['completed', 'My project is complete'],
  ['other', 'Other — tell us more'],
]
const intents = [
  ['evaluate', 'Evaluate for a future project'],
  ['one_off', 'Complete a one-time task or project'],
  ['ongoing', 'Run ongoing apps, CI, or other workloads'],
  ['explore', 'Explore without a specific task'],
  ['unsure', 'Other / not sure'],
]

const CancellationContext = createContext<((plan: OrganizationPlan) => void) | null>(null)

/** One controller survives tab switches and the current plan disappearing after cancellation. */
export function SubscriptionCancellationProvider({ children }: { children: ReactNode }) {
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const owner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER
  if (!selectedOrganization || !owner) return <>{children}</>
  return (
    <CancellationController key={selectedOrganization.id} organizationId={selectedOrganization.id}>
      {children}
    </CancellationController>
  )
}

function CancellationController({ organizationId, children }: { organizationId: string; children: ReactNode }) {
  const { selectedOrganization } = useSelectedOrganization()
  const api = useApi()
  const { billingApi } = api
  const queryClient = useQueryClient()
  const [plan, setPlan] = useState<OrganizationPlan | null>(null)
  const [open, setOpen] = useState(false)
  const [selectedReasons, setReasons] = useState<string[]>([])
  const [intent, setIntent] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [unsaved, setUnsaved] = useState<CancellationFeedbackInput | null>(null)
  const [saved, setSaved] = useState(false)
  const mounted = useRef(true)
  const busy = useRef(false)
  const [attempted, setAttempted] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const trial = plan?.trial?.conversionState === 'not_attempted'
  const converting = plan?.trial && plan.trial.conversionState !== 'succeeded' && !trial
  const ends = plan ? format(plan.cycleTo, 'MMM d, yyyy') : ''

  async function refresh() {
    const current = await billingApi.getOrganizationPlan(organizationId, 10_000)
    queryClient.setQueryData(queryKeys.organization.plan(organizationId), current)
    void queryClient.invalidateQueries({ queryKey: queryKeys.organization.detail(organizationId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.organization.usage.overview(organizationId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.billing.invoices(organizationId) })
    return current
  }
  function canceled(current: OrganizationPlan) {
    return current.cancelAtPeriodEnd || current.status === 'canceled'
  }
  function sameTerms(current: OrganizationPlan) {
    return (
      plan !== null &&
      current.planId === plan.planId &&
      current.cycleTo.getTime() === plan.cycleTo.getTime() &&
      current.trial?.conversionState === plan.trial?.conversionState
    )
  }
  async function complete() {
    if (!mounted.current) return
    const feedback = {
      reasons: selectedReasons,
      intent: intent || null,
      note: selectedReasons.includes('other') ? note.trim() : '',
    }
    setConfirmation('Cancellation confirmed. Your plan shows the latest renewal status.')
    setOpen(false)
    setAttempted(false)
    setUnsaved(null)
    setSaved(false)
    if (!feedback.reasons.length && !feedback.intent && !feedback.note) return
    try {
      await api.saveCancellationFeedback(organizationId, feedback)
      if (mounted.current) setSaved(true)
    } catch {
      if (mounted.current) setUnsaved(feedback)
    }
  }
  async function submit() {
    if (busy.current || !plan) return
    busy.current = true
    setPending(true)
    setError('')
    try {
      const current = await refresh()
      if (!mounted.current) return
      if (!current) throw new Error('Plan status unavailable')
      if (!sameTerms(current)) {
        setPlan(current)
        setAttempted(false)
        setError('Your plan changed. Review the updated details before confirming again.')
        return
      }
      if (canceled(current)) {
        await complete()
        return
      }
      if (attempted) {
        setAttempted(false)
        setPlan(current)
        setError('Renewal is still on. Review your plan and confirm again to cancel.')
        return
      }
      setAttempted(true)
      try {
        await billingApi.downgradePlan(organizationId, null, 15_000)
      } catch {
        // A lost response can still mean success. Read state; never replay this POST automatically.
      }
      if (!mounted.current) return
      const updated = await refresh()
      if (!mounted.current) return
      if (updated && sameTerms(updated) && canceled(updated)) await complete()
      else setError('Cancellation could not be confirmed. Your answers are kept. Check status before trying again.')
    } catch {
      if (mounted.current)
        setError('Cancellation could not be confirmed. Your answers are kept. Try checking the plan again.')
    } finally {
      busy.current = false
      if (mounted.current) setPending(false)
    }
  }
  async function retryFeedback() {
    if (!unsaved || busy.current) return
    busy.current = true
    setPending(true)
    try {
      await api.saveCancellationFeedback(organizationId, unsaved)
      if (mounted.current) {
        setUnsaved(null)
        setSaved(true)
      }
    } catch {
      /* Keep the latest unaccepted feedback available for retry. */
    } finally {
      busy.current = false
      if (mounted.current) setPending(false)
    }
  }
  function start(current: OrganizationPlan) {
    if (busy.current) return
    if (attempted) {
      setOpen(true)
      return
    }
    setPlan(current)
    setConfirmation('')
    setReasons([])
    setIntent('')
    setNote('')
    setError('')
    setSaved(false)
    setOpen(true)
  }
  return (
    <CancellationContext.Provider value={start}>
      {confirmation && (
        <p role="status" className="page-container py-3 text-body">
          {confirmation}
        </p>
      )}
      {!open && attempted && (
        <div role="alert" className="page-container py-3 text-body">
          Cancellation has not been confirmed. Your answers are kept.{' '}
          <Button variant="outline" onClick={() => setOpen(true)}>
            Check cancellation
          </Button>
        </div>
      )}
      {(unsaved || saved) && (
        <div role="status" className="page-container flex flex-wrap items-center justify-between gap-3 py-4">
          <p className="text-body">
            {unsaved
              ? 'Cancellation confirmed. Your feedback wasn’t saved.'
              : 'Your cancellation feedback has been saved.'}
          </p>
          {unsaved && (
            <Button variant="outline" disabled={pending} onClick={retryFeedback}>
              {pending && <Spinner />}Retry feedback
            </Button>
          )}
        </div>
      )}
      {children}
      {plan && (
        <Dialog
          open={open}
          onOpenChange={(value) => {
            if (!busy.current) setOpen(value)
          }}
        >
          <FormDialogContent className="sm:max-w-[660px]" showCloseButton={!pending}>
            <FormDialogHeader>
              <DialogTitle>Cancel subscription?</DialogTitle>
              <DialogDescription>Turn off automatic renewal for {selectedOrganization?.name}.</DialogDescription>
            </FormDialogHeader>
            <FormDialogBody className="space-y-5">
              <dl className="space-y-3 bg-secondary px-4 py-4 text-body">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Current plan</dt>
                  <dd>{plan.planName}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{trial ? 'Trial access until' : 'Plan access until'}</dt>
                  <dd>{ends}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">After cancellation</dt>
                  <dd>Automatic renewal off</dd>
                </div>
              </dl>
              <p className="text-body">
                {converting
                  ? 'Trial conversion is already in progress. A payment may already be processing. Canceling stops renewal; a completed conversion payment is handled by billing.'
                  : trial
                    ? `Your trial will not convert to a paid subscription. Trial access continues until ${ends}.`
                    : `Your ${plan.planName} quota and concurrency remain available until ${ends}. Your subscription will not renew.`}
              </p>
              {plan.pendingPlanId && (
                <p className="text-body text-muted-foreground">This replaces your scheduled plan change.</p>
              )}
              <p className="text-body text-muted-foreground">
                Usage charges are separate from subscription renewal. Canceling does not delete your workspace.
              </p>
              <section aria-labelledby="cancellation-feedback-heading" className="border-t border-border pt-4">
                <h3 id="cancellation-feedback-heading" className="text-body font-medium">
                  Share feedback <span className="ml-2 font-normal text-muted-foreground">Optional</span>
                </h3>
                <p className="mt-3 text-body text-muted-foreground">
                  Help us understand your experience. You can cancel without answering.
                </p>
                <fieldset disabled={pending || attempted} className="mt-5">
                  <legend className="text-body font-medium">What made you decide to cancel?</legend>
                  <p className="mb-3 mt-1 text-meta text-muted-foreground">Optional · Select any that apply.</p>
                  <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
                    {reasons.map(([id, label]) => (
                      <label key={id} className="flex cursor-pointer items-start gap-2 text-body">
                        <Checkbox
                          aria-label={label}
                          className="mt-0.5"
                          checked={selectedReasons.includes(id)}
                          onCheckedChange={(checked) =>
                            setReasons((previous) =>
                              checked ? [...previous, id] : previous.filter((value) => value !== id),
                            )
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                  {selectedReasons.includes('other') && (
                    <label className="mt-4 block text-body">
                      Your reason <span className="text-muted-foreground">Optional</span>
                      <Textarea
                        className="mt-2"
                        maxLength={1000}
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Tell us why you’re canceling."
                      />
                      <span className="text-meta text-muted-foreground">Up to 1,000 characters.</span>
                    </label>
                  )}
                </fieldset>
                <fieldset disabled={pending || attempted} className="mt-6">
                  <legend id="cancel-intent" className="text-body font-medium">
                    What did you originally plan to use BoxLite for?
                  </legend>
                  <p className="mb-3 mt-1 text-meta text-muted-foreground">Optional · Select one.</p>
                  <RadioGroup
                    aria-labelledby="cancel-intent"
                    value={intent}
                    onValueChange={setIntent}
                    disabled={pending || attempted}
                  >
                    {intents.map(([id, label]) => (
                      <label key={id} className="flex cursor-pointer items-center gap-2 text-body">
                        <RadioGroupItem value={id} aria-label={label} />
                        {label}
                      </label>
                    ))}
                  </RadioGroup>
                  <Button
                    variant="quiet"
                    size="sm"
                    className="mt-2"
                    onClick={() => setIntent('')}
                    disabled={pending || attempted}
                  >
                    Clear selection
                  </Button>
                </fieldset>
              </section>
              {error && (
                <p
                  role="alert"
                  className="border border-destructive/30 bg-destructive/5 p-3 text-body text-destructive"
                >
                  {error}
                </p>
              )}
            </FormDialogBody>
            <FormDialogFooter className="flex-wrap">
              <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
                {attempted ? 'Close' : 'Keep subscription'}
              </Button>
              <Button variant="destructive" disabled={pending} onClick={submit}>
                {pending && <Spinner className="size-4" />}
                {attempted ? 'Check status' : 'Confirm cancellation'}
              </Button>
            </FormDialogFooter>
          </FormDialogContent>
        </Dialog>
      )}
    </CancellationContext.Provider>
  )
}

export function SubscriptionCancellationAction({
  plan,
  organizationId,
  compact = false,
}: {
  plan: OrganizationPlan
  organizationId: string
  compact?: boolean
}) {
  const start = useContext(CancellationContext)
  const keep = useKeepPlanMutation()
  const [error, setError] = useState(false)
  if (!start || plan.status === 'canceled') return null
  const ends = format(plan.cycleTo, 'MMM d, yyyy')
  const trial = plan.trial && plan.trial.conversionState !== 'succeeded'
  if (plan.cancelAtPeriodEnd)
    return compact ? (
      <div className="space-y-2 text-body">
        <p className="text-muted-foreground">Ends on {ends}</p>
        {!trial && (
          <Button
            variant="outline"
            size="sm"
            disabled={keep.isPending}
            onClick={async () => {
              setError(false)
              try {
                const url = await keep.mutateAsync({ organizationId, planId: plan.planId, kind: 'cancel' })
                if (url) window.location.href = url
              } catch {
                setError(true)
              }
            }}
          >
            Keep subscription
          </Button>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            Couldn’t restore renewal. Try again.
          </p>
        )}
      </div>
    ) : null
  return (
    <div
      className={
        compact
          ? 'text-body'
          : 'flex flex-wrap items-center justify-between gap-3 border-t border-border px-[22px] py-4'
      }
    >
      {!compact && (
        <p className="text-body text-muted-foreground">
          {trial ? 'Trial ends' : 'Renews'} {ends}. Manage automatic renewal here.
        </p>
      )}
      <Button variant="quiet" className={compact ? 'h-auto min-h-7 px-0' : undefined} onClick={() => start(plan)}>
        Cancel subscription
      </Button>
    </div>
  )
}
