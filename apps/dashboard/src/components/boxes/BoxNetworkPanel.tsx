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
import { BoxSectionHeader } from './BoxSectionHeader'

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

/** `enabled · 2 hosts allowed`: an allowlist narrows egress, so it is part of the value. */
function outboundLabel(outbound: NetworkInfo['outbound']): string {
  if (outbound.mode !== NetworkMode.ENABLED) return 'disabled'
  const allowed = outbound.allow_net.length
  if (allowed === 0) return 'enabled'
  return `enabled · ${allowed} ${allowed === 1 ? 'host' : 'hosts'} allowed`
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
  const inboundEnabled = network?.inbound.mode === NetworkMode.ENABLED

  return (
    <>
      {/* A URL is a tunnel: the API grants it only with inbound access, to members who can manage the box. */}
      <BoxSectionHeader
        title="Network"
        right={
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
      <div className="mb-4 grid grid-cols-[80px_minmax(0,1fr)] gap-3 sm:grid-cols-[100px_minmax(0,1fr)]">
        <span className="text-meta text-muted-foreground">Outbound</span>
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {network ? outboundLabel(network.outbound) : 'unknown'}
        </span>
      </div>

      {/* Disabled is a proxy-level block; enabled tunnels retain their own access policy. */}
      <div className="mb-4 grid grid-cols-[80px_minmax(0,1fr)] gap-3 sm:grid-cols-[100px_minmax(0,1fr)]">
        <span className="text-meta text-muted-foreground">Inbound</span>
        <div className="flex flex-wrap items-center gap-3">
          <span className="whitespace-nowrap" style={inboundEnabled ? { color: STATUS.idle } : undefined}>
            {network ? (inboundEnabled ? 'enabled' : 'disabled') : 'unknown'}
          </span>
          {canManage && network ? (
            <Switch
              aria-label="Inbound access"
              checked={inboundEnabled}
              disabled={inboundPending}
              onCheckedChange={(next) => (next ? setConfirmingInbound(true) : onToggleInbound(NetworkMode.DISABLED))}
              className="shrink-0"
            />
          ) : null}
        </div>
      </div>

      <AlertDialog open={confirmingInbound} onOpenChange={setConfirmingInbound}>
        <AlertDialogContent className="font-mono">
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
