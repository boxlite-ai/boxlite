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
// to set up; GitHub and Google only), or the App's own OAuth app (client id and secret, with the
// callback URL to register; Apple's secret is a .p8 key). It applies to every environment of the
// App and takes effect on the next sign-in.

const SETUP: Record<string, { url: string; text: string; id?: string }> = {
  github: { url: 'https://github.com/settings/applications/new', text: 'Create an OAuth app on GitHub' },
  google: { url: 'https://console.cloud.google.com/apis/credentials', text: 'Create an OAuth client in Google Cloud' },
  microsoft: {
    url: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    text: 'Register an app in Microsoft Entra (any account type), and add a client secret',
    id: 'Application (client) ID',
  },
  apple: {
    url: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
    text: 'Create a Services ID with Sign in with Apple, and a key for it',
    id: 'Services ID',
  },
  x: {
    url: 'https://developer.x.com/en/portal/projects-and-apps',
    text: 'Create an app on X with OAuth 2.0 on, as a Web App',
  },
  facebook: {
    url: 'https://developers.facebook.com/apps/',
    text: 'Create an app in Meta for Developers with Facebook Login',
    id: 'App ID',
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
  const meta = { label: method.label, ...(SETUP[method.provider] ?? { url: '', text: '' }) }
  const apple = method.provider === 'apple'
  const saving = useSetOAuthClient()
  const ownNow = method.keys === 'own'
  const [shared, setShared] = useState(!ownNow && method.managedAvailable)
  const [clientId, setClientId] = useState(method.clientId ?? '')
  const [secret, setSecret] = useState('')
  // Apple: the .p8 key is the secret, with its Team ID and Key ID.
  const [teamId, setTeamId] = useState('')
  const [keyId, setKeyId] = useState('')
  const [replacing, setReplacing] = useState(false)
  const secretGiven = apple ? !!(secret && teamId.trim() && keyId.trim()) : !!secret

  const changed = shared !== !ownNow || (!shared && (clientId.trim() !== (method.clientId ?? '') || secretGiven))
  const missing = !shared && (!clientId.trim() || (!secretGiven && !ownNow))
  const blocked = !changed || missing || saving.isPending

  const save = async () => {
    if (blocked) return
    try {
      await saving.mutateAsync({
        appId: app.id,
        provider: method.provider,
        body: shared
          ? { keys: 'shared' }
          : {
              keys: 'own',
              clientId: clientId.trim(),
              ...(!secretGiven
                ? {}
                : apple
                  ? { teamId: teamId.trim(), keyId: keyId.trim(), privateKey: secret.trim() }
                  : { clientSecret: secret }),
            },
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

        {method.managedAvailable && (
          <div className="flex items-center justify-between gap-4 border-y border-border/60 py-3">
            <div>
              <div className="text-foreground">Use BoxLite-managed keys</div>
              <div className="text-[12px] text-muted-foreground">No OAuth app to create.</div>
            </div>
            <Switch checked={shared} onCheckedChange={setShared} />
          </div>
        )}

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
              <span className="text-muted-foreground">
                3. Paste {apple ? 'its Services ID, Team ID, Key ID and private key' : 'its client ID and secret'} here
              </span>
            </div>
            <Field label={meta.id ?? 'Client ID'}>
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={apple ? 'com.example.web' : `${meta.label} OAuth client ID`}
                className="font-mono"
              />
            </Field>
            {ownNow && !replacing ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-muted-foreground">{apple ? 'Private key' : 'Client secret'}</span>
                <span className="flex items-center gap-3">
                  <span className="text-foreground">{apple ? 'Key saved' : 'Secret saved'}</span>
                  <ToolButton onClick={() => setReplacing(true)}>Replace</ToolButton>
                </span>
              </div>
            ) : apple ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Team ID">
                    <Input
                      value={teamId}
                      onChange={(e) => setTeamId(e.target.value)}
                      placeholder="A1B2C3D4E5"
                      className="font-mono"
                    />
                  </Field>
                  <Field label="Key ID">
                    <Input
                      value={keyId}
                      onChange={(e) => setKeyId(e.target.value)}
                      placeholder="F6G7H8I9J0"
                      className="font-mono"
                    />
                  </Field>
                </div>
                <Field
                  label="Private key (.p8)"
                  hint="The whole file, BEGIN and END lines included. It cannot be viewed after saving."
                >
                  <textarea
                    value={secret}
                    autoFocus={replacing}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={'-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}
                    rows={4}
                    spellCheck={false}
                    className="w-full resize-none border border-input bg-transparent px-3 py-2 font-mono text-[12px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </Field>
              </>
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
              ? method.managedAvailable
                ? 'Enter the client ID and secret, or use BoxLite-managed keys.'
                : `Enter every field of your ${meta.label} app.`
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
