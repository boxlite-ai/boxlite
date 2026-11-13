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
import { NetworkMode, type NetworkInfo } from '@boxlite-ai/api-client'
import { useState } from 'react'
import { BoxDetailField, BoxDetailHeading } from './BoxDetailFields'
import { ChevronDown } from '@/components/ui/icon'

/**
 * Mirrors the palette in BoxDetails so the network section reads as part of the
 * same spec sheet rather than a widget bolted onto it.
 */
const STATUS = { idle: '#e0b341' } as const

export type BoxNetworkPanelProps = {
  /** The box's policy in both directions; absent when the API did not report it. */
  network?: NetworkInfo
  inboundPending?: boolean
  /** False for viewers, who see the state but cannot change exposure. */
  canManage: boolean
  onToggleInbound: (next: NetworkMode) => void
  /** Opens the port prompt that resolves a public URL; needs inbound access. */
  onGetUrl: () => void
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

/** Why "get url" is unavailable: the tunnel route needs inbound access and WRITE_BOXES. */
function getUrlHint(inboundEnabled: boolean, canManage: boolean): string | undefined {
  if (!canManage) return 'Getting a url needs permission to manage this box'
  if (!inboundEnabled) return 'Enable inbound access to get a url'
  return undefined
}

/**
 * Both directions of the box's network policy, and a way to get a URL for one
 * of its ports.
 *
 * The section does not list ports, because the console cannot enumerate what is
 * listening inside a guest — see `BoxPreviewUrlDialog` for why. Rather than
 * showing a list of guesses, the URL is fetched on demand for a port the user
 * names, which is something the REST surface answers reliably.
 */
export function BoxNetworkPanel({
  network,
  inboundPending = false,
  canManage,
  onToggleInbound,
  onGetUrl,
}: BoxNetworkPanelProps) {
  const [confirmingInbound, setConfirmingInbound] = useState(false)
  const inboundEnabled = network?.inbound?.mode === NetworkMode.ENABLED
  const inboundDisabled = network?.inbound?.mode === NetworkMode.DISABLED
  const inboundKnown = inboundEnabled || inboundDisabled

  return (
    <>
      {/* A URL is a tunnel: the API grants it only with inbound access, to members who can manage the box. */}
      <BoxDetailHeading
        title="Network"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={onGetUrl}
            disabled={!inboundEnabled || !canManage}
            title={getUrlHint(inboundEnabled, canManage)}
          >
            Get URL
          </Button>
        }
      />

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

      <AlertDialog open={confirmingInbound} onOpenChange={setConfirmingInbound}>
        <AlertDialogContent className="font-sans">
          <AlertDialogHeader>
            <AlertDialogTitle>Enable inbound access for this box?</AlertDialogTitle>
            {/* Scoped deliberately. Inbound access only lets the proxy serve
                ports opened as tunnels, under each tunnel's access policy. The web
                terminal does not go through the proxy: it attaches over `/v1`
                with the member's own credentials, and the management API is
                untouched. An earlier "Make this box public?" read as handing
                over the whole box. */}
            <AlertDialogDescription>
              Anyone with the URL of a <strong>port opened as a public tunnel</strong> reaches it without signing in.
              The URL is not a secret — it ends up in browser history, proxy logs and Referer headers. A private tunnel
              also needs its access token or a sign-in to your organization.
              <br />
              <br />
              The web terminal and the box&apos;s files, commands and settings are not affected; those still require
              signing in to your organization.
              <br />
              <br />
              If a port serves API keys or customer data, leave inbound disabled.
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
