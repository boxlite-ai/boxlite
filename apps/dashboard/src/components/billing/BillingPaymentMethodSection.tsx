/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingPayment } from '@/billing-api'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { ArrowUpRight, Loader2, RefreshCw } from '@/components/ui/icon'
import { useSetupBillingPaymentMutation } from '@/hooks/mutations/useSetupBillingPaymentMutation'
import { useBillingPaymentQuery } from '@/hooks/queries/useBillingPaymentQuery'
import { redirectToBillingCheckout } from '@/lib/billing-checkout'
import { toast } from 'sonner'
import { BILLING_BRAND, CardBrand } from './ascii'

function PaymentMethodCard({
  organizationId,
  payment,
  onAddFunds,
}: {
  organizationId: string
  payment: BillingPayment
  onAddFunds?: () => void
}) {
  const setupMutation = useSetupBillingPaymentMutation()

  const setupPayment = async () => {
    try {
      const result = await setupMutation.mutateAsync({ organizationId })
      if (result.checkoutUrl) {
        redirectToBillingCheckout(result.checkoutUrl)
        return
      }
      toast.success(result.status === 'ready' ? 'Payment method is ready' : 'Payment setup is pending')
    } catch {
      toast.error('Failed to start payment setup')
    }
  }

  return (
    <div
      data-testid="billing-payment-method-row"
      className="grid gap-4 border-t border-border px-[22px] py-[14px] md:grid-cols-[160px_1fr_auto] md:items-center"
    >
      <span className="font-mono text-[10px] uppercase text-muted-foreground">
        <span style={{ color: BILLING_BRAND }}>▸</span> Payment method
      </span>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          {payment.paymentMethod ? (
            <button
              type="button"
              aria-label="Change payment method"
              className="flex w-fit items-center gap-4 font-mono text-[17px] text-foreground hover:opacity-80"
              disabled={setupMutation.isPending}
            >
              <CardBrand brand={payment.paymentMethod.brand} size="lg" />
              <span className="tabular-nums">···· {payment.paymentMethod.last4}</span>
              {setupMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            </button>
          ) : (
            <Button className="w-fit" size="sm" disabled={setupMutation.isPending}>
              {setupMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Set up payment method
            </Button>
          )}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm payment method setup</AlertDialogTitle>
            <AlertDialogDescription>
              {payment.providerMode === 'stripe'
                ? 'Continue to Stripe to securely add or replace the organization payment method.'
                : 'Continue with the test payment provider for this organization.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={setupMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={setupPayment} disabled={setupMutation.isPending}>
              Confirm setup
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {payment.paymentMethod ? (
        <Button variant="secondary" size="sm" onClick={onAddFunds} className="w-fit md:justify-self-end">
          Add funds
          <ArrowUpRight className="size-3.5" />
        </Button>
      ) : (
        <span className="font-mono text-[11px] text-muted-foreground md:col-start-2">No payment method configured</span>
      )}
    </div>
  )
}

export function BillingPaymentMethodSection({
  organizationId,
  onAddFunds,
}: {
  organizationId: string
  onAddFunds?: () => void
}) {
  const paymentQuery = useBillingPaymentQuery(organizationId)

  if (paymentQuery.isLoading) {
    return (
      <div className="border-t border-border px-[22px] py-5 font-mono text-[12px] text-muted-foreground">
        Payment method / Loading payment settings...
      </div>
    )
  }

  if (paymentQuery.isError || !paymentQuery.data) {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-destructive/50 px-[22px] py-5 font-mono text-[12px] text-destructive">
        <span>Payment method is unavailable.</span>
        <Button variant="outline" size="icon-sm" onClick={() => paymentQuery.refetch()} title="Retry payment method">
          <RefreshCw className="size-3.5" />
          <span className="sr-only">Retry payment method</span>
        </Button>
      </div>
    )
  }

  return <PaymentMethodCard organizationId={organizationId} payment={paymentQuery.data} onAddFunds={onAddFunds} />
}
