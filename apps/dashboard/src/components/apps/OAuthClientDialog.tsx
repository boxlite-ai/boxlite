/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertTriangle, ArrowUpRight } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useSetOAuthClient } from '@/hooks/mutations/useAppMutations'
import type { AppDetail, AppSignInMethod } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { CopyIconButton, DIALOG_FRAME, FlatButton } from './spec'
import { ToolButton } from './SubNav'

// One sign-in method's OAuth app, as the approved mock designed it: BoxLite-managed keys (nothing
// to set up), or the App's own OAuth app (client id and secret, with the callback URL to register).
// It applies to every environment of the App and takes effect on the next sign-in.

const SETUP: Record<string, { label: string; url: string; text: string }> = {
  github: {
    label: 'GitHub',
    url: 'https://github.com/settings/applications/new',
    text: 'Create an OAuth app on GitHub',
  },
  google: {
    label: 'Google',
    url: 'https://console.cloud.google.com/apis/credentials',
    text: 'Create an OAuth client in Google Cloud',
  },
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function OAuthClientDialog({
  app,
  method,
  onClose,
}: {
  app: AppDetail
  method: AppSignInMethod
  onClose: () => void
}) {
  const meta = SETUP[method.provider] ?? { label: method.provider, url: '', text: '' }
  const saving = useSetOAuthClient()
  const ownNow = method.keys === 'own'
  const [shared, setShared] = useState(!ownNow && method.managedAvailable)
  const [clientId, setClientId] = useState(method.clientId ?? '')
  const [secret, setSecret] = useState('')
  const [replacing, setReplacing] = useState(false)

  const changed = shared !== !ownNow || (!shared && (clientId.trim() !== (method.clientId ?? '') || !!secret))
  const missing = !shared && (!clientId.trim() || (!secret && !ownNow))
  const blocked = !changed || missing || saving.isPending

  const save = async () => {
    if (blocked) return
    try {
      await saving.mutateAsync({
        appId: app.id,
        provider: method.provider,
        body: shared
          ? { keys: 'shared' }
          : { keys: 'own', clientId: clientId.trim(), ...(secret ? { clientSecret: secret } : {}) },
      })
      toast.success(
        shared ? `${meta.label} sign-in uses BoxLite's keys` : `${meta.label} sign-in uses your OAuth app`,
        { description: 'For every environment of this app, from the next sign-in.' },
      )
      onClose()
    } catch (error) {
      handleApiError(error, `Could not save ${meta.label} sign-in`)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[540px] font-mono text-body')}>
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">{meta.label} sign-in</DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between gap-4 border-y border-border/60 py-3">
          <div>
            <div className={method.managedAvailable ? 'text-foreground' : 'text-muted-foreground'}>
              Use BoxLite-managed keys
            </div>
            <div className="text-[12px] text-muted-foreground">
              {method.managedAvailable
                ? 'No OAuth app to create.'
                : `BoxLite has no ${meta.label} app here; use your own.`}
            </div>
          </div>
          <Switch checked={shared} disabled={!method.managedAvailable} onCheckedChange={setShared} />
        </div>

        {shared ? (
          <div className="flex gap-2 text-[12px] text-warning">
            <AlertTriangle className="mt-[1px] size-[14px] shrink-0" />
            <span>
              People see BoxLite, not your app, on the {meta.label} consent screen. Use your own OAuth app before real
              users sign in.
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 text-[12px]">
              {meta.url && (
                <a
                  href={meta.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
                >
                  1. {meta.text} <ArrowUpRight className="size-3" />
                </a>
              )}
              <span className="text-muted-foreground">2. Set its callback URL to</span>
              <div className="flex items-center gap-2 bg-card/60 px-3 py-2">
                <code className="min-w-0 flex-1 truncate text-foreground" title={method.redirectUri}>
                  {method.redirectUri}
                </code>
                <CopyIconButton text={method.redirectUri} title="Copy callback URL" />
              </div>
              <span className="text-muted-foreground">3. Paste its client ID and secret here</span>
            </div>
            <Field label="Client ID">
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={`${meta.label} OAuth client ID`}
                className="font-mono"
              />
            </Field>
            {ownNow && !replacing ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-muted-foreground">Client secret</span>
                <span className="flex items-center gap-3">
                  <span className="text-foreground">Secret saved</span>
                  <ToolButton onClick={() => setReplacing(true)}>Replace</ToolButton>
                </span>
              </div>
            ) : (
              <Field label="Client secret" hint="Saved for this app only. It cannot be viewed after saving.">
                <Input
                  type="password"
                  value={secret}
                  autoFocus={replacing}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={`${meta.label} OAuth client secret`}
                  className="font-mono"
                />
              </Field>
            )}
          </div>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-[12px] text-muted-foreground">
            {missing
              ? 'Enter the client ID and secret, or use BoxLite-managed keys.'
              : !changed
                ? 'No changes to save'
                : ''}
          </span>
          <span className="flex gap-2">
            <FlatButton onClick={onClose}>Cancel</FlatButton>
            <FlatButton variant="primary" disabled={blocked} onClick={() => void save()}>
              Save
            </FlatButton>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
