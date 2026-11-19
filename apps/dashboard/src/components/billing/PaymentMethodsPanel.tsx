/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PaymentBrand } from './PaymentBrand'
import type { PaymentMethod } from '@/billing-api'
import { AsciiButton, Panel, SectionTitle } from '@/components/ascii'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { MoreHorizontal, Plus } from '@/components/ui/icon'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useState } from 'react'

type PaymentMethodsPanelProps = {
  paymentMethods: PaymentMethod[]
  isLoading: boolean
  isError: boolean
  isAddLoading: boolean
  /** The card whose set-default or remove request is in flight. */
  pendingMethodId: string | null
  onAdd: () => void
  onSetDefault: (paymentMethodId: string) => void
  onRemove: (paymentMethodId: string) => void
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

function AddCardButton({ isLoading, onClick }: { isLoading: boolean; onClick: () => void }) {
  return (
    <AsciiButton variant="primary" className="h-11 shrink-0 sm:h-9" onClick={onClick} disabled={isLoading}>
      {isLoading ? <Spinner /> : <Plus className="size-3.5" strokeWidth={2.4} />}
      Add payment method
    </AsciiButton>
  )
}

/** Renewals and top-ups need a card on file, so the only saved card cannot be removed. */
function removalBlockedReason(cardCount: number): string | null {
  return cardCount === 1 ? 'Add another card before removing this one.' : null
}

/** Lists saved cards with set-default and remove actions; adding a card stays available in every state. */
export function PaymentMethodsPanel({
  paymentMethods,
  isLoading,
  isError,
  isAddLoading,
  pendingMethodId,
  onAdd,
  onSetDefault,
  onRemove,
}: PaymentMethodsPanelProps) {
  const [pendingRemoval, setPendingRemoval] = useState<PaymentMethod | null>(null)
  const removalDisplay = pendingRemoval ? paymentMethodDisplay(pendingRemoval.details) : null
  // The default card leads; the rest keep the API's order (sort is stable).
  const orderedMethods = [...paymentMethods].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))

  return (
    <section>
      <SectionTitle title="Payment Method" />

      <Panel className="divide-y divide-border">
        {isLoading ? (
          <div className="flex items-center gap-5 px-[22px] py-5">
            <Skeleton className="h-[52px] w-[82px] shrink-0" />
            <Skeleton className="h-5 w-full max-w-xs" />
          </div>
        ) : isError ? (
          <div className="px-[22px] py-5">
            <span className="font-sans text-body text-muted-foreground">Payment methods unavailable</span>
          </div>
        ) : paymentMethods.length > 0 ? (
          <ul aria-label="Saved payment methods" className="w-full divide-y divide-border">
            {orderedMethods.map((method) => {
              const display = paymentMethodDisplay(method.details)
              const isPending = pendingMethodId === method.id
              const blockedReason = removalBlockedReason(paymentMethods.length)
              return (
                <li key={method.id} className="flex items-center justify-between gap-4 px-[22px] py-5">
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3">
                      <PaymentBrand brand={display.brand} />
                      <span className="font-mono text-section tracking-[2px] tabular-nums text-foreground">
                        {display.cardNumber}
                      </span>
                      {display.expiry && (
                        <span className="font-mono text-meta tabular-nums text-muted-foreground">{display.expiry}</span>
                      )}
                      {method.isDefault && (
                        <span className="border border-border px-2 py-0.5 font-mono text-meta uppercase tracking-[1px] text-foreground">
                          Default
                        </span>
                      )}
                    </div>
                    {method.isDefault && (
                      <p className="mt-3 font-sans text-meta text-muted-foreground">
                        Your default card is used for subscription renewals and top-ups.
                      </p>
                    )}
                  </div>
                  {!method.isDefault && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <AsciiButton
                          variant="quiet"
                          size="icon"
                          aria-label={`Actions for ${display.brand} ${display.cardNumber}`}
                          disabled={pendingMethodId !== null}
                        >
                          {isPending ? <Spinner /> : <MoreHorizontal className="h-4 w-4" />}
                        </AsciiButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem className="cursor-pointer" onSelect={() => onSetDefault(method.id)}>
                          Set as default
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="cursor-pointer text-red-600 dark:text-red-400"
                          disabled={blockedReason !== null}
                          onSelect={() => setPendingRemoval(method)}
                        >
                          Remove
                        </DropdownMenuItem>
                        {blockedReason && (
                          <p className="max-w-56 px-2 pb-1.5 font-sans text-meta text-muted-foreground">
                            {blockedReason}
                          </p>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              )
            })}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-4 px-[22px] py-5">
          <div className="min-w-0">
            {!isLoading && !isError && paymentMethods.length === 0 && (
              <p className="mb-1 font-sans text-body text-muted-foreground">No cards on file yet.</p>
            )}
            <p className="font-sans text-meta text-muted-foreground">
              Adding a card places a temporary $0.50 verification hold, refunded automatically.
            </p>
          </div>
          <AddCardButton isLoading={isAddLoading} onClick={onAdd} />
        </div>
      </Panel>

      <AlertDialog open={!!pendingRemoval} onOpenChange={(open) => !open && setPendingRemoval(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removalDisplay?.brand} {removalDisplay?.cardNumber}?
            </AlertDialogTitle>
            <AlertDialogDescription>The card will no longer be available for charges.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingRemoval && onRemove(pendingRemoval.id)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
