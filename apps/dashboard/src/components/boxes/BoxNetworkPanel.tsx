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
      <span className="size-[6px] flex-none bg-brand" />
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
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'text-[11px] uppercase tracking-[1px] text-muted-foreground underline decoration-dotted underline-offset-[3px]',
        'transition-colors hover:text-foreground hover:decoration-solid',
        'disabled:pointer-events-none disabled:no-underline disabled:opacity-40',
      )}
    >
      {children}
    </button>
  )
}

export type BoxNetworkPanelProps = {
  isPublic: boolean
  isPublicPending?: boolean
  /** False for viewers, who see the state but cannot change exposure. */
  canManage: boolean
  onTogglePublic: (next: boolean) => void
  /** Opens the port prompt that resolves a preview URL. */
  onGetUrl: () => void
}

/**
 * Who can reach this box, and a way to get a preview URL for one of its ports.
 *
 * The section does not list ports, because the console cannot enumerate what is
 * listening inside a guest — see `BoxPreviewUrlDialog` for why. Rather than
 * showing a list of guesses, the URL is fetched on demand for a port the user
 * names, which is something the REST surface answers reliably.
 */
export function BoxNetworkPanel({
  isPublic,
  isPublicPending = false,
  canManage,
  onTogglePublic,
  onGetUrl,
}: BoxNetworkPanelProps) {
  const [confirmingPublic, setConfirmingPublic] = useState(false)

  return (
    <>
      <SectionHeader title="network" right={<InlineAction onClick={onGetUrl}>get url</InlineAction>} />

      {/* `access` answers the only question this row is asked — can a stranger
          open this box? — rather than naming the mechanism.

          The URLs it governs carry no credential (`getPortPreviewUrl` returns
          `url` and `token` separately), so a non-member is bounced through
          OIDC and then refused by the org-membership check in
          preview.controller.ts:142. Access is credential-based, not
          network-based: there is no inbound IP allowlist (openapi/box.openapi
          .yaml — "no layer enforces an inbound allowlist today").

          Sheet convention: grey key, foreground value; hue carries the risk
          signal (amber when exposed). */}
      <div className="mb-[6px] flex items-baseline gap-2">
        <span className="whitespace-nowrap text-muted-foreground">access</span>
        <span className="-translate-y-1 min-w-[8px] flex-1 border-b border-dotted border-border" />
        <span className="whitespace-nowrap" style={isPublic ? { color: STATUS.idle } : undefined}>
          {isPublic ? 'anyone' : 'your organization'}
        </span>
        {canManage ? (
          <InlineAction
            disabled={isPublicPending}
            onClick={() => (isPublic ? onTogglePublic(false) : setConfirmingPublic(true))}
          >
            {isPublicPending ? '…' : 'change'}
          </InlineAction>
        ) : null}
      </div>

      <AlertDialog open={confirmingPublic} onOpenChange={setConfirmingPublic}>
        <AlertDialogContent className="font-mono">
          <AlertDialogHeader>
            <AlertDialogTitle>Open this box&apos;s preview URLs to anyone?</AlertDialogTitle>
            {/* Scoped deliberately. The flag only makes the proxy skip
                authentication for preview traffic (get_box_target.go:87) and
                raw tunnel CONNECTs (tunnel.go:43). The web terminal stays
                authenticated even when public — the same line exempts
                TERMINAL_PORT — and the management API is untouched. An earlier
                "Make this box public?" read as handing over the whole box. */}
            <AlertDialogDescription>
              Anyone who knows a preview URL will reach <strong>any port your box is serving</strong> without signing
              in. The URL is not a secret — it ends up in browser history, proxy logs and Referer headers.
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
                onTogglePublic(true)
                setConfirmingPublic(false)
              }}
            >
              Open to anyone
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
