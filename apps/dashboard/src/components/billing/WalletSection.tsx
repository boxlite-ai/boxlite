/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AutomaticTopUp } from '@/billing-api/types/OrganizationWallet'
import { AsciiButton, AsciiChip, BRAND, Panel, PanelNote, SectionTitle, SegmentedBar } from '@/components/ascii'
import { BalanceThresholdBanner } from '@/components/billing/BalanceLowBanner'
import { WalletTransactionsTable } from '@/components/WalletTransactions'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useRedeemCouponMutation } from '@/hooks/mutations/useRedeemCouponMutation'
import { useSetAutomaticTopUpMutation } from '@/hooks/mutations/useSetAutomaticTopUpMutation'
import { useTopUpWalletMutation } from '@/hooks/mutations/useTopUpWalletMutation'
import {
  useFetchOwnerCheckoutUrlQuery,
  useIsOwnerCheckoutUrlFetching,
  useOwnerBillingPortalUrlQuery,
  useOwnerPaymentMethodsQuery,
  useOwnerPlanQuery,
  useOwnerWalletTransactionsQuery,
  useOwnerWalletQuery,
} from '@/hooks/queries/billingQueries'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { formatAmount } from '@/lib/utils'
import { ArrowUpRight } from '@/components/ui/icon'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { NumericFormat } from 'react-number-format'
import { useAuth } from 'react-oidc-context'
import { toast } from 'sonner'
import { PaymentMethodsPanel } from './PaymentMethodsPanel'

const TRANSACTION_HISTORY_LIMIT = 100

/** Commerce rejects anything smaller, so the form says so before the round trip. */
export const MIN_TOP_UP_DOLLARS = 10

/**
 * What an unconfigured auto-reload starts at, so switching it on is one click
 * rather than a policy decision the user has to invent.
 */
const DEFAULT_AUTO_RELOAD: AutomaticTopUp = { thresholdAmount: 20, targetAmount: 100 }

/** Whether Top up can run, and why not when it cannot. */
export function topUpGate(amountDollars: number | undefined): { enabled: boolean; reason: string | null } {
  if (!amountDollars) {
    return { enabled: false, reason: null }
  }
  if (amountDollars < MIN_TOP_UP_DOLLARS) {
    return { enabled: false, reason: `Minimum top-up is $${MIN_TOP_UP_DOLLARS}.` }
  }
  return { enabled: true, reason: null }
}

export function WalletSection() {
  const { selectedOrganization } = useSelectedOrganization()
  const { user } = useAuth()
  const [automaticTopUp, setAutomaticTopUp] = useState<AutomaticTopUp | undefined>(undefined)
  const [couponCode, setCouponCode] = useState<string>('')
  const [redeemCouponError, setRedeemCouponError] = useState<string | null>(null)
  const [redeemCouponSuccess, setRedeemCouponSuccess] = useState<string | null>(null)
  const [oneTimeTopUpAmount, setOneTimeTopUpAmount] = useState<number | undefined>(undefined)
  const [selectedPreset, setSelectedPreset] = useState<number | null>(100)
  // Both are folded by default: one is a setting you touch once, the other a
  // one-shot action. Neither earns six rows of the panel on every visit.
  const [autoReloadOpen, setAutoReloadOpen] = useState(false)
  const [couponOpen, setCouponOpen] = useState(false)
  const walletQuery = useOwnerWalletQuery({ refetchOnMount: 'always' })
  const billingPortalUrlQuery = useOwnerBillingPortalUrlQuery()
  const transactionsQuery = useOwnerWalletTransactionsQuery(1, TRANSACTION_HISTORY_LIMIT)
  const paymentMethodsQuery = useOwnerPaymentMethodsQuery()
  const planQuery = useOwnerPlanQuery()

  const isCheckoutUrlLoading = useIsOwnerCheckoutUrlFetching()
  const fetchCheckoutUrl = useFetchOwnerCheckoutUrlQuery()
  const wallet = walletQuery.data
  const billingPortalUrl = billingPortalUrlQuery.data
  const setAutomaticTopUpMutation = useSetAutomaticTopUpMutation()
  const redeemCouponMutation = useRedeemCouponMutation()
  const topUpWalletMutation = useTopUpWalletMutation()

  useEffect(() => {
    if (!wallet) {
      return
    }
    setAutomaticTopUp(wallet.automaticTopUp ?? DEFAULT_AUTO_RELOAD)
  }, [wallet])

  const handleUpdatePaymentMethod = useCallback(async () => {
    const newWindow = window.open('', '_blank')
    try {
      const data = await fetchCheckoutUrl()
      if (newWindow) {
        newWindow.location.href = data
      }
    } catch (error) {
      newWindow?.close()
      toast.error('Failed to fetch checkout url', {
        description: String(error),
      })
    }
  }, [fetchCheckoutUrl])

  const handleSetAutomaticTopUp = useCallback(async () => {
    if (!selectedOrganization) {
      return
    }

    try {
      await setAutomaticTopUpMutation.mutateAsync({
        organizationId: selectedOrganization.id,
        automaticTopUp,
      })
      toast.success('Automatic top up set successfully')
    } catch (error) {
      toast.error('Failed to set automatic top up', {
        description: String(error),
      })
    }
  }, [selectedOrganization, automaticTopUp, setAutomaticTopUpMutation])

  const handleRedeemCoupon = useCallback(async () => {
    if (!selectedOrganization || !couponCode) {
      return
    }

    setRedeemCouponError(null)
    setRedeemCouponSuccess(null)

    try {
      const message = await redeemCouponMutation.mutateAsync({
        organizationId: selectedOrganization.id,
        couponCode,
      })
      setRedeemCouponSuccess(message)
      setTimeout(() => {
        setRedeemCouponSuccess(null)
      }, 3000)
      setCouponCode('')
    } catch (error) {
      setRedeemCouponError(String(error))
      console.error('Failed to redeem coupon:', error)
    }
  }, [selectedOrganization, couponCode, redeemCouponMutation])

  const saveAutomaticTopUpDisabled = useMemo(() => {
    if (setAutomaticTopUpMutation.isPending) {
      return true
    }

    if (automaticTopUp?.thresholdAmount !== wallet?.automaticTopUp?.thresholdAmount) {
      if (!wallet?.automaticTopUp) {
        if ((automaticTopUp?.thresholdAmount || 0) !== 0) {
          return false
        }
      } else {
        return false
      }
    }

    if (automaticTopUp?.targetAmount !== wallet?.automaticTopUp?.targetAmount) {
      if (!wallet?.automaticTopUp) {
        if ((automaticTopUp?.targetAmount || 0) !== 0) {
          return false
        }
      } else {
        return false
      }
    }

    return true
  }, [setAutomaticTopUpMutation.isPending, wallet, automaticTopUp])

  const handleTopUpWallet = useCallback(async () => {
    if (!selectedOrganization) {
      return
    }
    const amount = selectedPreset ?? oneTimeTopUpAmount
    if (!amount) {
      return
    }

    const newWindow = window.open('', '_blank')
    try {
      const result = await topUpWalletMutation.mutateAsync({
        organizationId: selectedOrganization.id,
        amountCents: Math.round(amount * 100),
      })
      if (newWindow) {
        newWindow.location.href = result.url
      }
    } catch (error) {
      newWindow?.close()
      toast.error('Failed to initiate top-up', {
        description: String(error),
      })
    }
  }, [selectedOrganization, selectedPreset, oneTimeTopUpAmount, topUpWalletMutation])

  const isBillingLoading = walletQuery.isLoading && billingPortalUrlQuery.isLoading
  const cardConnected = Boolean(wallet?.creditCardConnected)
  const topUp = topUpGate(selectedPreset ?? oneTimeTopUpAmount)
  // Read the indicator off the saved wallet, not the form: the form is
  // pre-filled with defaults, which would otherwise read as already on.
  const autoReloadActive =
    (wallet?.automaticTopUp?.thresholdAmount ?? 0) > 0 || (wallet?.automaticTopUp?.targetAmount ?? 0) > 0

  return (
    <div className="flex flex-col gap-8">
      {isBillingLoading && (
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-4 border border-border bg-card p-[22px]">
            <Skeleton className="h-5 w-full max-w-sm" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-10 flex-1" />
              <Skeleton className="h-10 flex-1" />
            </div>
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
          <div className="flex flex-col gap-4 border border-border bg-card p-[22px]">
            <Skeleton className="h-5 w-full max-w-sm" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-10 flex-1" />
              <Skeleton className="h-10 flex-1" />
            </div>
            <Skeleton className="h-10" />
          </div>
        </div>
      )}

      {wallet && (
        <div className="flex flex-col gap-8">
          {/* Card enumeration is its own read model; checkout remains the one action. */}
          <PaymentMethodsPanel
            paymentMethods={paymentMethodsQuery.data ?? []}
            isLoading={paymentMethodsQuery.isLoading}
            isError={paymentMethodsQuery.isError}
            hasConnectedCard={cardConnected}
            isActionLoading={isCheckoutUrlLoading}
            onAction={handleUpdatePaymentMethod}
          />

          <section>
            <SectionTitle title="Wallet Balance" />
            <Panel className="px-[22px] py-5">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[30px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
                  {formatAmount(wallet.ongoingBalanceCents)}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">available</span>
              </div>

              <div className="mt-4">
                {/* Only when a grant exists. A $0.00 / $0.00 row is not a fact
                    about promotional credit, it is the absence of one. */}
                {(wallet.creditGrantedCents ?? 0) > 0 && (
                  <>
                    <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
                      <span>Promotional credit remaining</span>
                      <span className="tabular-nums">
                        {formatAmount(wallet.creditRemainingCents ?? 0)} /{' '}
                        {formatAmount(wallet.creditGrantedCents ?? 0)}
                      </span>
                    </div>
                    {/* Fill the spent part, not the remaining one: SegmentedBar
                        turns amber past 80% and red past 90%, so passing the
                        remainder painted a freshly granted, untouched credit red. */}
                    <SegmentedBar
                      used={Math.max(0, (wallet.creditGrantedCents ?? 0) - (wallet.creditRemainingCents ?? 0))}
                      limit={wallet.creditGrantedCents ?? 0}
                    />
                  </>
                )}
                {billingPortalUrlQuery.isLoading ? (
                  <Skeleton className="mt-2 h-4 w-[180px]" />
                ) : billingPortalUrl ? (
                  <a
                    href={`${billingPortalUrl}/customer-edit-information`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Payment history &amp; billing info
                    <ArrowUpRight className="size-3.5" />
                  </a>
                ) : null}
              </div>

              <div className="my-5 h-px bg-border" />

              {/* Add funds — presets, custom amount and the action all on one row */}
              <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">Add funds</span>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <div className="grid grid-cols-2 gap-2 sm:contents">
                  {[25, 100, 500, 1000].map((amount) => (
                    <AsciiChip
                      key={amount}
                      selected={selectedPreset === amount}
                      onClick={() => {
                        setSelectedPreset(amount)
                        setOneTimeTopUpAmount(undefined)
                      }}
                    >
                      ${amount.toLocaleString()}
                    </AsciiChip>
                  ))}
                </div>
                <span className="inline-flex items-center border border-border px-3 py-2 font-mono text-[13px] transition-colors focus-within:border-brand hover:border-brand">
                  <span className="text-muted-foreground">$</span>
                  <NumericFormat
                    id="customTopUpAmount"
                    placeholder="custom"
                    inputMode="decimal"
                    thousandSeparator
                    decimalScale={2}
                    value={oneTimeTopUpAmount ?? ''}
                    onValueChange={({ floatValue }) => {
                      const value = floatValue ?? undefined
                      setOneTimeTopUpAmount(value)
                      setSelectedPreset(null)
                    }}
                    onFocus={() => {
                      setSelectedPreset(null)
                    }}
                    className="w-full bg-transparent pl-1 tabular-nums text-foreground outline-none placeholder:text-muted-foreground sm:w-[86px]"
                  />
                </span>
                <AsciiButton
                  variant="primary"
                  onClick={handleTopUpWallet}
                  disabled={!topUp.enabled || topUpWalletMutation.isPending}
                  className="inline-flex w-full items-center justify-center gap-2 sm:ml-auto sm:w-auto"
                >
                  {topUpWalletMutation.isPending && <Spinner />}
                  Top up →
                </AsciiButton>
              </div>
              {topUp.reason && (
                <p className="mt-3 font-mono text-[11px] leading-relaxed text-warning">{topUp.reason}</p>
              )}
              <PanelNote>
                Minimum ${MIN_TOP_UP_DOLLARS} · you will be redirected to Stripe to complete the payment.
              </PanelNote>

              {/* Auto-reload stays on the page without a card, disabled and
                  labelled: hiding it is why nobody knew it existed, and it is
                  also the only thing that arms the low-balance warning. */}
              <>
                <div className="my-5 h-px bg-border" />

                <button
                  type="button"
                  aria-expanded={autoReloadOpen}
                  aria-controls="auto-reload-settings"
                  onClick={() => setAutoReloadOpen((wasOpen) => !wasOpen)}
                  className="flex w-full items-center gap-2 font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <span style={{ color: BRAND }}>{autoReloadOpen ? '▾' : '▸'}</span>
                  Auto-reload
                  <span
                    className="size-[6px] rounded-full"
                    style={{ background: autoReloadActive ? BRAND : 'hsl(var(--muted-foreground))' }}
                  />
                  {/* Folded, the row still answers the only question it is asked:
                      is it on, and at what numbers. */}
                  <span className="ml-auto normal-case tracking-normal">
                    {autoReloadActive && wallet.automaticTopUp
                      ? `Below $${wallet.automaticTopUp.thresholdAmount.toFixed(2)} → $${wallet.automaticTopUp.targetAmount.toFixed(2)}`
                      : 'Off'}
                  </span>
                </button>

                {autoReloadOpen && (
                  <div id="auto-reload-settings" className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2 font-mono text-[13px] text-foreground">
                        <span>when balance &lt;</span>
                        <span className="inline-flex items-center border border-border px-2 py-1 transition-colors focus-within:border-brand">
                          <span className="text-muted-foreground">$</span>
                          <NumericFormat
                            id="thresholdAmount"
                            disabled={!cardConnected}
                            placeholder="0.00"
                            inputMode="decimal"
                            thousandSeparator
                            decimalScale={2}
                            value={automaticTopUp?.thresholdAmount ?? ''}
                            onValueChange={({ floatValue }) => {
                              const value = floatValue ?? 0

                              let targetAmount = automaticTopUp?.targetAmount ?? 0
                              if (value > targetAmount - 10) {
                                targetAmount = value + 10
                              }

                              setAutomaticTopUp({
                                thresholdAmount: value,
                                targetAmount,
                              })
                            }}
                            className="w-[72px] bg-transparent pl-1 text-right tabular-nums text-foreground outline-none"
                          />
                        </span>
                        <span className="text-muted-foreground">→ bring to</span>
                        <span className="inline-flex items-center border border-border px-2 py-1 transition-colors focus-within:border-brand">
                          <span className="text-muted-foreground">$</span>
                          <NumericFormat
                            id="targetAmount"
                            disabled={!cardConnected}
                            placeholder="0.00"
                            inputMode="decimal"
                            thousandSeparator
                            decimalScale={2}
                            value={automaticTopUp?.targetAmount ?? ''}
                            onValueChange={({ floatValue }) => {
                              const thresholdAmount = automaticTopUp?.thresholdAmount ?? 0
                              setAutomaticTopUp({
                                thresholdAmount,
                                targetAmount: floatValue ?? 0,
                              })
                            }}
                            onBlur={() => {
                              const thresholdAmount = automaticTopUp?.thresholdAmount ?? 0
                              const currentTarget = automaticTopUp?.targetAmount ?? 0

                              if (currentTarget < thresholdAmount) {
                                setAutomaticTopUp({
                                  thresholdAmount,
                                  targetAmount: thresholdAmount,
                                })
                              }
                            }}
                            className="w-[72px] bg-transparent pl-1 text-right tabular-nums text-foreground outline-none"
                          />
                        </span>
                      </div>
                    </div>
                    <AsciiButton
                      onClick={handleSetAutomaticTopUp}
                      disabled={!cardConnected || saveAutomaticTopUpDisabled || walletQuery.isLoading || !wallet}
                      className="inline-flex items-center gap-2"
                    >
                      {setAutomaticTopUpMutation.isPending && <Spinner />} Save
                    </AsciiButton>
                  </div>
                )}
                {autoReloadOpen &&
                  (cardConnected ? (
                    <PanelNote>Target must be at least $10 above the threshold · set both to 0 to disable</PanelNote>
                  ) : (
                    <p className="mt-3 font-mono text-[11px] leading-relaxed text-warning">
                      Connect a payment method above to turn auto-reload on. Until it is set, nothing warns you before
                      the balance runs out.
                    </p>
                  ))}
              </>

              <BalanceThresholdBanner wallet={wallet} plan={planQuery.data} />

              {user?.profile.email_verified && (
                <>
                  <div className="my-5 h-px bg-border" />

                  {/* A one-shot action with no state to summarise, so it gets a
                      link rather than a settings row — the checkout convention. */}
                  {!couponOpen ? (
                    <button
                      type="button"
                      onClick={() => setCouponOpen(true)}
                      className="font-mono text-[11px] text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                    >
                      Have a coupon code?
                    </button>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-col gap-1.5">
                        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
                          Redeem coupon
                        </span>
                        {redeemCouponError ? (
                          <span className="font-mono text-[12px] text-destructive">{redeemCouponError}</span>
                        ) : redeemCouponSuccess ? (
                          <span className="font-mono text-[12px] text-success">{redeemCouponSuccess}</span>
                        ) : (
                          <span className="font-mono text-[12px] text-muted-foreground">
                            Enter a coupon code to redeem your credits.
                          </span>
                        )}
                      </div>
                      <div className="flex w-full items-center gap-2 sm:w-auto">
                        <Input
                          placeholder="Enter coupon code"
                          value={couponCode}
                          onChange={(e) => setCouponCode(e.target.value)}
                          className="h-9 w-full font-mono text-[13px] sm:w-[200px]"
                        />
                        <AsciiButton
                          onClick={handleRedeemCoupon}
                          disabled={redeemCouponMutation.isPending}
                          className="inline-flex shrink-0 items-center gap-2"
                        >
                          {redeemCouponMutation.isPending && <Spinner />} Redeem
                        </AsciiButton>
                      </div>
                    </div>
                  )}
                </>
              )}
            </Panel>
          </section>

          <section>
            <SectionTitle
              title="Transactions"
              count={transactionsQuery.data?.totalItems ? `${transactionsQuery.data.totalItems} records` : undefined}
            />
            <WalletTransactionsTable data={transactionsQuery.data?.items ?? []} loading={transactionsQuery.isLoading} />
          </section>
        </div>
      )}
    </div>
  )
}
