/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CouponClaimUnconfirmedError, type CouponClaimReceipt } from '@/api/coupon-claim'
import { AsciiButton, Panel } from '@/components/ascii'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { invalidateCouponQueries } from '@/hooks/mutations/useRedeemCouponMutation'
import { useApi } from '@/hooks/useApi'

type ClaimOutcome = 'pending' | 'credited' | { failure: string }

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

function claimOutcome(receipt: CouponClaimReceipt): ClaimOutcome {
  if (receipt.status === 'pending') return 'pending'
  if (receipt.result?.outcome === 'processed') return 'credited'
  const reason = receipt.result?.outcome === 'skipped' && receipt.result.reason
  return { failure: ['Reward claim failed.', reason && (skipReasons[reason] ?? reason)].filter(Boolean).join(' ') }
}

function messageFor(outcome: ClaimOutcome, cardConnected?: boolean) {
  if (typeof outcome === 'object') return outcome.failure
  if (outcome === 'credited') return 'Reward credited.'
  if (cardConnected === undefined) return 'Your reward claim was received.'
  return cardConnected ? 'Your reward is being processed.' : 'Add a card soon to claim your reward.'
}

interface WalletCouponClaimProps {
  accountId: string
  organizationId: string
  organizationName: string
  code?: string
  automatic: boolean
  cardConnected?: boolean
  onAccepted?: () => void
  connectCard: () => void
  connectingCard: boolean
}

interface SavedClaim {
  code: string
  eventId: string
  outcome: ClaimOutcome
  replay: boolean
}

interface ClaimRowProps extends Omit<WalletCouponClaimProps, 'onAccepted' | 'code'> {
  code: string
  saved?: SavedClaim
  pendingPrefix: string
  onReceipt: (claim: SavedClaim) => void
}

function ClaimRow({
  accountId,
  organizationId,
  organizationName,
  code,
  automatic,
  saved,
  pendingPrefix,
  onReceipt,
  cardConnected,
  connectCard,
  connectingCard,
}: ClaimRowProps) {
  const api = useApi()
  const client = useQueryClient()
  const current = useRef<ClaimRowProps['onReceipt'] | null>(null)
  const attempted = useRef(false)
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [received, setReceived] = useState<ClaimOutcome>()
  const outcome = received ?? saved?.outcome
  useLayoutEffect(() => {
    current.current = onReceipt
    return () => {
      current.current = null
    }
  }, [onReceipt])

  const claim = useCallback(async () => {
    if (submitting.current) return
    submitting.current = true
    attempted.current = true
    setBusy(true)
    setError('')
    try {
      const couponCode = code.trim().toUpperCase()
      const eventId = saved?.eventId ?? eventIdFor(accountId, organizationId, couponCode)
      const receipt = await api.claimCoupon(organizationId, { eventId, couponCode })
      const result = claimOutcome(receipt)
      const pendingKey = pendingPrefix + couponCode
      if (result === 'pending') sessionStorage.setItem(pendingKey, eventId)
      else sessionStorage.removeItem(pendingKey)
      if (result === 'credited') void invalidateCouponQueries(client, organizationId)
      if (!current.current) return
      setReceived(result)
      current.current({ code: couponCode, eventId, outcome: result, replay: false })
    } catch (cause) {
      if (!current.current) return
      const message =
        cause instanceof CouponClaimUnconfirmedError
          ? cause.message
          : ['Reward claim failed.', cause instanceof Error ? cause.message : ''].filter(Boolean).join(' ')
      setError(message)
      if (!saved) toast.error(message)
    } finally {
      submitting.current = false
      if (current.current) setBusy(false)
    }
  }, [accountId, api, client, code, organizationId, pendingPrefix, saved])

  useEffect(() => {
    if (automatic && !attempted.current) void claim()
  }, [automatic, claim])

  return (
    <Panel className="px-[22px] py-4">
      {outcome ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-meta text-muted-foreground">{code}</p>
            <p role={typeof outcome === 'object' ? 'alert' : 'status'}>{messageFor(outcome, cardConnected)}</p>
          </div>
          {outcome === 'pending' && cardConnected === false && (
            <AsciiButton onClick={connectCard} disabled={connectingCard}>
              Add card
            </AsciiButton>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Claim reward</h2>
            <p className="text-meta text-muted-foreground">Credits go to {organizationName}.</p>
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
      )}
      {error && (
        <div className="mt-1 flex items-center gap-3">
          <p role="alert" className="text-meta text-destructive">
            {error}
          </p>
          {saved && (
            <AsciiButton onClick={claim} disabled={busy}>
              Check again
            </AsciiButton>
          )}
        </div>
      )}
    </Panel>
  )
}

export function WalletCouponClaim({ code, onAccepted, ...props }: WalletCouponClaimProps) {
  const pendingPrefix = 'boxlite.pending-coupon.' + JSON.stringify([props.accountId, props.organizationId]) + '.'
  // A code-less Wallet mount rechecks each accepted pending receipt once. Clearing
  // the URL on acceptance already has a fresh receipt and needs no additional POST.
  const [claims, setClaims] = useState<SavedClaim[]>(() => {
    try {
      return Object.keys(sessionStorage)
        .filter((key) => key.startsWith(pendingPrefix))
        .map((key) => ({
          code: key.slice(pendingPrefix.length),
          eventId: sessionStorage.getItem(key)!,
          outcome: 'pending',
          replay: !code,
        }))
    } catch {
      return []
    }
  })
  const remember = (claim: SavedClaim) =>
    setClaims((previous) => [...previous.filter((item) => item.code !== claim.code), claim])

  if (code)
    return (
      <ClaimRow
        {...props}
        key={'link:' + code.trim().toUpperCase()}
        code={code}
        pendingPrefix={pendingPrefix}
        onReceipt={(claim) => {
          remember(claim)
          const message = messageFor(claim.outcome, props.cardConnected)
          if (claim.outcome === 'credited') toast.success(message)
          else if (claim.outcome === 'pending') toast.info(message)
          else toast.error(message)
          onAccepted?.()
        }}
      />
    )
  return claims.map((claim) => (
    <ClaimRow
      {...props}
      key={claim.code}
      code={claim.code}
      pendingPrefix={pendingPrefix}
      automatic={claim.replay}
      saved={claim}
      onReceipt={remember}
    />
  ))
}
