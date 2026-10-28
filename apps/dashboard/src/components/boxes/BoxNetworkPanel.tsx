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
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { NetworkMode, type NetworkInfo } from '@boxlite-ai/api-client'
import { useState, type ReactNode } from 'react'

/**
 * Mirrors the palette in BoxDetails so the network section reads as part of the
 * same spec sheet rather than a widget bolted onto it.
 */
const STATUS = { idle: '#e0b341' } as const

/**
 * Local copy of the section header from BoxDetails. It is module private there,
 * so duplicating this one small helper is cheaper than reaching into it. Worth
 * extracting to a shared module the next time either file is touched.
 */
function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="mb-[10px] mt-[34px] flex items-center gap-[9px] first:mt-0">
      <span className="text-label leading-none text-brand">▸</span>
      <span className="text-[11px] uppercase tracking-[2px]">{title}</span>
      <span className="flex-1 border-t border-dashed border-border" />
      {right}
    </div>
  )
}

/**
 * A secondary text action. Underlined because bare muted text read as a static
 * annotation rather than a control. Stays muted on purpose: exposing a box to
 * the internet should not be the brightest thing on the sheet.
 *
 * Labels here stay short. This column is ~40px wide after the value takes its
 * share of 340px, so a label that spelled out the consequence
 * (`open to anyone`) wrapped onto a second line and squeezed the leader dots
 * to nothing. The consequence belongs in the confirmation dialog, which has
 * room for a paragraph.
 */
function InlineAction({
  children,
  onClick,
  disabled,
  title,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      // The two actions on this sheet are the ones that make a box reachable
      // from outside; they get a button's weight, not a footnote's.
      className={cn(
        'border border-border px-[9px] py-[3px] font-mono text-[10px] uppercase tracking-[1px] text-foreground',
        'transition-colors hover:border-brand',
        'disabled:pointer-events-none disabled:opacity-40',
      )}
    >
      {children}
    </button>
  )
}

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
      <SectionHeader
        title="network"
        right={
          <InlineAction
            onClick={onGetUrl}
            disabled={!inboundEnabled || !canManage}
            title={getUrlHint(inboundEnabled, canManage)}
          >
            get url
          </InlineAction>
        }
      />

      {/* Sheet convention: grey key, foreground value; hue carries the risk
          signal (amber when inbound is enabled). Outbound is read-only: no
          route changes it after create. */}
      <div className="mb-[6px] flex items-baseline gap-2">
        <span className="whitespace-nowrap text-muted-foreground">outbound</span>
        <span className="-translate-y-1 min-w-[8px] flex-1 border-b border-dotted border-border" />
        <span className="whitespace-nowrap">{network ? outboundLabel(network.outbound) : 'unknown'}</span>
      </div>

      {/* Inbound access only lets the proxy skip sign-in for the services the
          box exposes; with it disabled a non-member is bounced through OIDC and
          refused by the org-membership check in preview.controller.ts. Access
          is credential-based, not network-based: no layer enforces an inbound
          allowlist yet. */}
      <div className="mb-[6px] flex items-baseline gap-2">
        <span className="whitespace-nowrap text-muted-foreground">inbound</span>
        <span className="-translate-y-1 min-w-[8px] flex-1 border-b border-dotted border-border" />
        <span className="whitespace-nowrap" style={inboundEnabled ? { color: STATUS.idle } : undefined}>
          {network ? (inboundEnabled ? 'enabled · anyone' : 'disabled · your organization') : 'unknown'}
        </span>
        {canManage && network ? (
          <Switch
            aria-label="Inbound access"
            checked={inboundEnabled}
            disabled={inboundPending}
            onCheckedChange={(next) => (next ? setConfirmingInbound(true) : onToggleInbound(NetworkMode.DISABLED))}
            // A text-less button's baseline is its bottom edge, so the row's
            // baseline alignment would lift it above the text; center it.
            className="ml-1 scale-90 self-center"
          />
        ) : null}
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
              Anyone with the URL of a <strong>port opened as a public tunnel</strong> reaches it without signing in. The
              URL is not a secret — it ends up in browser history, proxy logs and Referer headers. A private tunnel
              also needs its access token or a sign-in to your organization.
              <br />
              <br />
              The web terminal and the box&apos;s files, commands and settings are not affected; those still require
              signing in to your organization.
              <br />
              <br />
              If a port serves API keys or customer data, leave this restricted.
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
