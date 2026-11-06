/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useCallback, useEffect, useRef, useState, type Ref } from 'react'
import { AsciiButton } from '@/components/ascii'
import { ArrowRightIcon, Check, CreditCardIcon, Loader2 } from '@/components/ui/icon'
import { useConnectCard } from '@/hooks/useConnectCard'
import { useRedeemCouponMutation } from '@/hooks/mutations/useRedeemCouponMutation'
import { useOwnerPaymentMethodsQuery, useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import type { FirstRunUseCase } from '@/lib/first-run'
import WelcomeBoxIllustration from './WelcomeBoxIllustration'

const PURPOSE: Record<FirstRunUseCase, { heading: string; ending: string; description: string }> = {
  'coding-agent': {
    heading: 'Your agent.',
    ending: 'Its own Box.',
    description: 'Give your coding agent a place to write code, run tests, and get things done.',
  },
  'long-running-agent': {
    heading: 'Your agent.',
    ending: 'Its own Box.',
    description: 'Give your agent a dedicated environment for its tools, files, and long-running tasks.',
  },
  'code-execution': {
    heading: 'Your code.',
    ending: 'Room to run.',
    description: 'Run tests and CI jobs in an isolated Box, with the tools and dependencies you need.',
  },
  'browser-agent': {
    heading: 'Your browser.',
    ending: 'Its own Box.',
    description: 'Give your browser automation a Box to run in, from a single test to a complete workflow.',
  },
  'application-deployments': {
    heading: 'Your next app.',
    ending: 'Starts in a Box.',
    description: 'Give your agent a Box to build your app, run a server, and share a preview.',
  },
  'reinforcement-learning': {
    heading: 'Your experiments.',
    ending: 'Their own Boxes.',
    description: 'Give each experiment an isolated environment to run, evaluate, and iterate.',
  },
  exploring: {
    heading: 'Your next idea.',
    ending: 'Starts in a Box.',
    description: 'Run code, build with agents, or launch an app. Start with a Box and make it yours.',
  },
}

export default function WelcomeCreditsStep({
  onBack,
  onContinue,
  useCase,
  illustrationRef,
}: {
  onBack: () => void
  onContinue: () => void
  useCase?: FirstRunUseCase | null
  illustrationRef?: Ref<HTMLDivElement>
}) {
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const isOwner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER
  const { connectCard, isPending: connecting } = useConnectCard()
  const wallet = useOwnerWalletQuery({
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    placeholderData: undefined,
  })
  const paymentMethods = useOwnerPaymentMethodsQuery()
  const redeem = useRedeemCouponMutation()
  const [couponCode, setCouponCode] = useState('')
  const [couponError, setCouponError] = useState<string | null>(null)
  const [couponMessage, setCouponMessage] = useState<string | null>(null)
  const [checkoutStarted, setCheckoutStarted] = useState(false)
  const successHeading = useRef<HTMLHeadingElement>(null)
  const connected = isOwner && !wallet.isError && wallet.data?.creditCardConnected === true
  const ready = connected || couponMessage !== null
  const busy = connecting || redeem.isPending
  const purpose = PURPOSE[useCase ?? 'exploring']
  const method = paymentMethods.data?.find((card) => card.isDefault) ?? paymentMethods.data?.[0]
  const last4 = method?.details.last4
  const brand = typeof method?.details.brand === 'string' ? method.details.brand : 'Card'
  const { refetch: refreshWallet } = wallet
  const { refetch: refreshMethods } = paymentMethods
  const refreshCard = useCallback(() => {
    if (isOwner) void Promise.all([refreshWallet(), refreshMethods()])
  }, [isOwner, refreshWallet, refreshMethods])

  useEffect(() => {
    // Stripe opens in another tab; returning must bypass the ordinary wallet cache.
    window.addEventListener('focus', refreshCard)
    return () => window.removeEventListener('focus', refreshCard)
  }, [refreshCard])

  useEffect(() => {
    if (couponMessage !== null) successHeading.current?.focus()
  }, [couponMessage])

  return (
    <section aria-label="Get credits" className="grid gap-9 lg:grid-cols-[1.2fr_1fr] lg:gap-16">
      <div>
        <h1 className="text-[38px] font-medium leading-[1.08] tracking-[-0.045em] sm:text-[52px] lg:text-[58px]">
          {purpose.heading}
          <span className="block text-muted-foreground">{purpose.ending}</span>
        </h1>
        <p className="mt-5 max-w-[390px] text-[15px] leading-7 text-muted-foreground">{purpose.description}</p>
        <div ref={illustrationRef} className="mt-10 hidden max-w-[420px] lg:block">
          {illustrationRef ? <div className="aspect-[480/310]" /> : <WelcomeBoxIllustration />}
        </div>
      </div>

      <div className="border-t border-border pt-7 lg:border-l lg:border-t-0 lg:pl-14 lg:pt-1">
        {!ready && (
          <>
            <p className="font-mono text-label text-muted-foreground">WELCOME CREDIT</p>
            <p className="mt-5 flex items-start tracking-[-0.06em]">
              <span className="sr-only">$100</span>
              <span aria-hidden className="mr-1.5 mt-2 text-[32px] font-normal leading-none sm:mt-3 sm:text-[40px]">
                $
              </span>
              <span aria-hidden className="text-[76px] font-medium leading-[0.95] sm:text-[96px]">
                100
              </span>
            </p>
            <h2 className="mt-3 text-em font-medium">in free BoxLite credits</h2>
          </>
        )}
        {ready && (
          <>
            <h2 ref={successHeading} tabIndex={-1} className="mt-3 text-em font-medium">
              {couponMessage ? 'Promo code redeemed' : 'Card connected'}
            </h2>
            <p className="mt-7 text-sm leading-6 text-muted-foreground">
              {couponMessage ?? 'Choose how you want to build. Your first Box is next.'}
            </p>
            {connected && (
              <p className="mt-5 flex items-center gap-2.5 text-xs">
                <Check className="size-4 text-brand" aria-hidden />
                {typeof last4 === 'string' ? `${brand} ending in ${last4}` : 'Payment method connected'}
              </p>
            )}
          </>
        )}

        <div aria-live="polite" className="text-sm leading-6 [&:not(:empty)]:mt-5">
          {busy && (
            <p role="status" className="flex items-center gap-2">
              <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
              {connecting ? 'Opening Stripe…' : 'Redeeming your code…'}
            </p>
          )}
          {wallet.isError && <p role="alert">Could not load your card status. Please try again.</p>}
        </div>

        <div className="mt-7 flex flex-col items-stretch gap-4">
          {ready ? (
            <AsciiButton
              variant="primary"
              className="flex h-12 items-center justify-between px-5 font-display text-sm"
              onClick={onContinue}
            >
              Start quickstart <ArrowRightIcon aria-hidden className="size-4" />
            </AsciiButton>
          ) : isOwner ? (
            <AsciiButton
              variant="primary"
              disabled={busy}
              className="flex h-12 items-center justify-between px-5 font-display text-sm"
              onClick={() => {
                setCheckoutStarted(true)
                void connectCard()
              }}
            >
              <span className="flex items-center gap-2.5">
                {!busy && <CreditCardIcon aria-hidden className="size-4 shrink-0" />}
                {busy ? 'Please wait…' : 'Verify card & claim $100'}
              </span>
              {!busy && <ArrowRightIcon aria-hidden className="size-4" />}
            </AsciiButton>
          ) : (
            <p className="text-sm text-muted-foreground">Only organization owners can manage billing.</p>
          )}
        </div>

        {!ready && isOwner && (
          <>
            <p className="mt-5 text-xs leading-5 text-muted-foreground">
              No verification fee. No paid plan is activated.
            </p>
            {(checkoutStarted || wallet.isError) && (
              <button
                type="button"
                onClick={refreshCard}
                disabled={wallet.isFetching || paymentMethods.isFetching}
                className="mt-3 text-xs text-muted-foreground underline-offset-4 hover:underline disabled:opacity-40"
              >
                Check card status
              </button>
            )}
            <div className="mt-6">
              <div aria-hidden="true" className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <form
                className="mt-5"
                noValidate
                onSubmit={async (event) => {
                  event.preventDefault()
                  if (busy || !selectedOrganization) return
                  setCouponError(null)
                  if (!couponCode) {
                    setCouponError('Enter a promo code.')
                    return
                  }
                  try {
                    const message = await redeem.mutateAsync({ organizationId: selectedOrganization.id, couponCode })
                    setCouponMessage(message)
                    setCouponCode('')
                  } catch (error) {
                    setCouponError(String(error))
                  }
                }}
              >
                <label htmlFor="welcome-promo-code" className="mb-2 block text-xs text-muted-foreground">
                  Promo code
                </label>
                <div className="flex gap-2">
                  <input
                    id="welcome-promo-code"
                    value={couponCode}
                    onChange={(event) => {
                      setCouponCode(event.target.value)
                      setCouponError(null)
                    }}
                    placeholder="Enter your code"
                    disabled={busy}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!!couponError}
                    aria-describedby={couponError ? 'welcome-promo-error' : undefined}
                    className="h-11 min-w-0 flex-1 border border-border bg-background px-3 font-mono text-sm outline-none focus:border-foreground disabled:opacity-50"
                  />
                  <AsciiButton type="submit" disabled={busy} className="h-11 px-4 font-display text-sm">
                    Redeem
                  </AsciiButton>
                </div>
                {couponError && (
                  <p id="welcome-promo-error" role="alert" className="mt-2 text-xs text-destructive">
                    {couponError}
                  </p>
                )}
              </form>
            </div>
          </>
        )}
        {!ready && (
          <div className="mt-6 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-4">
              <button
                type="button"
                disabled={busy}
                onClick={onBack}
                className="py-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-40"
              >
                Back
              </button>
              <button
                type="button"
                onClick={onContinue}
                className="flex items-center gap-2 py-2 text-sm underline-offset-4 hover:underline"
              >
                Explore with BoxLite <ArrowRightIcon aria-hidden className="size-4" />
              </button>
            </div>
            <p className="mt-2 text-right text-xs leading-5 text-muted-foreground">
              You’ll need credits to create a Box.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
