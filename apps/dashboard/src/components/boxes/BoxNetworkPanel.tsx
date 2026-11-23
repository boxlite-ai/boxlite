/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

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
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ChevronDown } from '@/components/ui/icon'
import { NetworkMode, type NetworkInfo } from '@boxlite-ai/api-client'
import { useState, type ReactNode } from 'react'
import { BoxDetailField, BoxDetailHeading } from './BoxDetailFields'

/**
 * Mirrors the palette in BoxDetails so the network section reads as part of the
 * same spec sheet rather than a widget bolted onto it.
 */
const STATUS = { idle: '#e0b341' } as const

export type BoxNetworkPanelProps = {
  /** Additional network fields (for example SSH), before tunnel actions. */
  children?: ReactNode
  /** The box's policy in both directions; absent when the API did not report it. */
  network?: NetworkInfo
  inboundPending?: boolean
  /** False for viewers, who see the state but cannot change exposure. */
  canManage: boolean
  onToggleInbound: (next: NetworkMode) => void
  onCreateTunnel: () => void
}

/** Display the effective policy without treating CIDRs as hostnames. */
function OutboundPolicy({ outbound }: { outbound?: NetworkInfo['outbound'] }) {
  if (outbound?.mode === NetworkMode.DISABLED) return <>disabled</>
  if (outbound?.mode !== NetworkMode.ENABLED) return <>unknown</>
  if (outbound.allow_net.length === 0) return <>Unrestricted</>
  return (
    <details className="group min-w-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring">
        <span>
          Restricted · {outbound.allow_net.length} {outbound.allow_net.length === 1 ? 'rule' : 'rules'}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <ul
        aria-label="Allowed outbound destinations"
        className="mt-2 space-y-1 border-l border-border pl-3 font-mono text-meta text-muted-foreground [overflow-wrap:anywhere]"
      >
        {outbound.allow_net.map((rule, index) => (
          <li key={`${index}:${rule}`}>{rule}</li>
        ))}
      </ul>
    </details>
  )
}

/** Box-wide network policy, with explicit per-port tunnel actions. */
export function BoxNetworkPanel({
  network,
  inboundPending = false,
  canManage,
  onToggleInbound,
  onCreateTunnel,
  children,
}: BoxNetworkPanelProps) {
  const [confirmingInbound, setConfirmingInbound] = useState(false)
  const inboundEnabled = network?.inbound?.mode === NetworkMode.ENABLED
  const inboundDisabled = network?.inbound?.mode === NetworkMode.DISABLED
  const inboundKnown = inboundEnabled || inboundDisabled

  return (
    <>
      <BoxDetailHeading title="Network" />

      {/* Sheet convention: grey key, foreground value; hue carries the risk
          signal (amber when inbound is enabled). Outbound is read-only: no
          route changes it after create. */}
      <dl>
        <BoxDetailField label="Outbound" className="font-sans">
          <OutboundPolicy outbound={network?.outbound} />
        </BoxDetailField>

        {/* Disabled is a proxy-level block; enabled tunnels retain their own access policy. */}
        <BoxDetailField label="Inbound" className="font-sans">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <span className="whitespace-nowrap" style={inboundEnabled ? { color: STATUS.idle } : undefined}>
              {inboundEnabled ? 'enabled' : inboundDisabled ? 'disabled' : 'unknown'}
            </span>
            {canManage && inboundKnown ? (
              <Switch
                aria-label="Inbound access"
                checked={inboundEnabled}
                disabled={inboundPending}
                onCheckedChange={(next) => (next ? setConfirmingInbound(true) : onToggleInbound(NetworkMode.DISABLED))}
                className="shrink-0"
              />
            ) : null}
          </div>
        </BoxDetailField>
      </dl>

      {children}
      <div className="mt-4 flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={onCreateTunnel}
          disabled={!canManage}
          title={!canManage ? 'Managing tunnels requires permission to manage this Box' : undefined}
        >
          Create tunnel
        </Button>
      </div>

      <AlertDialog open={confirmingInbound} onOpenChange={setConfirmingInbound}>
        <AlertDialogContent className="font-sans">
          <AlertDialogHeader>
            <AlertDialogTitle>Enable inbound access for this box?</AlertDialogTitle>
            <AlertDialogDescription>
              This restores access to previously configured tunnels, using each tunnel’s public or private policy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onToggleInbound(NetworkMode.ENABLED)
                setConfirmingInbound(false)
              }}
            >
              Enable inbound access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
