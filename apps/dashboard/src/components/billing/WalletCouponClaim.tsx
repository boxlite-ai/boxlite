/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CouponClaimUnconfirmedError } from '@/api/coupon-claim'
import { AsciiButton, Panel } from '@/components/ascii'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { invalidateCouponQueries } from '@/hooks/mutations/useRedeemCouponMutation'
import { useApi } from '@/hooks/useApi'

type AcceptedClaim = 'pending' | 'credited'

const skipReasons: Record<string, string> = {
  coupon_not_found: 'Coupon not found.',
  coupon_wrong_organization: 'This coupon is not available to this organization.',
  coupon_already_redeemed: 'Coupon has already been redeemed.',
  coupon_disabled: 'This coupon is disabled.',
  coupon_expired: 'This coupon has expired.',
  coupon_exhausted: 'This coupon is exhausted.',
}

function eventIdFor(accountId: string, organizationId: string, code: string) {
  const key = 'boxlite.coupon-claim.' + JSON.stringify([accountId, organizationId, code])
  const previous = sessionStorage.getItem(key)
  if (previous) return previous
  const eventId = crypto.randomUUID()
  sessionStorage.setItem(key, eventId)
  return eventId
}

interface ClaimFormProps {
  accountId: string
  organizationId: string
  organizationName: string
  code: string
  automatic: boolean
  onAccepted: (outcome: AcceptedClaim) => void
}

// The caller keys this form by account, organization and code. A late response
// from a previous form must never clear the next link or announce its result.
function ClaimForm({ accountId, organizationId, organizationName, code, automatic, onAccepted }: ClaimFormProps) {
  const api = useApi()
  const client = useQueryClient()
  const acceptCurrentClaim = useRef<ClaimFormProps['onAccepted'] | null>(null)
  const attempted = useRef(false)
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useLayoutEffect(() => {
    acceptCurrentClaim.current = onAccepted
    return () => {
      acceptCurrentClaim.current = null
    }
  }, [onAccepted])

  const claim = useCallback(async () => {
    if (submitting.current) return
    submitting.current = true
    attempted.current = true
    setBusy(true)
    setError('')
    try {
      const eventId = eventIdFor(accountId, organizationId, code)
      const receipt = await api.claimCoupon(organizationId, { eventId, couponCode: code })
      if (!acceptCurrentClaim.current) return
      if (receipt.status === 'pending') {
        acceptCurrentClaim.current('pending')
      } else if (receipt.result?.outcome === 'processed') {
        void invalidateCouponQueries(client, organizationId)
        acceptCurrentClaim.current('credited')
      } else {
        const reason = receipt.result?.outcome === 'skipped' && receipt.result.reason
        throw new Error(reason ? (skipReasons[reason] ?? reason) : '')
      }
    } catch (cause) {
      if (!acceptCurrentClaim.current) return
      const message =
        cause instanceof CouponClaimUnconfirmedError
          ? cause.message
          : ['Reward claim failed.', cause instanceof Error ? cause.message : ''].filter(Boolean).join(' ')
      setError(message)
      toast.error(message)
    } finally {
      submitting.current = false
      if (acceptCurrentClaim.current) setBusy(false)
    }
  }, [accountId, api, client, code, organizationId])

  useEffect(() => {
    if (automatic && !attempted.current) void claim()
  }, [automatic, claim])

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="font-semibold">Claim reward</h2>
        <p className="text-meta text-muted-foreground">Credits go to {organizationName}.</p>
        {error && (
          <p role="alert" className="mt-1 text-meta text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Reward coupon code"
          placeholder="Enter coupon code"
          value={code}
          readOnly
          className="h-9 max-w-[200px] font-mono"
        />
        <AsciiButton onClick={claim} disabled={busy}>
          {busy && <Spinner />} Claim reward
        </AsciiButton>
      </div>
    </div>
  )
}

interface WalletCouponClaimProps extends Omit<ClaimFormProps, 'onAccepted' | 'code'> {
  code?: string
  cardConnected?: boolean
  onAccepted?: () => void
  connectCard: () => void
  connectingCard: boolean
}

export function WalletCouponClaim({
  code,
  cardConnected,
  onAccepted,
  connectCard,
  connectingCard,
  ...form
}: WalletCouponClaimProps) {
  const [view, setView] = useState<{ code?: string; outcome?: AcceptedClaim }>({ code })
  // Removing the accepted link keeps its receipt visible. A new link opens a fresh form.
  if (code !== view.code) setView({ code, outcome: code ? undefined : view.outcome })

  const messageFor = (outcome: AcceptedClaim) => {
    if (outcome === 'credited') return 'Reward credited.'
    if (cardConnected === undefined) return 'Your reward claim was received.'
    return cardConnected ? 'Your reward is being processed.' : 'Add a card soon to claim your reward.'
  }

  if (!code && !view.outcome) return null
  return (
    <Panel className="px-[22px] py-4">
      {view.outcome ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status">{messageFor(view.outcome)}</p>
          {view.outcome === 'pending' && cardConnected === false && (
            <AsciiButton onClick={connectCard} disabled={connectingCard}>
              Add card
            </AsciiButton>
          )}
        </div>
      ) : (
        code && (
          <ClaimForm
            key={code}
            {...form}
            code={code}
            onAccepted={(outcome) => {
              setView({ code, outcome })
              if (outcome === 'credited') toast.success(messageFor(outcome))
              else toast.info(messageFor(outcome))
              onAccepted?.()
            }}
          />
        )
      )}
    </Panel>
  )
}
