/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { usePromptDraft } from '@/hooks/usePromptDraft'
import { CODING_AGENT_MARKS } from '@/assets/AgentLogos'
import { QuickstartCopyButton } from '@/components/QuickstartCopyButton'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { createApiKeyWithFallbackName } from '@/lib/quickstart-api-key'
import { copyToClipboard } from '@/lib/copy-text'
import {
  HANDOFF_LIFETIME_MS,
  handoffIdentity,
  handoffStore,
  shouldIssueKey,
  shouldRestoreCompletion,
  type Handoff,
  type HandoffBox,
} from '@/lib/quickstart-handoff'
import { cn } from '@/lib/utils'
import { isInboundEnabled } from '@/lib/box-shape'
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

const POLL_INTERVAL_MS = 5000
// How long to wait for org members before treating the load as failed.
const PERMISSION_WAIT_MS = 10_000
const POLL_PAGE_SIZE = 20

// Written the way the user would say it out loud — first person, the ask
// first, credentials as an aside. It is pasted into a chat with an agent, so
// it should read like someone talking, not like a runbook.
const ASK = `Read ${AGENT_GUIDE_URL}, then build me a CRM system and put it online on BoxLite so I get a public URL I can share.`

// Everything after the last underscore is secret. Splitting there rather than
// at a fixed offset keeps the mask correct for any prefix length — deployments
// configure their own, so a hard-coded slice would print key body characters
// for a short one.
export function maskKey(key: string) {
  const cut = key.lastIndexOf('_')
  return `${cut > 0 ? key.slice(0, cut + 1) : ''}${'•'.repeat(18)}`
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

export function QuickstartAgentHandoff(props: Parameters<typeof QuickstartAgentHandoffContent>[0]) {
  const { selectedOrganization } = useSelectedOrganization()
  const userId = useAuth().user?.profile.sub
  return <QuickstartAgentHandoffContent key={`${userId}:${selectedOrganization?.id}`} {...props} />
}

function QuickstartAgentHandoffContent({
  restApiUrl,
  composeRequest = false,
  onProgressChange,
  onLeave,
}: {
  restApiUrl: string
  composeRequest?: boolean
  onProgressChange: (progress: OnboardingProgress) => void
  /** Following a link out of the dialog has to close it: the host lives in the
   *  persistent dashboard shell, so its `open` survives the navigation and the
   *  dialog would sit on top of the page it sent the user to. */
  onLeave?: () => void
}) {
  const [copiedRequest, setCopiedRequest] = useState<string | null>(null)
  const [copying, setCopying] = useState(false)
  const [preparedRequest, setPreparedRequest] = useState<string | null>(null)
  const [confirmationFailed, setConfirmationFailed] = useState(false)
  const api = useApi()
  const { apiKeyApi, boxApi } = api
  const { selectedOrganization, organizationMembers, refreshOrganizationMembers, authenticatedUserHasPermission } =
    useSelectedOrganization()
  const userId = useAuth().user?.profile.sub
  const orgId = selectedOrganization?.id
  const draft = usePromptDraft(orgId, userId, composeRequest)
  const { text: request, setText: setRequest } = draft
  const submission = useRef<{ text: string; id: string } | null>(null)
  const copiedSubmission = useRef<{ id: string } | null>(null)
  const identity = userId && orgId ? handoffIdentity(userId, orgId) : null

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
    identity: identity,
    value: identity ? handoffStore.get(identity) : null,
  }))
  const hydrated = handoffState.identity === identity
  const handoff = hydrated ? handoffState.value : null
  // Read by effects that must not re-run on every write.
  const handoffRef = useRef(handoff)
  handoffRef.current = handoff
  const [failed, setFailed] = useState(false)
  // A copy that did not happen has to say so: silence reads as an unclicked
  // button, and the prompt is the one thing this screen exists to hand over.
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  const [reached, setReached] = useState(false)
  // The box is frozen at the moment it finishes. It joins the baseline right
  // after, which is what stops a later poll re-claiming it — so the poll can
  // no longer supply the name the success line renders.
  const [finishedBox, setFinishedBox] = useState<HandoffBox | null>(null)
  // Restore a completion recorded before this mount (the SDK walkthrough
  // unmounts this component, so returning must not restart the wait).
  const restoredFor = useRef<string | null>(null)
  useEffect(() => {
    if (composeRequest || !shouldRestoreCompletion({ hydrated, restoredFor: restoredFor.current, identity })) return
    restoredFor.current = identity
    const done = handoff?.completed ?? null
    if (done) {
      setFinishedBox(done)
      setReached(true)
    }
  }, [hydrated, handoff, identity, composeRequest])
  // A set, not one ref: switching org A -> B -> A while A's request is still
  // open would let a single slot be overwritten and then re-enter, minting a
  // second key for A. Membership is per identity and only cleared on failure.
  const issuingFor = useRef(new Set<string>())
  // The identity currently on screen, readable from an async callback whose
  // closure captured an older one.
  const onScreenIdentity = useRef(identity)
  useEffect(() => {
    onScreenIdentity.current = identity
  }, [identity])

  // Rehydrate when the identity actually changes. Deliberately does not touch
  // `issuingFor`: an in-flight request belongs to the identity that started it.
  useEffect(() => {
    if (hydrated) return
    setReached(false)
    setFinishedBox(null)
    setFailed(false)
    setHandoffState({ identity: identity, value: identity ? handoffStore.get(identity) : null })
  }, [hydrated, identity])

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
      !identity ||
      !shouldIssueKey({
        hydrated,
        hasHandoff: Boolean(handoff),
        failed,
        hasOrg: Boolean(orgId),
        identity,
        permissionCount: permissions.length,
        alreadyIssuingForKey: issuingFor.current.has(identity),
      })
    ) {
      return
    }
    const startedFor = identity
    issuingFor.current.add(startedFor)
    void (async () => {
      try {
        // Baseline first: a key that does not exist yet cannot have made a box.
        const existing = (await boxApi.listBoxesPaginated(orgId, 1, POLL_PAGE_SIZE)).data.items as HandoffBox[]
        const expiresAt = new Date(Date.now() + HANDOFF_LIFETIME_MS)
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
        // Always kept against the identity that asked for it, so switching
        // away and back reuses this key instead of minting another.
        handoffStore.set(startedFor, next)
        // Only rendered if that identity is still the one on screen — showing
        // one account a credential minted for another is the failure this
        // guards against.
        if (onScreenIdentity.current === startedFor) setHandoffState({ identity: startedFor, value: next })
      } catch {
        issuingFor.current.delete(startedFor)
        if (onScreenIdentity.current === startedFor) setFailed(true)
      }
    })()
  }, [apiKeyApi, boxApi, failed, handoff, hydrated, orgId, permissions, identity])

  const retry = useCallback(() => {
    if (identity) issuingFor.current.delete(identity)
    setFailed(false)
    setPermissionsTimedOut(false)
    // Members are fetched once per organization and the provider swallows the
    // failure, so clearing the flag alone would leave the screen stuck with no
    // affordance left. Ask for them again, and re-arm the timeout either way.
    setRetryNonce((n) => n + 1)
    void refreshOrganizationMembers().catch(() => undefined)
  }, [refreshOrganizationMembers, identity])

  const baselineIds = useMemo(() => (handoff ? new Set(handoff.baselineIds) : null), [handoff])

  const { data: boxes } = useQuery({
    queryKey: ['quickstart-handoff-boxes', orgId],
    enabled: !composeRequest && Boolean(orgId) && baselineIds !== null,
    // The stage is terminal, so stop polling once it lands.
    refetchInterval: reached ? false : POLL_INTERVAL_MS,
    // The whole point of this screen is that the user copies the prompt and
    // leaves for their terminal, which hides the tab. React Query pauses timed
    // refetches while hidden by default, so the progress would freeze during
    // exactly the stretch it exists to report on.
    refetchIntervalInBackground: true,
    queryFn: async () => (await boxApi.listBoxesPaginated(orgId, 1, POLL_PAGE_SIZE)).data.items as HandoffBox[],
  })

  const agentBox = useMemo(
    () => (composeRequest ? null : findAgentBox(boxes, baselineIds)),
    [boxes, baselineIds, composeRequest],
  )
  // Publishing is only done once the box is actually reachable.
  const stageDone = agentBox ? isInboundEnabled(agentBox) : false

  useEffect(() => {
    if (!stageDone || !agentBox) return
    setFinishedBox((prev) => prev ?? agentBox)
    setReached(true)
  }, [stageDone, agentBox])

  useEffect(() => {
    if (!reached || composeRequest) return
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
      if (prev.identity) handoffStore.set(prev.identity, next)
      return { ...prev, value: next }
    })
  }, [reached, finishedBox, onProgressChange, composeRequest])

  const buildPrompt = useCallback(
    (apiKey: string) =>
      [
        composeRequest
          ? `Read ${AGENT_GUIDE_URL}. Work from this local coding-agent session.

Application request: ${request.trim()}

Build and test the application inside a Box. Choose an appropriate image. Use the documented BoxLite API to start the application and configure its network access. Verify the application is reachable before returning its URL. Explain any unsupported deployment requirements.

Verify that the credentials are valid and authorized for this task before executing anything.`
          : ASK,
        '',
        composeRequest
          ? 'Use these credentials for this task; do not commit them:'
          : 'My BoxLite credentials — put these in my shell profile first:',
        `BOXLITE_REST_URL=${restApiUrl}`,
        `BOXLITE_API_KEY=${apiKey}`,
      ].join('\n'),
    [restApiUrl, composeRequest, request],
  )

  // Only the clipboard carries the real key. On screen it stays masked, so a
  // screen share or a screenshot of this dialog does not leak a credential.
  const shownPrompt = handoff ? buildPrompt(maskKey(handoff.keyValue)) : ''

  const confirmCopy = async (receipt = copiedSubmission.current) => {
    if (!receipt) return
    try {
      await api.markPromptCopied(orgId!, receipt.id)
      if (copiedSubmission.current === receipt) setConfirmationFailed(false)
    } catch {
      if (copiedSubmission.current === receipt) setConfirmationFailed(true)
    }
  }

  const prepare = async () => {
    if (!handoff || !request.trim()) return
    setCopying(true)
    setCopied(null)
    try {
      await draft.flush()
      if (!submission.current || submission.current.text !== request)
        submission.current = { text: request, id: crypto.randomUUID() }
      await api.preparePromptHandoff(orgId!, request, submission.current.id)
      setPreparedRequest(request)
    } catch {
      setCopied('failed')
    } finally {
      setCopying(false)
    }
  }

  const copy = async () => {
    if (!handoff || (composeRequest && preparedRequest !== request)) return
    const receipt = composeRequest && submission.current ? { id: submission.current.id } : null
    copiedSubmission.current = receipt
    setCopying(true)
    try {
      // Invoke the clipboard during this click; network preparation was completed
      // by the previous gesture, so Safari/Firefox retain user activation.
      const success = await copyToClipboard(buildPrompt(handoff.keyValue))
      if (composeRequest && copiedSubmission.current !== receipt) return
      if (!success) {
        setCopied('failed')
        return
      }
      setCopied('done')
      setCopiedRequest(`${identity}:${request}`)
      if (composeRequest) await confirmCopy(receipt)
      else setTimeout(() => setCopied(null), 1600)
    } finally {
      setCopying(false)
    }
  }

  // Three stages, one row each, and nothing else moves: the card is the only
  // thing on this screen that changes after the copy, so it is where the eye
  // should be able to rest.
  const stage: 'waiting' | 'building' | 'live' = composeRequest
    ? 'waiting'
    : reached
      ? 'live'
      : agentBox
        ? 'building'
        : 'waiting'
  const shownBox = finishedBox ?? agentBox

  // The user copies the prompt and leaves for their agent; the tab title is the
  // one thing they can see from another window. Say it there, and put it back.
  useEffect(() => {
    if (stage === 'waiting') return
    const previous = document.title
    const name = shownBox?.name ?? shownBox?.id ?? 'your box'
    document.title = stage === 'live' ? `● ${name} is live — BoxLite` : `◌ ${name} is building — BoxLite`
    return () => {
      document.title = previous
    }
  }, [stage, shownBox?.name, shownBox?.id])

  if (permissionsKnown && !canCreateApiKey) {
    return (
      <p className="px-8 py-8 text-meta leading-relaxed text-muted-foreground">
        Your role cannot create API keys, so this path needs an organization owner to start it.
      </p>
    )
  }

  if (composeRequest) {
    const handedOff = copiedRequest === `${identity}:${request}`
    return (
      <section className="min-w-0 pb-8 font-display">
        <div className="mb-7 flex flex-wrap items-center gap-6 text-muted-foreground" aria-label="Local coding agents">
          {CODING_AGENT_MARKS.map(({ label, Mark }) => (
            <span key={label} title={label} className="inline-flex size-8 items-center justify-center">
              <Mark className="size-7 object-contain" />
            </span>
          ))}
        </div>
        <h2 className="text-section font-semibold tracking-tight">What would you like to build?</h2>
        <p className="mt-2 text-body text-muted-foreground">
          Describe your app. Your coding agent will build and deploy it in a Box, with a public URL you can share.
        </p>
        <div className="mt-5 rounded-none bg-card p-4 focus-within:ring-1 focus-within:ring-brand/50 sm:p-5">
          <textarea
            aria-label="Application request"
            placeholder="An app that…"
            value={request}
            onChange={(event) => {
              copiedSubmission.current = null
              setRequest(event.target.value)
              setCopiedRequest(null)
              setPreparedRequest(null)
              setConfirmationFailed(false)
              setCopied(null)
            }}
            maxLength={16000}
            disabled={!draft.ready}
            onBlur={() => {
              if (draft.ready) void draft.flush().catch(() => {})
            }}
            rows={3}
            className="w-full resize-y bg-transparent text-em leading-relaxed outline-none placeholder:text-muted-foreground/60"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
            <span className="text-meta text-muted-foreground" role="status">
              {draft.error ? (
                <>
                  {draft.error}{' '}
                  <button onClick={() => void draft.retry().catch(() => {})} className="underline">
                    Retry
                  </button>
                </>
              ) : !draft.ready ? (
                'Loading draft…'
              ) : draft.saving || draft.dirty ? (
                'Saving…'
              ) : (
                'Saved'
              )}
            </span>
            <button
              type="button"
              disabled={!handoff || !draft.ready || !request.trim() || copying}
              onClick={() => void (preparedRequest === request ? copy() : prepare())}
              className="rounded-none bg-foreground px-5 py-2.5 text-body font-medium text-background transition-opacity hover:opacity-85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-35"
            >
              {copying
                ? preparedRequest === request
                  ? 'Copying…'
                  : 'Preparing…'
                : preparedRequest !== request
                  ? 'Prepare prompt'
                  : handedOff
                    ? 'Copy again'
                    : 'Copy prompt'}
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-meta text-muted-foreground">
          <span>Try an idea</span>
          {[
            ['Internal dashboard', 'Build an internal dashboard to track projects, owners, and deadlines.'],
            ['API service', 'Build a REST API for a task list with persistent storage.'],
            ['Personal website', 'Build a personal portfolio website with projects and a contact page.'],
          ].map(([label, value]) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                copiedSubmission.current = null
                setRequest(value)
                setCopiedRequest(null)
                setPreparedRequest(null)
                setConfirmationFailed(false)
                setCopied(null)
              }}
              className="underline decoration-muted-foreground/30 underline-offset-4 hover:text-foreground focus-visible:outline-brand"
            >
              {label}
            </button>
          ))}
        </div>
        {(failed || permissionsTimedOut) && (
          <p className="mt-4 text-body text-destructive">
            Could not prepare your key.{' '}
            <button type="button" onClick={retry} className="underline">
              Try again
            </button>
          </p>
        )}
        {!handoff && !failed && !permissionsTimedOut && (
          <p className="mt-4 text-meta text-muted-foreground" role="status">
            Preparing your key…
          </p>
        )}
        {copied === 'failed' && (
          <p role="alert" className="mt-4 text-body text-destructive">
            Could not save or copy the prompt. Your text is still here. Try again.
          </p>
        )}
        {confirmationFailed && (
          <p role="status" className="mt-4 text-body text-muted-foreground">
            Prompt copied, but confirmation could not be saved.{' '}
            <button type="button" className="underline" onClick={() => void confirmCopy()}>
              Retry confirmation
            </button>
          </p>
        )}
        {handedOff && (
          <div role="status" className="mt-6 bg-brand/[0.06] px-5 py-4">
            <p className="text-body font-medium">Prompt copied. Continue in your coding agent.</p>
            <p className="mt-1 text-body text-muted-foreground">
              Paste the prompt into your local coding agent’s chat and review the proposed actions.
            </p>
          </div>
        )}
        <details className="mt-6 text-body text-muted-foreground">
          <summary className="w-fit cursor-pointer hover:text-foreground">View prompt</summary>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-none quickstart-code-surface p-4 font-mono text-meta leading-relaxed text-foreground">
            {handoff ? shownPrompt : 'Preparing your key…'}
          </pre>
        </details>
      </section>
    )
  }

  return (
    <div className="px-8 pb-6 pt-6">
      <div className="mb-2 flex items-center justify-between gap-4">
        {/* An instruction, not a spec sheet. This line used to read
            "Prompt · key quickstart-77ff · boxes only · 7d · this tab only":
            a section label followed by four telegraphic notes about a
            credential the reader never asked for, at the moment they are
            trying to copy something. The key itself is visible in the prompt
            below; its scope and lifetime belong on the API Keys page. */}
        <div className="min-w-0 truncate font-mono text-label uppercase tracking-[1.5px] text-muted-foreground">
          <span className="text-brand">▸</span> Copy this prompt to your agent
        </div>
      </div>

      <div
        className={cn(
          'quickstart-code-surface flex items-start gap-3 px-[14px] py-3',
          composeRequest ? 'rounded-none' : 'border border-border',
        )}
      >
        <pre className="scrollbar-elevated min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words text-meta leading-[1.7] text-foreground">
          {handoff ? shownPrompt : 'Preparing your key…'}
        </pre>
        <QuickstartCopyButton
          quiet={composeRequest}
          copied={copied === 'done'}
          failed={copied === 'failed'}
          onClick={() => void copy()}
          className={cn((!handoff || (composeRequest && !request.trim())) && 'pointer-events-none opacity-40')}
        />
      </div>

      {(failed || permissionsTimedOut) && (
        <div className="mt-3 text-meta leading-relaxed">
          <button type="button" onClick={retry} className="text-destructive underline underline-offset-2">
            {permissionsTimedOut && !failed ? 'Could not confirm your permissions.' : 'Could not create a key.'} Try
            again
          </button>
        </div>
      )}

      {/* The outcome, drawn before it exists. A ghost row says "a box will
          appear here" more plainly than a sentence about waiting does, and the
          same row then fills in, so nothing jumps when the agent delivers. */}
      <div className="mt-6 font-mono text-label uppercase tracking-[1.5px] text-muted-foreground">
        <span className="text-brand">▸</span> Your app
      </div>
      <div
        className={cn(
          'mt-2 flex items-center gap-3 px-4 py-3 transition-colors',
          composeRequest ? 'rounded-none bg-card' : 'border',
          !composeRequest && (stage === 'live' ? 'border-brand bg-[hsl(var(--brand)/0.06)]' : 'border-border'),
        )}
        // Re-mount on each stage so the row arrives rather than flips.
        key={stage}
        style={{ animation: 'stat-in .35s ease' }}
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
        <div className="min-w-0 flex-1 font-mono text-meta leading-none">
          {stage === 'waiting' ? (
            <span className="halftone-brand block h-[10px] w-[220px] max-w-full" aria-hidden />
          ) : (
            <span className="truncate text-foreground">{shownBox?.name ?? shownBox?.id}</span>
          )}
        </div>
        <span className="flex-none text-label text-muted-foreground">
          {stage === 'waiting' && 'waiting for your agent'}
          {stage === 'building' && 'building…'}
          {stage === 'live' && shownBox && (
            <Link
              to={generatePath(RoutePath.BOX_DETAILS, { boxId: shownBox.id })}
              onClick={() => onLeave?.()}
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
