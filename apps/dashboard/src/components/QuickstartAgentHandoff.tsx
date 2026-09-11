/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QuickstartCopyButton } from '@/components/QuickstartCopyButton'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { createApiKeyWithFallbackName } from '@/lib/quickstart-api-key'
import { cn } from '@/lib/utils'
import { RoutePath } from '@/enums/RoutePath'
import { ArrowUpRight } from '@/components/ui/icon'
import type { OnboardingProgress } from '@/lib/onboarding-progress'
import {
  CreateApiKeyPermissionsEnum,
  OrganizationRolePermissionsEnum,
  type ApiKeyResponse,
} from '@boxlite-ai/api-client'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, generatePath } from 'react-router-dom'

const AGENT_GUIDE_URL = 'https://boxlite.ai/agent.md'

// The key travels through a third-party coding agent's transcript, so it is
// scoped and short-lived by construction rather than by warning the user.
const KEY_LIFETIME_DAYS = 7

const POLL_INTERVAL_MS = 5000
// How long to wait for org members before treating the load as failed.
const PERMISSION_WAIT_MS = 10_000
const POLL_PAGE_SIZE = 20

// Written the way the user would say it out loud — first person, the ask
// first, credentials as an aside. It is pasted into a chat with an agent, so
// it should read like someone talking, not like a runbook.
const ASK = `Read ${AGENT_GUIDE_URL}, then build me a CRM system and put it online on BoxLite so I get a public URL I can share.`

/**
 * The plaintext key is returned exactly once, so without somewhere to keep it
 * the flow is a trap: copy, switch to the terminal, reopen, and the key is
 * unrecoverable while a dead one is left behind in the account.
 *
 * `sessionStorage`, not `localStorage`: it covers every case the trap needs
 * covering for — reopening the dialog, reloading the page — and then dies with
 * the tab, so a bearer credential is never left at rest for the next person on
 * a shared machine. It is scoped per user and per organization on top of that,
 * because rehydrating one org's key inside another would hand the user a
 * credential for the wrong account. Not in `LocalStorageKey`: different store.
 */
const HANDOFF_KEY_PREFIX = 'QuickstartAgentHandoff_'

function handoffKey(userId: string, orgId: string) {
  return `${HANDOFF_KEY_PREFIX}${userId}_${orgId}`
}

// Everything after the last underscore is secret. Splitting there rather than
// at a fixed offset keeps the mask correct for any prefix length — deployments
// configure their own, so a hard-coded slice would print key body characters
// for a short one.
export function maskKey(key: string) {
  const cut = key.lastIndexOf('_')
  return `${cut > 0 ? key.slice(0, cut + 1) : ''}${'•'.repeat(18)}`
}

type HandoffBox = {
  id: string
  name?: string
  public?: boolean
}

type Handoff = {
  keyValue: string
  keyName: string
  baselineIds: string[]
  issuedAt: number
  /** Recorded once the box is online, so re-entering shows the result instead
   *  of restarting the wait — and does not mint a replacement key. */
  completed?: { id: string; name?: string }
}

function readHandoff(storageKey: string): Handoff | null {
  let raw: string | null = null
  try {
    raw = globalThis.sessionStorage?.getItem(storageKey) ?? null
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Handoff
    // Every field is checked: a hand-edited or truncated blob must not produce
    // NaN arithmetic that silently reads as "not expired".
    if (typeof parsed?.keyValue !== 'string' || !parsed.keyValue) return null
    if (!Number.isFinite(parsed.issuedAt)) return null
    if (!Array.isArray(parsed.baselineIds)) return null
    if (Date.now() - parsed.issuedAt > KEY_LIFETIME_DAYS * 24 * 60 * 60 * 1000) return null
    return parsed
  } catch {
    return null
  }
}

function writeHandoff(storageKey: string, handoff: Handoff | null) {
  try {
    if (handoff) globalThis.sessionStorage?.setItem(storageKey, JSON.stringify(handoff))
    else globalThis.sessionStorage?.removeItem(storageKey)
  } catch {
    /* storage may be unavailable or full; the in-memory copy still works */
  }
}

/**
 * Whether a key may be minted right now. Pulled out as a pure function because
 * the bug it encodes — issuing while the component still holds the *previous*
 * identity's handoff — mints a live credential, and that is not something to
 * leave provable only by clicking through the UI.
 */
export function shouldIssueKey(state: {
  /** `handoff` has been re-read for the identity currently on screen. */
  hydrated: boolean
  hasHandoff: boolean
  failed: boolean
  hasOrg: boolean
  storageKey: string | null
  permissionCount: number
  alreadyIssuingForKey: boolean
}) {
  if (!state.storageKey || !state.hasOrg) return false
  // The gate that matters: a stale `null` handoff from the previous identity
  // reads exactly like "nothing stored for this one".
  if (!state.hydrated) return false
  if (state.hasHandoff || state.failed) return false
  if (state.permissionCount === 0) return false
  return !state.alreadyIssuingForKey
}

/**
 * Box records carry no creator field, so the agent's box is identified as "one
 * that did not exist when the key was issued". The baseline is a set of ids
 * rather than a timestamp because `createdAt` is the server's clock and the
 * comparison would be against the browser's: a slow client clock would never
 * match the new box, a fast one would claim an existing box.
 */
export function findAgentBox(boxes: HandoffBox[] | undefined, baselineIds: ReadonlySet<string> | null) {
  if (!boxes || !baselineIds) return null
  return boxes.find((box) => !baselineIds.has(box.id)) ?? null
}

export function QuickstartAgentHandoff({
  restApiUrl,
  onProgressChange,
}: {
  restApiUrl: string
  onProgressChange: (progress: OnboardingProgress) => void
}) {
  const { apiKeyApi, boxApi } = useApi()
  const { selectedOrganization, organizationMembers, refreshOrganizationMembers, authenticatedUserHasPermission } =
    useSelectedOrganization()
  const userId = useAuth().user?.profile.sub
  const orgId = selectedOrganization?.id
  const storageKey = userId && orgId ? handoffKey(userId, orgId) : null

  // Members load in the background, and the permission check reads false until
  // they land. Without this an owner is told they lack permission for the first
  // moment of every open.
  const permissionsKnown = organizationMembers.length > 0
  // That fetch swallows its own failure, so "not loaded yet" and "will never
  // load" look identical. Time-box it rather than spin on "Preparing…" forever.
  const [permissionsTimedOut, setPermissionsTimedOut] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  useEffect(() => {
    if (permissionsKnown) {
      setPermissionsTimedOut(false)
      return
    }
    const timer = window.setTimeout(() => setPermissionsTimedOut(true), PERMISSION_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [permissionsKnown, retryNonce])
  const canCreateApiKey =
    permissionsKnown && authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)

  // The identity is carried *inside* the state, not alongside it in a ref.
  // A ref is set by an effect, so within the commit that follows an identity
  // change the value is still the previous identity's while the ref already
  // says otherwise — which is exactly how a second key gets minted.
  const [handoffState, setHandoffState] = useState<{ identity: string | null; value: Handoff | null }>(() => ({
    identity: storageKey,
    value: storageKey ? readHandoff(storageKey) : null,
  }))
  const hydrated = handoffState.identity === storageKey
  const handoff = hydrated ? handoffState.value : null
  // Read by effects that must not re-run on every write.
  const handoffRef = useRef(handoff)
  handoffRef.current = handoff
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [reached, setReached] = useState(false)
  // The box is frozen at the moment it finishes. It joins the baseline right
  // after, which is what stops a later poll re-claiming it — so the poll can
  // no longer supply the name the success line renders.
  const [finishedBox, setFinishedBox] = useState<HandoffBox | null>(null)
  // Restore a completion recorded before this mount (the SDK walkthrough
  // unmounts this component, so returning must not restart the wait).
  const restoredOnce = useRef(false)
  useEffect(() => {
    if (restoredOnce.current || !hydrated) return
    restoredOnce.current = true
    const done = handoff?.completed ?? null
    if (done) {
      setFinishedBox(done)
      setReached(true)
    }
  }, [hydrated, handoff])
  // A set, not one ref: switching org A -> B -> A while A's request is still
  // open would let a single slot be overwritten and then re-enter, minting a
  // second key for A. Membership is per identity and only cleared on failure.
  const issuingFor = useRef(new Set<string>())
  // The identity currently on screen, readable from an async callback whose
  // closure captured an older one.
  const onScreenIdentity = useRef(storageKey)
  useEffect(() => {
    onScreenIdentity.current = storageKey
  }, [storageKey])

  // Rehydrate when the identity actually changes. Deliberately does not touch
  // `issuingFor`: an in-flight request belongs to the identity that started it.
  useEffect(() => {
    if (hydrated) return
    setReached(false)
    setFinishedBox(null)
    setFailed(false)
    setHandoffState({ identity: storageKey, value: storageKey ? readHandoff(storageKey) : null })
  }, [hydrated, storageKey])

  const permissions = useMemo(() => {
    if (!canCreateApiKey) return []
    const list: CreateApiKeyPermissionsEnum[] = [CreateApiKeyPermissionsEnum.WRITE_BOXES]
    if (authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_BOXES)) {
      list.push(CreateApiKeyPermissionsEnum.DELETE_BOXES)
    }
    return list
  }, [authenticatedUserHasPermission, canCreateApiKey])

  // Nothing to click: the prompt is the product of this screen, so it is ready
  // before the user has finished reading the heading.
  useEffect(() => {
    if (
      !storageKey ||
      !shouldIssueKey({
        hydrated,
        hasHandoff: Boolean(handoff),
        failed,
        hasOrg: Boolean(orgId),
        storageKey,
        permissionCount: permissions.length,
        alreadyIssuingForKey: issuingFor.current.has(storageKey),
      })
    ) {
      return
    }
    const startedFor = storageKey
    issuingFor.current.add(startedFor)
    void (async () => {
      try {
        // Baseline first: a key that does not exist yet cannot have made a box.
        const existing = (await boxApi.listBoxesPaginated(orgId, 1, POLL_PAGE_SIZE)).data.items as HandoffBox[]
        const expiresAt = new Date(Date.now() + KEY_LIFETIME_DAYS * 24 * 60 * 60 * 1000)
        const key = (
          await createApiKeyWithFallbackName<{ data: ApiKeyResponse }>(
            (name) => apiKeyApi.createApiKey({ name, permissions, expiresAt }, orgId),
            { baseName: 'quickstart' },
          )
        ).data
        const next: Handoff = {
          keyValue: key.value,
          keyName: key.name,
          baselineIds: existing.map((box) => box.id),
          issuedAt: Date.now(),
        }
        // Always stored against the identity that asked for it, so switching
        // away and back rehydrates this key instead of minting another.
        writeHandoff(startedFor, next)
        // Only rendered if that identity is still the one on screen — showing
        // one account a credential minted for another is the failure this
        // guards against.
        if (onScreenIdentity.current === startedFor) setHandoffState({ identity: startedFor, value: next })
      } catch {
        issuingFor.current.delete(startedFor)
        if (onScreenIdentity.current === startedFor) setFailed(true)
      }
    })()
  }, [apiKeyApi, boxApi, failed, handoff, hydrated, orgId, permissions, storageKey])

  const retry = useCallback(() => {
    if (storageKey) issuingFor.current.delete(storageKey)
    setFailed(false)
    setPermissionsTimedOut(false)
    // Members are fetched once per organization and the provider swallows the
    // failure, so clearing the flag alone would leave the screen stuck with no
    // affordance left. Ask for them again, and re-arm the timeout either way.
    setRetryNonce((n) => n + 1)
    void refreshOrganizationMembers().catch(() => undefined)
  }, [refreshOrganizationMembers, storageKey])

  const baselineIds = useMemo(() => (handoff ? new Set(handoff.baselineIds) : null), [handoff])

  const { data: boxes } = useQuery({
    queryKey: ['quickstart-handoff-boxes', orgId],
    enabled: Boolean(orgId) && baselineIds !== null,
    // The stage is terminal, so stop polling once it lands.
    refetchInterval: reached ? false : POLL_INTERVAL_MS,
    // The whole point of this screen is that the user copies the prompt and
    // leaves for their terminal, which hides the tab. React Query pauses timed
    // refetches while hidden by default, so the progress would freeze during
    // exactly the stretch it exists to report on.
    refetchIntervalInBackground: true,
    queryFn: async () => (await boxApi.listBoxesPaginated(orgId, 1, POLL_PAGE_SIZE)).data.items as HandoffBox[],
  })

  const agentBox = useMemo(() => findAgentBox(boxes, baselineIds), [boxes, baselineIds])
  // Publishing is only done once the box is actually reachable.
  const stageDone = agentBox?.public === true

  useEffect(() => {
    if (!stageDone || !agentBox) return
    setFinishedBox((prev) => prev ?? agentBox)
    setReached(true)
  }, [stageDone, agentBox])

  useEffect(() => {
    if (!reached) return
    onProgressChange({ boxCreated: true, sdkConnected: true })
    if (!finishedBox) return
    // The key and the baseline are kept, not cleared. Clearing them made
    // leaving and returning mint a replacement key and lose the result.
    // Instead the finished box is recorded and folded *into* the baseline, so
    // a later poll cannot re-claim it and report success for work that never
    // happened.
    setHandoffState((prev) => {
      if (!prev.value) return prev
      const already = prev.value.completed?.id === finishedBox.id
      if (already) return prev
      const next: Handoff = {
        ...prev.value,
        baselineIds: prev.value.baselineIds.includes(finishedBox.id)
          ? prev.value.baselineIds
          : [...prev.value.baselineIds, finishedBox.id],
        completed: { id: finishedBox.id, name: finishedBox.name },
      }
      if (prev.identity) writeHandoff(prev.identity, next)
      return { ...prev, value: next }
    })
  }, [reached, finishedBox, onProgressChange])

  const buildPrompt = useCallback(
    (apiKey: string) =>
      [
        ASK,
        '',
        'My BoxLite credentials — put these in my shell profile first:',
        `BOXLITE_REST_URL=${restApiUrl}`,
        `BOXLITE_API_KEY=${apiKey}`,
      ].join('\n'),
    [restApiUrl],
  )

  // Only the clipboard carries the real key. On screen it stays masked, so a
  // screen share or a screenshot of this dialog does not leak a credential.
  const shownPrompt = handoff ? buildPrompt(maskKey(handoff.keyValue)) : ''

  const copy = useCallback(() => {
    if (!handoff) return
    try {
      navigator.clipboard?.writeText(buildPrompt(handoff.keyValue))
    } catch {
      /* clipboard may be unavailable */
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }, [buildPrompt, handoff])

  if (permissionsKnown && !canCreateApiKey) {
    return (
      <p className="px-8 py-8 text-[12.5px] leading-relaxed text-muted-foreground">
        Your role cannot create API keys, so this path needs an organization owner to start it.
      </p>
    )
  }

  // Three stages, one row each, and nothing else moves: the card is the only
  // thing on this screen that changes after the copy, so it is where the eye
  // should be able to rest.
  const stage: 'waiting' | 'building' | 'live' = reached ? 'live' : agentBox ? 'building' : 'waiting'
  const shownBox = finishedBox ?? agentBox

  return (
    <div className="px-8 pb-6 pt-6">
      <div className="mb-2 flex items-center justify-between gap-4">
        <div className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
          <span className="text-brand">▸</span> Prompt
          {handoff && (
            <>
              <span className="mx-[7px] text-border">·</span>
              key <span className="text-foreground">{handoff.keyName}</span>
              <span className="mx-[7px] text-border">·</span>
              boxes only
              <span className="mx-[7px] text-border">·</span>
              {KEY_LIFETIME_DAYS}d
            </>
          )}
        </div>
      </div>

      <div className="flex items-start gap-3 border border-border bg-[hsl(var(--code-background))] px-[14px] py-3">
        <pre className="scrollbar-elevated min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words text-[12.5px] leading-[1.7] text-foreground">
          {handoff ? shownPrompt : 'Preparing your key…'}
        </pre>
        <QuickstartCopyButton
          copied={copied}
          onClick={copy}
          className={cn(!handoff && 'pointer-events-none opacity-40')}
        />
      </div>

      {(failed || permissionsTimedOut) && (
        <div className="mt-3 text-[11.5px] leading-relaxed">
          <button type="button" onClick={retry} className="text-destructive underline underline-offset-2">
            {permissionsTimedOut && !failed ? 'Could not confirm your permissions.' : 'Could not create a key.'} Try
            again
          </button>
        </div>
      )}

      {/* The outcome, drawn before it exists. A ghost row says "a box will
          appear here" more plainly than a sentence about waiting does, and the
          same row then fills in, so nothing jumps when the agent delivers. */}
      <div className="mt-6 font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
        <span className="text-brand">▸</span> Your app
      </div>
      <div
        className={cn(
          'mt-2 flex items-center gap-3 border px-4 py-3 transition-colors',
          stage === 'live' ? 'border-brand bg-[hsl(var(--brand)/0.06)]' : 'border-border',
        )}
      >
        <span
          className={cn(
            'inline-block size-[8px] flex-none rounded-full',
            stage === 'waiting' ? 'bg-muted-foreground/40' : 'bg-brand',
          )}
          style={
            stage === 'live'
              ? undefined
              : { animation: `${stage === 'waiting' ? 'qs-pulse' : 'live-pulse'} 2s infinite` }
          }
        />
        <div className="min-w-0 flex-1 font-mono text-[12.5px] leading-none">
          {stage === 'waiting' ? (
            <span className="halftone-brand block h-[10px] w-[220px] max-w-full" aria-hidden />
          ) : (
            <span className="truncate text-foreground">{shownBox?.name ?? shownBox?.id}</span>
          )}
        </div>
        <span className="flex-none text-[11px] text-muted-foreground">
          {stage === 'waiting' && 'waiting for your agent'}
          {stage === 'building' && 'building…'}
          {stage === 'live' && shownBox && (
            <Link
              to={generatePath(RoutePath.BOX_DETAILS, { boxId: shownBox.id })}
              className="inline-flex items-center gap-1 text-foreground hover:text-brand"
            >
              online · open <ArrowUpRight className="size-[11px]" />
            </Link>
          )}
        </span>
      </div>
    </div>
  )
}
