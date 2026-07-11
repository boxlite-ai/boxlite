/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingAutoReload, BillingPayment, BillingReceipt } from '@/billing-api'
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  ArrowRightIcon,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
} from '@/components/ui/icon'
import { Switch } from '@/components/ui/switch'
import { useCreateBillingTopUpMutation } from '@/hooks/mutations/useCreateBillingTopUpMutation'
import { useUpdateBillingAutoReloadMutation } from '@/hooks/mutations/useUpdateBillingAutoReloadMutation'
import { useBillingPaymentQuery } from '@/hooks/queries/useBillingPaymentQuery'
import { useBillingReceiptsQuery } from '@/hooks/queries/useBillingReceiptsQuery'
import { redirectToBillingCheckout } from '@/lib/billing-checkout'
import { cn } from '@/lib/utils'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { BILLING_BRAND, SectionTitle } from './ascii'

const RECEIPTS_PAGE_SIZE = 8
const AUTO_RELOAD_MINIMUM_GAP_CENTS = 1000n
const MINIMUM_TOP_UP_CENTS = 500n
const TOP_UP_PRESETS = [
  { label: '$25', amountCents: '2500' },
  { label: '$500', amountCents: '50000' },
  { label: '$1,000', amountCents: '100000' },
  { label: '$2,000', amountCents: '200000' },
] as const

function formatCents(cents: string): string {
  if (!/^-?\d+$/.test(cents)) return 'Unavailable'
  const value = BigInt(cents)
  const absoluteValue = value < 0n ? -value : value
  const dollars = absoluteValue / 100n
  const remainder = (absoluteValue % 100n).toString().padStart(2, '0')
  return `${value < 0n ? '-' : ''}$${dollars.toLocaleString('en-US')}.${remainder}`
}

function centsToInput(cents: string | null): string {
  if (cents == null || !/^\d+$/.test(cents)) return ''
  const value = BigInt(cents)
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`
}

function dollarsToCents(dollars: string): string | null {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(dollars.trim())
  if (!match) return null
  const wholeDollars = BigInt(match[1])
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0')
  return (wholeDollars * 100n + fraction).toString()
}

function formatReceiptDate(createdAt: string): string {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return 'Unavailable'
  return date.toISOString().slice(0, 10)
}

function StatePanel({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'error' }) {
  return (
    <div
      className={cn(
        'border bg-card px-4 py-5 font-mono text-[12px]',
        tone === 'error' ? 'border-destructive/50 text-destructive' : 'border-border text-muted-foreground',
      )}
    >
      {children}
    </div>
  )
}

function autoReloadSummary(autoReload: BillingAutoReload): string {
  if (!autoReload.enabled) return 'disabled'
  if (autoReload.thresholdCents == null || autoReload.targetCents == null) return 'configuration unavailable'
  return `when balance < ${formatCents(autoReload.thresholdCents)} → top up to ${formatCents(autoReload.targetCents)}`
}

function AutoReloadEditor({
  organizationId,
  autoReload,
  canEdit,
}: {
  organizationId: string
  autoReload: BillingAutoReload
  canEdit: boolean
}) {
  const mutation = useUpdateBillingAutoReloadMutation()
  const [isOpen, setIsOpen] = useState(false)
  const [isEnabled, setIsEnabled] = useState(autoReload.enabled)
  const [threshold, setThreshold] = useState(() => centsToInput(autoReload.thresholdCents))
  const [target, setTarget] = useState(() => centsToInput(autoReload.targetCents))

  const thresholdCents = dollarsToCents(threshold)
  const targetCents = dollarsToCents(target)
  let validationError: string | null = null
  if (isEnabled && thresholdCents == null) {
    validationError = 'Enter a valid threshold with no more than two decimal places.'
  } else if (isEnabled && targetCents == null) {
    validationError = 'Enter a valid target with no more than two decimal places.'
  } else if (
    isEnabled &&
    thresholdCents != null &&
    targetCents != null &&
    BigInt(targetCents) < BigInt(thresholdCents) + AUTO_RELOAD_MINIMUM_GAP_CENTS
  ) {
    validationError = `Target must be at least ${formatCents(
      (BigInt(thresholdCents) + AUTO_RELOAD_MINIMUM_GAP_CENTS).toString(),
    )}.`
  }

  const resetDraft = () => {
    setIsEnabled(autoReload.enabled)
    setThreshold(centsToInput(autoReload.thresholdCents))
    setTarget(centsToInput(autoReload.targetCents))
  }

  const changeOpen = (open: boolean) => {
    if (open) resetDraft()
    setIsOpen(open)
  }

  const saveAutoReload = async () => {
    if (validationError) return
    const nextAutoReload: BillingAutoReload = isEnabled
      ? { enabled: true, thresholdCents, targetCents }
      : { enabled: false, thresholdCents: null, targetCents: null }

    try {
      await mutation.mutateAsync({ organizationId, autoReload: nextAutoReload })
      setIsOpen(false)
      toast.success('Auto-reload saved')
    } catch {
      toast.error('Failed to save auto-reload')
    }
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase text-muted-foreground">
          Auto-reload
          <span
            className="size-1.5 rounded-full"
            style={{ background: autoReload.enabled ? BILLING_BRAND : 'hsl(var(--muted-foreground))' }}
          />
        </div>
        <div className="mt-2 break-words font-mono text-[13px] text-foreground">{autoReloadSummary(autoReload)}</div>
        {!canEdit ? (
          <div className="mt-2 text-[11px] text-muted-foreground">
            Configure a payment method in Usage to enable auto-reload.
          </div>
        ) : null}
      </div>

      <Dialog open={isOpen} onOpenChange={changeOpen}>
        <DialogTrigger asChild>
          <Button variant="secondary" size="sm" disabled={!canEdit}>
            Edit
          </Button>
        </DialogTrigger>
        <DialogContent className="w-[calc(100%-2rem)] rounded-none border-border bg-card font-mono sm:max-w-[540px]">
          <DialogHeader>
            <DialogTitle className="font-mono text-[16px]">Auto-reload</DialogTitle>
            <DialogDescription>Automatically add funds when the organization balance runs low.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between gap-4 border border-border px-3 py-3">
              <label htmlFor="billing-auto-reload-enabled" className="text-[12px] text-foreground">
                Enable auto-reload
              </label>
              <Switch
                id="billing-auto-reload-enabled"
                checked={isEnabled}
                onCheckedChange={setIsEnabled}
                aria-label="Enable auto-reload"
              />
            </div>

            <label className="block space-y-1.5">
              <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                When balance is below
              </span>
              <span className="flex h-9 items-center border border-input bg-background px-3 focus-within:border-brand">
                <span className="text-muted-foreground">$</span>
                <input
                  aria-label="Auto-reload threshold"
                  inputMode="decimal"
                  value={threshold}
                  onChange={(event) => setThreshold(event.target.value)}
                  disabled={!isEnabled}
                  className="h-full min-w-0 flex-1 bg-transparent pl-1 text-[13px] tabular-nums text-foreground outline-none disabled:opacity-50"
                />
              </span>
            </label>

            <label className="block space-y-1.5">
              <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Top up to</span>
              <span className="flex h-9 items-center border border-input bg-background px-3 focus-within:border-brand">
                <span className="text-muted-foreground">$</span>
                <input
                  aria-label="Auto-reload target"
                  inputMode="decimal"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  disabled={!isEnabled}
                  className="h-full min-w-0 flex-1 bg-transparent pl-1 text-[13px] tabular-nums text-foreground outline-none disabled:opacity-50"
                />
              </span>
            </label>

            {validationError ? (
              <div role="alert" className="text-[11px] leading-relaxed text-destructive">
                {validationError}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary" size="sm" disabled={mutation.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button size="sm" onClick={saveAutoReload} disabled={Boolean(validationError) || mutation.isPending}>
              {mutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save auto-reload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function OneTimeTopUp({ organizationId, payment }: { organizationId: string; payment: BillingPayment }) {
  const mutation = useCreateBillingTopUpMutation()
  const [presetCents, setPresetCents] = useState<string | null>('50000')
  const [customAmount, setCustomAmount] = useState('')
  const customAmountCents = dollarsToCents(customAmount)
  const amountCents = presetCents ?? customAmountCents
  const isBelowMinimum = amountCents != null && BigInt(amountCents) < MINIMUM_TOP_UP_CENTS
  const hasValidAmount = amountCents != null && BigInt(amountCents) >= MINIMUM_TOP_UP_CENTS
  const canTopUp = Boolean(payment.paymentMethod && hasValidAmount)

  const selectPreset = (nextAmountCents: string) => {
    setPresetCents(nextAmountCents)
    setCustomAmount('')
  }

  const changeCustomAmount = (value: string) => {
    setCustomAmount(value)
    setPresetCents(null)
  }

  const createTopUp = async () => {
    if (!canTopUp || amountCents == null) return
    try {
      const result = await mutation.mutateAsync({ organizationId, amountCents })
      if (result.checkoutUrl) {
        redirectToBillingCheckout(result.checkoutUrl)
        return
      }
      if (result.status === 'failed') {
        toast.error('Top-up failed')
      } else if (result.status === 'paid') {
        toast.success('Top-up completed')
      } else {
        toast.success('Top-up started')
      }
    } catch {
      toast.error('Failed to start top-up')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="font-mono text-[10px] uppercase text-muted-foreground">One-time top-up</span>
      <div className="flex flex-wrap gap-2">
        {TOP_UP_PRESETS.map((preset) => (
          <Button
            key={preset.amountCents}
            type="button"
            variant={presetCents === preset.amountCents ? 'default' : 'outline'}
            size="sm"
            onClick={() => selectPreset(preset.amountCents)}
            disabled={!payment.paymentMethod}
            className="rounded-none px-4 font-mono tabular-nums"
          >
            {preset.label}
          </Button>
        ))}

        <label className="flex h-8 min-w-[132px] flex-1 items-center border border-input bg-background px-3 font-mono text-[12px] focus-within:border-brand sm:max-w-[180px]">
          <span className="text-muted-foreground">$</span>
          <input
            aria-label="Custom top-up amount"
            inputMode="decimal"
            placeholder="custom"
            value={customAmount}
            onChange={(event) => changeCustomAmount(event.target.value)}
            disabled={!payment.paymentMethod}
            className="h-full min-w-0 flex-1 bg-transparent pl-1 tabular-nums text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
        </label>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" disabled={!canTopUp || mutation.isPending} className="ml-auto rounded-none">
              {mutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Top up <ArrowRightIcon className="size-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Confirm {amountCents == null ? 'top-up' : `${formatCents(amountCents)} top-up`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {payment.providerMode === 'stripe'
                  ? 'You will continue to Stripe if additional payment confirmation is required.'
                  : 'The test payment provider will process this top-up immediately.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={createTopUp} disabled={!canTopUp || mutation.isPending}>
                Confirm top-up
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {isBelowMinimum ? (
        <div role="alert" className="font-mono text-[11px] text-destructive">
          Minimum top-up is $5.00.
        </div>
      ) : null}

      <div className="font-mono text-[11px] leading-relaxed text-muted-foreground">
        {payment.paymentMethod
          ? payment.providerMode === 'stripe'
            ? 'Stripe may request additional confirmation before funds are added.'
            : 'The test provider processes top-ups without leaving this page.'
          : 'Configure a payment method in Usage to add funds.'}
      </div>
    </div>
  )
}

function ReceiptStatus({ status }: { status: BillingReceipt['status'] }) {
  return (
    <span className={cn('inline-flex items-center gap-2', status === 'failed' && 'text-destructive')}>
      <span className={cn('size-1.5', status === 'paid' ? 'bg-success' : 'bg-destructive')} />
      {status}
    </span>
  )
}

function ReceiptRow({ receipt }: { receipt: BillingReceipt }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-border px-0.5 py-[15px] font-mono text-[12px] last:border-b-0 sm:grid-cols-[150px_110px_120px_1fr_130px_32px] sm:items-center sm:gap-x-6">
      <span className="order-1 tabular-nums text-foreground">{formatReceiptDate(receipt.createdAt)}</span>
      <span className="order-3 uppercase text-muted-foreground sm:order-2">
        {receipt.type === 'top_up' ? 'top up' : 'usage'}
      </span>
      <span className="order-4 text-right sm:order-3 sm:text-left">
        <ReceiptStatus status={receipt.status} />
      </span>
      <span className="hidden sm:order-4 sm:block" />
      <span className="order-2 text-right tabular-nums text-foreground sm:order-5">
        {formatCents(receipt.amountCents)}
      </span>
      <span className="order-5 col-span-2 flex justify-end sm:order-6 sm:col-span-1">
        {receipt.receiptUrl ? (
          <a
            href={receipt.receiptUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex size-8 items-center justify-center border border-border text-muted-foreground hover:border-brand hover:text-foreground"
            title="Open receipt"
          >
            <ExternalLink className="size-3.5" />
            <span className="sr-only">Open receipt</span>
          </a>
        ) : (
          <span
            className="inline-flex size-8 items-center justify-center text-muted-foreground"
            aria-label="No receipt file"
          >
            -
          </span>
        )}
      </span>
    </div>
  )
}

export function BillingPaymentPanel({ organizationId }: { organizationId: string }) {
  const [receiptsPage, setReceiptsPage] = useState(1)
  const [receiptsQuery, setReceiptsQuery] = useState('')
  const paymentQuery = useBillingPaymentQuery(organizationId)
  const receipts = useBillingReceiptsQuery({
    organizationId,
    page: receiptsPage,
    pageSize: RECEIPTS_PAGE_SIZE,
    query: receiptsQuery,
  })
  const pageCount = Math.max(1, Math.ceil((receipts.data?.total ?? 0) / RECEIPTS_PAGE_SIZE))
  const paymentDependencyMessage = paymentQuery.isLoading
    ? 'Loading payment settings...'
    : 'Payment settings are unavailable.'

  const changeReceiptsQuery = (query: string) => {
    setReceiptsQuery(query)
    setReceiptsPage(1)
  }

  return (
    <div className="flex flex-col gap-9">
      <section>
        <SectionTitle title="Top-up" />
        <div data-testid="billing-top-up-panel" className="border border-border bg-card px-[22px] py-5">
          {paymentQuery.data ? (
            <AutoReloadEditor
              organizationId={organizationId}
              autoReload={paymentQuery.data.autoReload}
              canEdit={Boolean(paymentQuery.data.paymentMethod)}
            />
          ) : (
            <StatePanel tone={paymentQuery.isError ? 'error' : 'default'}>
              <div className="flex items-center justify-between gap-3">
                <span>{paymentDependencyMessage}</span>
                {paymentQuery.isError ? (
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={() => paymentQuery.refetch()}
                    title="Retry payment settings"
                  >
                    <RefreshCw className="size-3.5" />
                    <span className="sr-only">Retry payment settings</span>
                  </Button>
                ) : null}
              </div>
            </StatePanel>
          )}

          <div className="my-5 h-px bg-border" />

          {paymentQuery.data ? (
            <OneTimeTopUp organizationId={organizationId} payment={paymentQuery.data} />
          ) : (
            <StatePanel>{paymentDependencyMessage}</StatePanel>
          )}
        </div>
      </section>

      <section data-testid="billing-receipts">
        <SectionTitle
          title="Receipts"
          count={receipts.data ? `${receipts.data.total.toLocaleString('en-US')} records` : undefined}
          right={
            <label className="flex h-8 w-full items-center border border-input bg-background px-3 font-mono text-[11px] focus-within:border-brand sm:w-56">
              <Search className="size-3.5 shrink-0 text-brand" />
              <input
                aria-label="Search receipts"
                value={receiptsQuery}
                onChange={(event) => changeReceiptsQuery(event.target.value)}
                placeholder="search receipts..."
                className="h-full min-w-0 flex-1 bg-transparent pl-2 text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
          }
        />

        {receipts.isLoading ? (
          <StatePanel>Loading receipts...</StatePanel>
        ) : receipts.isError || !receipts.data ? (
          <StatePanel tone="error">
            <div className="flex items-center justify-between gap-3">
              <span>Receipts are unavailable.</span>
              <Button variant="outline" size="icon-sm" onClick={() => receipts.refetch()} title="Retry receipts">
                <RefreshCw className="size-3.5" />
                <span className="sr-only">Retry receipts</span>
              </Button>
            </div>
          </StatePanel>
        ) : (
          <div>
            <div className="hidden grid-cols-[150px_110px_120px_1fr_130px_32px] gap-x-6 border-b border-border px-0.5 pb-2 font-mono text-[10px] uppercase text-muted-foreground sm:grid">
              <span>Date</span>
              <span>Type</span>
              <span>Status</span>
              <span />
              <span className="text-right">Amount</span>
              <span />
            </div>

            {receipts.data.items.length === 0 ? (
              <div className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground">
                No receipts found
              </div>
            ) : (
              receipts.data.items.map((receipt) => <ReceiptRow key={receipt.id} receipt={receipt} />)
            )}
          </div>
        )}

        {receipts.data ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 px-0.5 font-mono text-[11px] text-muted-foreground">
            <span>
              Page {receipts.data.page} of {pageCount} / {receipts.data.total.toLocaleString('en-US')} records
            </span>
            <div className="flex items-center gap-1">
              {receipts.isFetching ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => setReceiptsPage((currentPage) => Math.max(1, currentPage - 1))}
                disabled={receiptsPage <= 1}
                title="Previous page"
              >
                <ChevronLeft className="size-3.5" />
                <span className="sr-only">Previous page</span>
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => setReceiptsPage((currentPage) => Math.min(pageCount, currentPage + 1))}
                disabled={receiptsPage >= pageCount}
                title="Next page"
              >
                <ChevronRight className="size-3.5" />
                <span className="sr-only">Next page</span>
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}
