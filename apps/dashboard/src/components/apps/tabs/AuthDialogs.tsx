/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertTriangle, ArrowUpRight } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { VISIBILITY_GLYPH, VISIBILITY_LABEL } from '@/lib/apps/format'
import type { AppAuth, AppDetail, AuthMethod, AuthProvider, UpdateAuthInput } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { useState, type ReactNode } from 'react'
import { CopyIconButton, FlatButton, DIALOG_FRAME } from '../spec'
import { ToolButton } from '../SubNav'

// The two editors behind the sign-in methods list: one OAuth provider (shared
// BoxLite keys or the customer's own app), one custom OIDC provider. Plus the
// auth settings that apply to every method, behind the gear.

export type Update = (input: UpdateAuthInput, success: string) => Promise<void>

export type OAuthProvider = Exclude<AuthProvider, 'email'>

export const OAUTH_CATALOG: { id: OAuthProvider; label: string; setupUrl: string; setupLabel: string }[] = [
  {
    id: 'google',
    label: 'Google',
    setupUrl: 'https://console.cloud.google.com/apis/credentials',
    setupLabel: 'Create an OAuth client in Google Cloud',
  },
  {
    id: 'github',
    label: 'GitHub',
    setupUrl: 'https://github.com/settings/developers',
    setupLabel: 'Create an OAuth app on GitHub',
  },
  {
    id: 'microsoft',
    label: 'Microsoft',
    setupUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps',
    setupLabel: 'Register an app in Microsoft Entra',
  },
  {
    id: 'apple',
    label: 'Apple',
    setupUrl: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
    setupLabel: 'Create a Services ID at Apple Developer',
  },
]

export function methodLabel(method: Pick<AuthMethod, 'provider' | 'name'>): string {
  if (method.provider === 'custom') return method.name ?? 'Custom OIDC'
  if (method.provider === 'email') return 'Email code'
  return OAUTH_CATALOG.find((p) => p.id === method.provider)?.label ?? method.provider
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      {children}
      {error ? (
        <span className="text-[12px] text-destructive">{error}</span>
      ) : (
        hint && <span className="text-[12px] text-muted-foreground">{hint}</span>
      )}
    </label>
  )
}

function CallbackUrl({ url }: { url: string }) {
  return (
    <div className="flex items-center gap-2 bg-card/60 px-3 py-2 text-[12px]">
      <code className="min-w-0 flex-1 truncate text-foreground" title={url}>
        {url}
      </code>
      <CopyIconButton text={url} title="Copy callback URL" />
    </div>
  )
}

/** Add or edit one built-in OAuth provider. */
export function OAuthDialog({
  provider,
  existing,
  auth,
  onClose,
  update,
}: {
  provider: OAuthProvider
  existing: AuthMethod | null
  auth: AppAuth
  onClose: () => void
  update: Update
}) {
  const meta = OAUTH_CATALOG.find((p) => p.id === provider) ?? OAUTH_CATALOG[0]
  const [shared, setShared] = useState(existing ? existing.keys === 'shared' : true)
  const [clientId, setClientId] = useState(existing?.clientId ?? '')
  const [secret, setSecret] = useState('')
  const hasSavedSecret = existing?.keys === 'own'
  const [replacing, setReplacing] = useState(false)
  const callback = `${auth.callbackUrl}/${provider}`

  const changed =
    !existing || shared !== (existing.keys === 'shared') || clientId !== (existing.clientId ?? '') || !!secret
  const missing = !shared && (!clientId.trim() || (!secret && !hasSavedSecret))
  const blocked = !changed || missing

  const save = async () => {
    if (blocked) return
    await update(
      { upsertMethod: shared ? { provider, keys: 'shared' } : { provider, keys: 'own', clientId: clientId.trim() } },
      existing ? `${meta.label} sign-in updated` : `${meta.label} sign-in added`,
    )
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[540px] font-mono text-body')}>
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">{meta.label} sign-in</DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between gap-4 border-y border-border/60 py-3">
          <div>
            <div className="text-foreground">Use BoxLite-managed keys</div>
            <div className="text-[12px] text-muted-foreground">No OAuth app to create.</div>
          </div>
          <Switch checked={shared} onCheckedChange={setShared} />
        </div>

        {shared ? (
          <div className="flex gap-2 text-[12px] text-warning">
            <AlertTriangle className="mt-[1px] size-[14px] shrink-0" />
            <span>
              Visitors see BoxLite, not your app, on the {meta.label} consent screen. Use your own app before real users
              sign in.
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 text-[12px]">
              <a
                href={meta.setupUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
              >
                1. {meta.setupLabel} <ArrowUpRight className="size-3" />
              </a>
              <span className="text-muted-foreground">2. Set its callback URL to</span>
              <CallbackUrl url={callback} />
            </div>
            <Field label="Client ID">
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={`${meta.label} OAuth client ID`}
                className="font-mono"
              />
            </Field>
            {hasSavedSecret && !replacing ? (
              // A saved secret is a state, not an editable field that looks filled in.
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-muted-foreground">Client secret</span>
                <span className="flex items-center gap-3">
                  <span className="text-foreground">Secret saved</span>
                  <ToolButton onClick={() => setReplacing(true)}>Replace</ToolButton>
                </span>
              </div>
            ) : (
              <Field label="Client secret" hint="Stored as an app secret. It cannot be viewed after saving.">
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
              {existing ? 'Save changes' : `Add ${meta.label}`}
            </FlatButton>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/

/** Add or edit a custom OIDC provider (Okta, Auth0, Keycloak, a company IdP…). */
export function CustomOidcDialog({
  existing,
  auth,
  onClose,
  update,
}: {
  existing: AuthMethod | null
  auth: AppAuth
  onClose: () => void
  update: Update
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [key, setKey] = useState(existing?.key ?? '')
  const [discoveryUrl, setDiscoveryUrl] = useState(existing?.discoveryUrl ?? '')
  const [clientId, setClientId] = useState(existing?.clientId ?? '')
  const [secret, setSecret] = useState('')

  const taken = !existing && auth.methods.some((m) => m.provider === 'custom' && m.key === key)
  const builtIn = OAUTH_CATALOG.some((p) => p.id === key) || key === 'email'
  const keyError =
    key === ''
      ? undefined
      : !KEY_RE.test(key)
        ? 'Use lowercase letters, numbers, dashes and underscores.'
        : builtIn
          ? 'This key belongs to a built-in provider.'
          : taken
            ? 'A custom provider with this key already exists.'
            : undefined
  const urlError = discoveryUrl && !/^https:\/\/.+/.test(discoveryUrl) ? 'Use the https:// discovery URL.' : undefined
  const blocked =
    !name.trim() || !key || !!keyError || !discoveryUrl || !!urlError || !clientId.trim() || (!existing && !secret)
  const callback = `${auth.callbackUrl}/custom/${key || '<key>'}`

  const save = async () => {
    if (blocked) return
    await update(
      {
        upsertMethod: {
          provider: 'custom',
          keys: 'own',
          key,
          name: name.trim(),
          discoveryUrl,
          clientId: clientId.trim(),
        },
      },
      existing ? `${name} updated` : `${name} sign-in added`,
    )
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[540px] font-mono text-body')}>
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">
            {existing ? `Edit ${existing.name}` : 'Custom OIDC provider'}
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme SSO"
              className="font-mono"
            />
          </Field>
          <Field label="Key" error={keyError}>
            <Input
              value={key}
              disabled={!!existing}
              onChange={(e) => setKey(e.target.value.toLowerCase())}
              placeholder="acme"
              className="font-mono"
            />
          </Field>
        </div>
        <Field label="Discovery URL" error={urlError}>
          <Input
            value={discoveryUrl}
            onChange={(e) => setDiscoveryUrl(e.target.value)}
            placeholder="https://sso.acme.com/.well-known/openid-configuration"
            className="font-mono"
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted-foreground">Callback URL to register with the provider</span>
          <CallbackUrl url={callback} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Client ID">
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Client secret" hint={existing ? 'Saved. Leave empty to keep it.' : undefined}>
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={existing ? '••••••••••••' : ''}
              className="font-mono"
            />
          </Field>
        </div>
        <DialogFooter className="gap-2">
          <FlatButton onClick={onClose}>Cancel</FlatButton>
          <FlatButton variant="primary" disabled={blocked} onClick={() => void save()}>
            {existing ? 'Save' : 'Add provider'}
          </FlatButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const SESSION_TTLS = ['8h', '24h', '7d', '30d']

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-6 border-b border-border/60 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-foreground">{label}</div>
        {hint && <div className="text-[12px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

function AllowedEmails({ auth, update }: { auth: AppAuth; update: Update }) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null) {
    return (
      <>
        <span className={cn('max-w-[220px] truncate', auth.allowedEmails.length === 0 && 'text-muted-foreground')}>
          {auth.allowedEmails.length ? auth.allowedEmails.join(', ') : 'Anyone'}
        </span>
        <ToolButton onClick={() => setDraft(auth.allowedEmails.join(', '))}>Edit</ToolButton>
      </>
    )
  }
  const save = () => {
    const list = draft
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
    setDraft(null)
    void update({ allowedEmails: list }, list.length ? `Only ${list.join(', ')} can sign in` : 'Anyone can sign in')
  }
  return (
    <>
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        placeholder="*@acme.com, dana@partner.io"
        className="h-8 w-[220px] border border-border bg-background px-2 font-mono text-[13px] text-foreground outline-none focus:border-foreground/40"
      />
      <ToolButton primary onClick={save}>
        Save
      </ToolButton>
    </>
  )
}

/** Settings that apply to every sign-in method. Each change applies at once. Login itself is always on. */
export function AuthSettingsDialog({
  app,
  auth,
  update,
  onClose,
}: {
  app: AppDetail
  auth: AppAuth
  update: Update
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[600px] font-mono text-body')}>
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">Auth settings</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col">
          <SettingRow label="Who can open the app" hint="Set from the access menu in the app header.">
            <span>
              {VISIBILITY_GLYPH[app.visibility]} {VISIBILITY_LABEL[app.visibility]}
            </span>
          </SettingRow>
          <SettingRow label="Allow new sign-ups" hint="Off: only people who signed in before can sign in.">
            <Switch
              checked={auth.allowSignups}
              onCheckedChange={(v) => update({ allowSignups: v }, v ? 'New sign-ups allowed' : 'New sign-ups closed')}
            />
          </SettingRow>
          <SettingRow label="Who can sign in" hint="*@domain allows a whole domain.">
            <AllowedEmails auth={auth} update={update} />
          </SettingRow>
          <SettingRow label="Require a verified email">
            <Switch
              checked={auth.requireVerifiedEmail}
              onCheckedChange={(v) =>
                update({ requireVerifiedEmail: v }, v ? 'Verified email required' : 'Verified email not required')
              }
            />
          </SettingRow>
          <SettingRow label="Session length">
            <span className="flex">
              {SESSION_TTLS.map((ttl) => (
                <button
                  key={ttl}
                  type="button"
                  onClick={() => update({ sessionTtl: ttl }, `Sessions last ${ttl}`)}
                  className={cn(
                    '-ml-px h-[26px] min-w-[40px] border border-border px-2 text-[12px] first:ml-0',
                    auth.sessionTtl === ttl
                      ? 'relative z-10 border-foreground/50 bg-card text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {ttl}
                </button>
              ))}
            </span>
          </SettingRow>
        </div>
      </DialogContent>
    </Dialog>
  )
}
