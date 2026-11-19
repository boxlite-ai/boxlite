/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useRef, useState, type Ref } from 'react'
import { useNavigate } from 'react-router-dom'
import { AsciiButton } from '@/components/ascii'
import { ArrowRightIcon, Check, CreditCardIcon } from '@/components/ui/icon'
import { PLAN_PRESENTATION, PLAN_BENEFITS } from '@/components/billing/planBenefits'
import { RoutePath } from '@/enums/RoutePath'
import WelcomeBoxIllustration from './WelcomeBoxIllustration'

type Scenario = 'eligible' | 'ineligible' | 'unavailable'
type Stage = 'choose' | 'verify' | 'confirm' | 'active' | 'redeemed'
const plans = PLAN_PRESENTATION.slice(1)
const price = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100)

/** Development-only interaction study. No payment client or billing mutations. */
export default function TrialWelcomePreview({
  organizationName,
  initialScenario = 'eligible',
  onContinue,
  onBack,
  illustrationRef,
}: {
  organizationName: string
  initialScenario?: string
  onContinue?: () => void
  onBack?: () => void
  illustrationRef?: Ref<HTMLDivElement>
}) {
  const navigate = useNavigate()
  const [scenario, setScenario] = useState<Scenario>(
    initialScenario === 'ineligible' || initialScenario === 'unavailable' ? initialScenario : 'eligible',
  )
  const [stage, setStage] = useState<Stage>('choose')
  const [selected, setSelected] = useState(0)
  const [couponOpen, setCouponOpen] = useState(false)
  const [couponCode, setCouponCode] = useState('')
  const [couponError, setCouponError] = useState<string | null>(null)
  const continueToConsole = () => (onContinue ? onContinue() : navigate(RoutePath.QUICKSTART))
  const [verified, setVerified] = useState(false)
  const [endsAt, setEndsAt] = useState<Date | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const plan = plans[selected]
  const eligible = scenario === 'eligible'
  const charge = price(plan.priceCents)
  useEffect(() => {
    heading.current?.focus()
  }, [stage])
  const start = () => {
    if (!verified || scenario === 'unavailable') return
    setEndsAt(new Date(Date.now() + 3 * 86400_000))
    setStage('active')
  }
  const next = () => setStage(verified ? 'confirm' : 'verify')
  const endLabel = endsAt?.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })

  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr] lg:gap-14" aria-label="Choose how to start">
        <div>
          <h1 className="text-[38px] font-medium leading-[1.08] tracking-[-0.045em] sm:text-[52px] lg:text-[58px]">
            Your next idea.
            <span className="block text-muted-foreground">Starts in a Box.</span>
          </h1>
          <p className="mt-4 max-w-[420px] text-body leading-6 text-muted-foreground">
            Give your agents, code, and apps a Box of their own.
          </p>
          <div ref={illustrationRef} className="mt-4 hidden w-full max-w-[420px] lg:block" aria-hidden>
            {illustrationRef ? <div className="aspect-[480/310]" /> : <WelcomeBoxIllustration />}
          </div>
        </div>
        <div className="border-t border-border pt-7 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
          <p className="mb-2 text-meta text-muted-foreground">
            For <span className="font-medium text-foreground">{organizationName}</span>
          </p>
          <h2 ref={heading} tabIndex={-1} className="text-section font-medium tracking-tight outline-none">
            {stage === 'redeemed'
              ? 'Coupon redeemed'
              : stage === 'choose'
                ? eligible
                  ? 'Try a plan free for 3 days'
                  : 'Choose how to get started'
                : stage === 'verify'
                  ? 'Verify your card'
                  : stage === 'confirm'
                    ? eligible
                      ? 'Your trial, at a glance'
                      : 'Review your subscription'
                    : eligible
                      ? 'Your trial is ready.'
                      : 'Your plan is ready.'}
          </h2>

          {stage === 'choose' && (
            <>
              <fieldset className="mt-4 space-y-2">
                <legend className="sr-only">Select a plan</legend>
                {plans.map((option, index) => (
                  <label
                    key={option.name}
                    className={`relative flex cursor-pointer items-start gap-3 border px-4 py-3 transition-colors hover:bg-accent/40 ${selected === index ? 'border-foreground bg-accent/20' : 'border-border'}`}
                  >
                    <input
                      type="radio"
                      name="trial-plan"
                      value={option.name}
                      checked={selected === index}
                      onChange={() => setSelected(index)}
                      className="peer sr-only"
                    />
                    <span
                      aria-hidden
                      className={`mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 ${selected === index ? 'border-foreground' : 'border-muted-foreground'}`}
                    >
                      {selected === index && <span className="size-2 rounded-full bg-foreground" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="text-em font-medium">{option.name}</span>
                        <span className="text-right text-body">
                          {eligible && <span className="block font-medium">Free for 3 days</span>}
                          <span className="block text-meta text-muted-foreground">
                            {eligible ? 'Then ' : ''}
                            {price(option.priceCents)} / month
                          </span>
                        </span>
                      </span>
                      <span className="mt-1 block text-meta text-muted-foreground">
                        Up to {PLAN_BENEFITS[0].rows.find((row) => row.label === 'Max concurrency')?.values[index + 1]}{' '}
                        running Boxes
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {scenario === 'unavailable' ? (
                <div role="alert" className="mt-5 text-body leading-6">
                  <p>We couldn’t check your trial eligibility.</p>
                  <p className="text-muted-foreground">Try again before continuing. Nothing has been activated.</p>
                  <AsciiButton className="mt-4 w-full justify-center" onClick={() => setScenario('eligible')}>
                    Try again
                  </AsciiButton>
                </div>
              ) : (
                <>
                  {scenario === 'ineligible' && (
                    <p role="status" className="mt-5 text-body leading-6 text-muted-foreground">
                      This account isn’t eligible for another trial. You can review a paid subscription before
                      confirming.
                    </p>
                  )}
                  <AsciiButton variant="primary" className="mt-4 flex w-full justify-between px-5 py-3" onClick={next}>
                    {verified
                      ? 'Continue to confirmation'
                      : eligible
                        ? 'Continue to free trial'
                        : 'Continue with ' + plan.name}
                    <ArrowRightIcon aria-hidden className="size-4" />
                  </AsciiButton>
                  <p className="mt-3 text-meta leading-5 text-muted-foreground">
                    {eligible
                      ? 'For eligible first-time subscribers. Card required. Cancel before renewal to avoid the subscription fee.'
                      : 'Nothing is charged until you confirm your subscription.'}
                  </p>
                </>
              )}
              <div className="mt-4 border-t border-border pt-2">
                <button
                  type="button"
                  aria-expanded={couponOpen}
                  aria-controls="trial-coupon-form"
                  onClick={() => setCouponOpen(!couponOpen)}
                  className="py-2 text-body underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Have a coupon? Redeem code
                </button>
                {couponOpen && (
                  <div id="trial-coupon-form" className="mt-3">
                    <form
                      noValidate
                      onSubmit={(event) => {
                        event.preventDefault()
                        const code = couponCode.trim()
                        if (!code) {
                          setCouponError('Enter a coupon code.')
                          return
                        }
                        if (code !== 'ACME50') {
                          setCouponError('This code is invalid or expired. Check it and try again.')
                          return
                        }
                        setCouponError(null)
                        setStage('redeemed')
                      }}
                    >
                      <label htmlFor="trial-coupon" className="mb-2 block text-meta">
                        Coupon code
                      </label>
                      <div className="flex gap-2">
                        <input
                          id="trial-coupon"
                          value={couponCode}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) => {
                            setCouponCode(event.target.value)
                            setCouponError(null)
                          }}
                          aria-invalid={!!couponError}
                          aria-describedby={couponError ? 'trial-coupon-error' : undefined}
                          placeholder="Enter your code"
                          className="h-11 min-w-0 flex-1 border border-border bg-background px-3 font-mono text-body outline-none focus:border-foreground"
                        />
                        <AsciiButton type="submit" className="h-11 px-4">
                          Redeem
                        </AsciiButton>
                      </div>
                      {couponError && (
                        <p id="trial-coupon-error" role="alert" className="mt-2 text-meta text-destructive">
                          {couponError}
                        </p>
                      )}
                    </form>
                  </div>
                )}
                <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  {onBack && (
                    <button
                      type="button"
                      onClick={onBack}
                      className="py-2 text-body text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Back
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={continueToConsole}
                    className="py-2 text-body underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    Explore console — no card required
                  </button>
                </div>
              </div>
            </>
          )}

          {stage === 'redeemed' && (
            <div role="status">
              <p className="mt-4 text-body text-muted-foreground">
                Your credits are ready. No card or subscription required.
              </p>
              <AsciiButton
                variant="primary"
                className="mt-6 flex w-full justify-between px-5 py-3"
                onClick={continueToConsole}
              >
                Continue to console <ArrowRightIcon aria-hidden className="size-4" />
              </AsciiButton>
            </div>
          )}

          {stage === 'verify' && (
            <>
              <p className="mt-3 text-body leading-6 text-muted-foreground">
                Keep {plan.name} selected while you verify your payment method. You’ll review everything before you
                start.
              </p>
              <div className="my-6 flex items-center gap-3 border-y border-border py-4">
                <CreditCardIcon className="size-5 text-muted-foreground" aria-hidden />
                <span className="text-body">Card verification</span>
                <span className="ml-auto text-meta text-muted-foreground">Not connected</span>
              </div>
              <p className="text-body leading-6 text-muted-foreground">
                A temporary $0.50 hold verifies your card and is released afterward. This does not activate a
                subscription.
              </p>
              <div className="mt-6">
                <AsciiButton
                  variant="primary"
                  className="mt-3 flex w-full justify-between px-4 py-3"
                  onClick={() => {
                    setVerified(true)
                    setStage('confirm')
                  }}
                >
                  Verify card
                  <ArrowRightIcon aria-hidden className="size-4" />
                </AsciiButton>
              </div>
              <button
                className="mt-5 text-body text-muted-foreground underline underline-offset-4 hover:text-foreground"
                onClick={() => setStage('choose')}
              >
                Back to plans
              </button>
            </>
          )}

          {stage === 'confirm' && (
            <>
              <p className="mt-3 flex items-center gap-2 text-body">
                <Check className="size-4 text-brand" aria-hidden />
                Card verified<span className="text-muted-foreground">· Visa ending in 4242</span>
              </p>
              <dl className="my-6 space-y-4 border-y border-border py-5 text-body">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Plan</dt>
                  <dd>{plan.name}</dd>
                </div>
                <div className="flex items-baseline justify-between">
                  <dt className="text-muted-foreground">Subscription fee today</dt>
                  <dd className="text-page font-medium">{eligible ? '$0' : charge}</dd>
                </div>
                {eligible && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Free trial</dt>
                    <dd>3 days from activation</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{eligible ? 'After your trial' : 'Renews at'}</dt>
                  <dd>{charge} / month</dd>
                </div>
              </dl>
              <p className="text-body leading-6 text-muted-foreground">
                {eligible
                  ? `Your ${plan.name} subscription renews at ${charge}/month after 3 days unless you cancel in Billing before the trial ends.`
                  : `Your ${plan.name} subscription starts with a ${charge} payment and renews monthly. Manage or cancel it in Billing.`}
              </p>
              <p className="mt-3 text-meta leading-5 text-muted-foreground">
                Plan usage limits apply. Additional resource usage may incur charges.
              </p>
              <AsciiButton variant="primary" className="mt-6 flex w-full justify-between px-5 py-3" onClick={start}>
                {eligible ? 'Start 3-day trial' : `Subscribe for ${charge}/month`}
                <ArrowRightIcon aria-hidden className="size-4" />
              </AsciiButton>
              <button
                className="mt-4 text-body text-muted-foreground underline underline-offset-4 hover:text-foreground"
                onClick={() => setStage('choose')}
              >
                Change plan
              </button>
            </>
          )}

          {stage === 'active' && (
            <div role="status">
              <div className="my-6 flex size-11 items-center justify-center border border-border">
                <Check className="size-5 text-brand" aria-hidden />
              </div>
              <p className="text-em leading-7">
                {plan.name} is active for {organizationName}.
              </p>
              {eligible && (
                <p className="mt-3 text-body leading-6 text-muted-foreground">
                  Your trial ends {endLabel}. Then {charge}/month unless you cancel in Billing.
                </p>
              )}
              <AsciiButton
                variant="primary"
                className="mt-7 flex w-full justify-between px-5 py-3"
                onClick={continueToConsole}
              >
                Create your first Box
                <ArrowRightIcon aria-hidden className="size-4" />
              </AsciiButton>
              <p className="mt-4 text-meta text-muted-foreground">Start with a template, your own code, or an agent.</p>
            </div>
          )}
        </div>
      </section>
    </>
  )
}
