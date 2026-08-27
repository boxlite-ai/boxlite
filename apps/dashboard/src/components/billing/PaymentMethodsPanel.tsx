/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { PaymentMethod } from '@/billing-api'
import { AsciiButton, BRAND, Panel, SectionTitle } from '@/components/ascii'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'

type PaymentMethodsPanelProps = {
  paymentMethods: PaymentMethod[]
  isLoading: boolean
  isError: boolean
  hasConnectedCard: boolean
  isActionLoading: boolean
  onAction: () => void
}

type PaymentMethodDisplay = {
  brand: string
  cardNumber: string
  expiry: string | null
}

function paymentMethodDisplay(details: Record<string, unknown>): PaymentMethodDisplay {
  const brand =
    typeof details.brand === 'string' && /^[a-z0-9 -]{1,24}$/i.test(details.brand.trim())
      ? details.brand.trim().toUpperCase()
      : 'CARD'
  const last4 = typeof details.last4 === 'string' && /^\d{4}$/.test(details.last4) ? details.last4 : null
  const expMonth = details.expMonth
  const expYear = details.expYear
  const hasExpiry =
    typeof expMonth === 'number' &&
    Number.isInteger(expMonth) &&
    expMonth >= 1 &&
    expMonth <= 12 &&
    typeof expYear === 'number' &&
    Number.isInteger(expYear) &&
    expYear >= 0

  return {
    brand,
    cardNumber: last4 ? `•••• ${last4}` : 'Saved card',
    expiry: hasExpiry ? `exp ${String(expMonth).padStart(2, '0')}/${String(expYear).padStart(2, '0').slice(-2)}` : null,
  }
}

function SetupButton({
  connected,
  isLoading,
  onClick,
}: {
  connected: boolean
  isLoading: boolean
  onClick: () => void
}) {
  return (
    <AsciiButton
      variant={connected ? 'secondary' : 'primary'}
      onClick={onClick}
      disabled={isLoading}
      className="inline-flex items-center gap-2 whitespace-nowrap"
    >
      {isLoading && <Spinner />} {connected ? 'Update card' : 'Connect'}
    </AsciiButton>
  )
}

export function PaymentMethodsPanel({
  paymentMethods,
  isLoading,
  isError,
  hasConnectedCard,
  isActionLoading,
  onAction,
}: PaymentMethodsPanelProps) {
  const hasPaymentMethods = paymentMethods.length > 0
  const actionConnected = isError ? hasConnectedCard : hasPaymentMethods

  return (
    <section>
      <SectionTitle title="Payment Method" />

      {isLoading ? (
        <Panel className="flex items-center gap-5 px-[22px] py-5">
          <Skeleton className="h-[52px] w-[82px] shrink-0" />
          <Skeleton className="h-5 w-full max-w-xs" />
        </Panel>
      ) : isError ? (
        <Panel className="flex flex-wrap items-center justify-between gap-4 px-[22px] py-5">
          <span className="font-mono text-[13px] text-muted-foreground">Payment methods unavailable</span>
          <SetupButton connected={actionConnected} isLoading={isActionLoading} onClick={onAction} />
        </Panel>
      ) : hasPaymentMethods ? (
        <Panel>
          <ul aria-label="Saved payment methods" className="w-full divide-y divide-border">
            {paymentMethods.map((method, index) => {
              const display = paymentMethodDisplay(method.details)
              return (
                <li
                  key={method.id}
                  className="flex flex-col gap-4 px-[22px] py-5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3">
                      <span className="inline-flex h-[52px] min-w-[82px] shrink-0 items-center justify-center border border-border bg-foreground px-3 font-mono text-[15px] font-bold italic tracking-tight text-background">
                        {display.brand}
                      </span>
                      <span className="font-mono text-[20px] tracking-[2px] tabular-nums text-foreground">
                        {display.cardNumber}
                      </span>
                      {display.expiry && (
                        <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
                          {display.expiry}
                        </span>
                      )}
                    </div>
                    <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                      {method.isDefault ? (
                        <>
                          <span style={{ color: BRAND }}>▸</span> Used for subscription renewal and top-up charges
                        </>
                      ) : (
                        'Saved payment method'
                      )}
                    </p>
                  </div>
                  {index === 0 && (
                    <div className="shrink-0">
                      <SetupButton connected isLoading={isActionLoading} onClick={onAction} />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </Panel>
      ) : (
        <Panel className="flex flex-wrap items-center justify-between gap-4 px-[22px] py-5">
          <span className="font-mono text-[13px] text-muted-foreground">Payment method not connected</span>
          <SetupButton connected={false} isLoading={isActionLoading} onClick={onAction} />
        </Panel>
      )}
    </section>
  )
}
