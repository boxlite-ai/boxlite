/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Invoice } from '@/billing-api/types/Invoice'
import { AutomaticTopUp } from '@/billing-api/types/OrganizationWallet'
import { AsciiButton, AsciiChip, BRAND, Panel, PanelNote, SectionTitle, SegmentedBar } from '@/components/ascii'
import { InvoicesTable } from '@/components/Invoices'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useCreateInvoicePaymentUrlMutation } from '@/hooks/mutations/useCreateInvoicePaymentUrlMutation'
import { useRedeemCouponMutation } from '@/hooks/mutations/useRedeemCouponMutation'
import { useSetAutomaticTopUpMutation } from '@/hooks/mutations/useSetAutomaticTopUpMutation'
import { useTopUpWalletMutation } from '@/hooks/mutations/useTopUpWalletMutation'
import { useVoidInvoiceMutation } from '@/hooks/mutations/useVoidInvoiceMutation'
import {
  useFetchOwnerCheckoutUrlQuery,
  useIsOwnerCheckoutUrlFetching,
  useOwnerBillingPortalUrlQuery,
  useOwnerInvoicesQuery,
  useOwnerWalletQuery,
} from '@/hooks/queries/billingQueries'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { formatAmount } from '@/lib/utils'
import { ArrowUpRight, CheckCircleIcon } from '@/components/ui/icon'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { NumericFormat } from 'react-number-format'
import { useAuth } from 'react-oidc-context'
import { toast } from 'sonner'

const DEFAULT_PAGE_SIZE = 10

const Wallet = () => {
  const { selectedOrganization } = useSelectedOrganization()
  const { user } = useAuth()
  const [automaticTopUp, setAutomaticTopUp] = useState<AutomaticTopUp | undefined>(undefined)
  const [couponCode, setCouponCode] = useState<string>('')
  const [redeemCouponError, setRedeemCouponError] = useState<string | null>(null)
  const [redeemCouponSuccess, setRedeemCouponSuccess] = useState<string | null>(null)
  const [oneTimeTopUpAmount, setOneTimeTopUpAmount] = useState<number | undefined>(undefined)
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null)
  const [invoicesPagination, setInvoicesPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
  })
  const walletQuery = useOwnerWalletQuery({ refetchOnMount: 'always' })
  const billingPortalUrlQuery = useOwnerBillingPortalUrlQuery()
  const invoicesQuery = useOwnerInvoicesQuery(invoicesPagination.pageIndex + 1, invoicesPagination.pageSize)

  const isCheckoutUrlLoading = useIsOwnerCheckoutUrlFetching()
  const fetchCheckoutUrl = useFetchOwnerCheckoutUrlQuery()
  const wallet = walletQuery.data
  const billingPortalUrl = billingPortalUrlQuery.data
  const setAutomaticTopUpMutation = useSetAutomaticTopUpMutation()
  const redeemCouponMutation = useRedeemCouponMutation()
  const topUpWalletMutation = useTopUpWalletMutation()
  const createInvoicePaymentUrlMutation = useCreateInvoicePaymentUrlMutation()
  const voidInvoiceMutation = useVoidInvoiceMutation()

  useEffect(() => {
    if (wallet?.automaticTopUp) {
      setAutomaticTopUp(wallet.automaticTopUp)
    }
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
        amountCents: amount * 100,
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

  const handlePayInvoice = useCallback(
    async (invoice: Invoice) => {
      if (!selectedOrganization) {
        return
      }

      if (invoice.paymentStatus === 'pending' && invoice.totalDueAmountCents > 0) {
        const newWindow = window.open('', '_blank')
        try {
          const result = await createInvoicePaymentUrlMutation.mutateAsync({
            organizationId: selectedOrganization.id,
            invoiceId: invoice.id,
          })
          if (newWindow) {
            newWindow.location.href = result.url
          }
        } catch (error) {
          newWindow?.close()
          toast.error('Failed to open invoice', {
            description: String(error),
          })
        }
      }
    },
    [selectedOrganization, createInvoicePaymentUrlMutation],
  )

  const handleViewInvoice = useCallback(
    async (invoice: Invoice) => {
      if (!selectedOrganization) {
        return
      }

      window.open(invoice.fileUrl, '_blank')
    },
    [selectedOrganization],
  )

  const handleVoidInvoice = useCallback(
    async (invoice: Invoice) => {
      if (!selectedOrganization) {
        return
      }
      try {
        await voidInvoiceMutation.mutateAsync({
          organizationId: selectedOrganization.id,
          invoiceId: invoice.id,
        })
        toast.success('Invoice voided successfully')
      } catch (error) {
        toast.error('Failed to void invoice', {
          description: String(error),
        })
      }
    },
    [selectedOrganization, voidInvoiceMutation],
  )

  const isBillingLoading = walletQuery.isLoading && billingPortalUrlQuery.isLoading
  const topUpEnabled =
    wallet?.creditCardConnected && !topUpWalletMutation.isPending && (selectedPreset || oneTimeTopUpAmount)
  const spentCents = (wallet?.balanceCents ?? 0) - (wallet?.ongoingBalanceCents ?? 0)
  const autoReloadEnabled = (automaticTopUp?.thresholdAmount ?? 0) > 0 || (automaticTopUp?.targetAmount ?? 0) > 0

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
          {/* Wallet balance — one panel of divided rows: balance, add funds, auto-reload, coupon */}
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
                <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
                  <span>Spent this month</span>
                  <span className="tabular-nums">
                    {formatAmount(spentCents)} / {formatAmount(wallet.balanceCents)}
                  </span>
                </div>
                <SegmentedBar used={spentCents} limit={wallet.balanceCents} />
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
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {[25, 500, 1000, 2000].map((amount) => (
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
                    className="w-[86px] bg-transparent pl-1 tabular-nums text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </span>
                <AsciiButton
                  variant="primary"
                  onClick={handleTopUpWallet}
                  disabled={!topUpEnabled}
                  className="ml-auto inline-flex items-center gap-2"
                >
                  {topUpWalletMutation.isPending && <Spinner />}
                  Top up →
                </AsciiButton>
              </div>
              <PanelNote>You will be redirected to Stripe to complete the payment.</PanelNote>

              {wallet.creditCardConnected && (
                <>
                  <div className="my-5 h-px bg-border" />

                  {/* Auto-reload — one row. Both API fields stay inline: the endpoint takes a
                      threshold and a target, not a top-up amount. */}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-col gap-1.5">
                      <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
                        Auto-reload
                        <span
                          className="size-[6px] rounded-full"
                          style={{ background: autoReloadEnabled ? BRAND : 'hsl(var(--muted-foreground))' }}
                        />
                      </span>
                      <div className="flex flex-wrap items-center gap-2 font-mono text-[13px] text-foreground">
                        <span>when balance &lt;</span>
                        <span className="inline-flex items-center border border-border px-2 py-1 transition-colors focus-within:border-brand">
                          <span className="text-muted-foreground">$</span>
                          <NumericFormat
                            id="thresholdAmount"
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
                      disabled={saveAutomaticTopUpDisabled || walletQuery.isLoading || !wallet}
                      className="inline-flex items-center gap-2"
                    >
                      {setAutomaticTopUpMutation.isPending && <Spinner />} Save
                    </AsciiButton>
                  </div>
                  <PanelNote>Target must be at least $10 above the threshold · set both to 0 to disable</PanelNote>
                </>
              )}

              {user?.profile.email_verified && (
                <>
                  <div className="my-5 h-px bg-border" />

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
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="Enter coupon code"
                        value={couponCode}
                        onChange={(e) => setCouponCode(e.target.value)}
                        className="h-9 w-[200px] font-mono text-[13px]"
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
                </>
              )}
            </Panel>
          </section>

          <section>
            <SectionTitle title="Payment Method" />
            <Panel className="px-[22px] py-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                {!wallet.creditCardConnected ? (
                  <span className="font-mono text-[13px] text-muted-foreground">Payment method not connected</span>
                ) : (
                  <span className="flex items-center gap-2 font-mono text-[13px] text-foreground">
                    <CheckCircleIcon className="size-4 shrink-0" /> Credit card connected
                  </span>
                )}
                <AsciiButton
                  variant={wallet.creditCardConnected ? 'secondary' : 'primary'}
                  onClick={handleUpdatePaymentMethod}
                  disabled={isCheckoutUrlLoading}
                  className="inline-flex items-center gap-2"
                >
                  {isCheckoutUrlLoading && <Spinner />} {wallet.creditCardConnected ? 'Update card' : 'Connect'}
                </AsciiButton>
              </div>
              <PanelNote>Used for top-up charges · card details are held by Stripe</PanelNote>
            </Panel>
          </section>

          <section>
            <SectionTitle
              title="Invoices"
              count={invoicesQuery.data?.totalItems ? `${invoicesQuery.data.totalItems} records` : undefined}
            />
            <InvoicesTable
              data={invoicesQuery.data?.items ?? []}
              pagination={invoicesPagination}
              pageCount={invoicesQuery.data?.totalPages ?? 0}
              totalItems={invoicesQuery.data?.totalItems ?? 0}
              onPaginationChange={setInvoicesPagination}
              loading={invoicesQuery.isLoading}
              onViewInvoice={handleViewInvoice}
              onVoidInvoice={handleVoidInvoice}
              onPayInvoice={handlePayInvoice}
            />
            <PanelNote>Invoices are generated automatically and sent to your billing emails.</PanelNote>
          </section>
        </div>
      )}
    </div>
  )
}

export default Wallet
