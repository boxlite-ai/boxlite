/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ArrowUpRight, ChevronDown, Plus, Settings } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useAppMutation } from '@/hooks/mutations/useAppMutations'
import { relTime } from '@/lib/apps/format'
import { methodId, type AppAuth, type AppDetail, type AppSmtp, type AuthMethod } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { useConfirm } from '../confirm'
import { useAppAction } from '../useAppAction'
import { toast } from 'sonner'
import { ProviderLogo } from '../ProviderLogo'
import {
  EmptyNote,
  FlatButton,
  GridHeader,
  downloadCsv,
  GridRow,
  HoverActions,
  MoreButton,
  Panel,
  SearchField,
  SpecRow,
  TEXT_INPUT,
} from '../spec'
import { Screen, ToolButton, Workbench } from '../SubNav'
import { Tag } from '../viz'
import {
  AuthSettingsDialog,
  CustomOidcDialog,
  methodLabel,
  OAUTH_CATALOG,
  OAuthDialog,
  type OAuthProvider,
  type Update,
} from './AuthDialogs'

// Auth is the console half of "add a Google login" (POL-863), laid out the way
// common BaaS consoles do it: sign-in methods are a list you add to and edit one at a
// time, each OAuth method on BoxLite's shared keys or the customer's own app;
// settings that apply to every method sit behind the gear. Login is not a
// decision: every app starts with Google and GitHub on BoxLite's shared keys,
// and the last method cannot be removed.

type Section = 'users' | 'methods' | 'email'
const SECTION_IDS: Section[] = ['users', 'methods', 'email']

const USER_GRID = 'grid-cols-[1.8fr_0.8fr_1fr_1fr_0.6fr_120px] gap-x-3'

type Editing =
  | { kind: 'oauth'; provider: OAuthProvider; existing: AuthMethod | null }
  | { kind: 'custom'; existing: AuthMethod | null }

function GearButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Auth settings"
      aria-label="Auth settings"
      className="inline-flex size-[28px] items-center justify-center border border-border text-muted-foreground transition-colors hover:border-brand hover:text-foreground"
    >
      <Settings className="size-[13px]" />
    </button>
  )
}

function AddMethodMenu({
  auth,
  onPick,
  onAddEmail,
}: {
  auth: AppAuth
  onPick: (editing: Editing) => void
  onAddEmail: () => void
}) {
  const enabled = new Set(auth.methods.map((m) => m.provider))
  const available = OAUTH_CATALOG.filter((p) => !enabled.has(p.id))
  const taken = OAUTH_CATALOG.filter((p) => enabled.has(p.id))
  const emailOn = enabled.has('email')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-[28px] items-center gap-1.5 whitespace-nowrap border border-border px-[10px] font-mono text-[12px] text-muted-foreground outline-none transition-colors hover:border-brand hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/35 data-[state=open]:border-brand data-[state=open]:text-foreground"
        >
          <Plus className="size-3.5" /> Add method <ChevronDown className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[15rem] font-mono text-[13px]">
        {available.map((p) => (
          <DropdownMenuItem
            key={p.id}
            className="cursor-pointer gap-3"
            onClick={() => onPick({ kind: 'oauth', provider: p.id, existing: null })}
          >
            <ProviderLogo provider={p.id} size={16} /> {p.label}
          </DropdownMenuItem>
        ))}
        {!emailOn && (
          <DropdownMenuItem className="cursor-pointer gap-3" onClick={onAddEmail}>
            <ProviderLogo provider="email" size={16} /> Email code
          </DropdownMenuItem>
        )}
        <DropdownMenuItem className="cursor-pointer gap-3" onClick={() => onPick({ kind: 'custom', existing: null })}>
          <ProviderLogo provider="custom" size={16} /> Custom OIDC provider
        </DropdownMenuItem>
        {(taken.length > 0 || emailOn) && <DropdownMenuSeparator />}
        {taken.map((p) => (
          <DropdownMenuItem key={p.id} disabled className="justify-between gap-3 opacity-60">
            <span className="inline-flex items-center gap-3">
              <ProviderLogo provider={p.id} size={16} /> {p.label}
            </span>
            <span className="text-[12px]">Added</span>
          </DropdownMenuItem>
        ))}
        {emailOn && (
          <DropdownMenuItem disabled className="justify-between gap-3 opacity-60">
            <span className="inline-flex items-center gap-3">
              <ProviderLogo provider="email" size={16} /> Email code
            </span>
            <span className="text-[12px]">Added</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// A normal configuration choice, said plainly; the consent-screen caveat of
// BoxLite-managed keys belongs in the edit dialog, not as an amber row label.
function MethodBadge({ method, auth }: { method: AuthMethod; auth: AppAuth }) {
  if (method.provider === 'email') return <Tag>{auth.smtp ? 'Sent from your SMTP' : 'Sent by BoxLite'}</Tag>
  if (method.provider === 'custom') return <Tag>OIDC</Tag>
  return <Tag>{method.keys === 'shared' ? 'BoxLite-managed' : 'Custom OAuth app'}</Tag>
}

function Methods({
  app,
  auth,
  update,
  onEdit,
  onSettings,
  onOpenEmail,
}: {
  app: AppDetail
  auth: AppAuth
  update: Update
  onEdit: (editing: Editing) => void
  onSettings: () => void
  onOpenEmail: () => void
}) {
  const addEmail = () =>
    void update({ upsertMethod: { provider: 'email', keys: 'shared' } }, 'Email code sign-in added')
  const [confirm, confirmElement] = useConfirm()
  const remove = async (method: AuthMethod) => {
    const label = methodLabel(method)
    // Login is always on; an app keeps at least one way in.
    if (auth.methods.length === 1) {
      toast.error(`${label} is the only sign-in method. Add another before removing it.`)
      return
    }
    const ok = await confirm({
      title: `Remove ${label} sign-in from ${app.environment}?`,
      body: <>People who signed in with {label} can no longer sign in. Their accounts and data stay.</>,
      confirmLabel: `Remove ${label}`,
      danger: true,
    })
    if (ok) void update({ removeMethod: methodId(method) }, `${label} removed`)
  }

  return (
    <Screen
      title="Sign-in methods"
      actions={
        <>
          <a
            href={auth.loginUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-[28px] items-center gap-1.5 whitespace-nowrap border border-border px-[10px] font-mono text-[12px] text-muted-foreground outline-none transition-colors hover:border-brand hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/35 data-[state=open]:border-brand data-[state=open]:text-foreground"
          >
            Test login <ArrowUpRight className="size-3.5" />
          </a>
          <AddMethodMenu auth={auth} onPick={onEdit} onAddEmail={addEmail} />
          <GearButton onClick={onSettings} />
        </>
      }
    >
      <div className="border-t border-border/60">
        {auth.methods.map((method) => {
          const label = methodLabel(method)
          const edit = () =>
            method.provider === 'email'
              ? onOpenEmail()
              : method.provider === 'custom'
                ? onEdit({ kind: 'custom', existing: method })
                : onEdit({ kind: 'oauth', provider: method.provider, existing: method })
          return (
            <div
              key={methodId(method)}
              className="group flex min-h-[56px] items-center gap-4 px-2 border-b border-border/60 transition-colors hover:bg-card/50"
            >
              <span className="flex w-5 justify-center text-foreground">
                <ProviderLogo provider={method.provider} />
              </span>
              <button type="button" onClick={edit} className="font-semibold text-foreground hover:underline">
                {label}
              </button>
              {method.clientId && (
                <span className="truncate text-[12px] text-muted-foreground" title={method.clientId}>
                  {method.clientId}
                </span>
              )}
              <span className="ml-auto flex items-center gap-3">
                <MethodBadge method={method} auth={auth} />
                <HoverActions>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <MoreButton />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[10rem] font-mono">
                      <DropdownMenuItem className="cursor-pointer" onClick={edit}>
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive focus:text-destructive"
                        onClick={() => void remove(method)}
                      >
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </HoverActions>
              </span>
            </div>
          )
        })}
      </div>
      {confirmElement}
    </Screen>
  )
}

const PORTS = [587, 465, 25, 2525]

function EmailDelivery({
  app,
  auth,
  update,
  onSettings,
}: {
  app: AppDetail
  auth: AppAuth
  update: Update
  onSettings: () => void
}) {
  const emailOn = auth.methods.some((m) => m.provider === 'email')
  const [custom, setCustom] = useState(!!auth.smtp)
  const [form, setForm] = useState<AppSmtp>(
    auth.smtp ?? { senderEmail: '', senderName: app.name, host: '', port: 587, username: '' },
  )
  const [password, setPassword] = useState('')
  const set = (patch: Partial<AppSmtp>) => setForm((f) => ({ ...f, ...patch }))
  const complete = !!form.senderEmail && !!form.host && !!form.username && (!!auth.smtp || !!password)

  const toggle = (on: boolean) => {
    setCustom(on)
    if (!on && auth.smtp) void update({ smtp: null }, 'Codes are sent from noreply@boxlite.app')
  }

  return (
    <Screen title="Email delivery" actions={<GearButton onClick={onSettings} />}>
      <div className="flex flex-col gap-4">
        {!emailOn && (
          <div className="flex items-center justify-between gap-4 bg-card/50 px-4 py-3">
            <span className="text-muted-foreground">
              Email code sign-in is not added. These settings apply once it is.
            </span>
            <ToolButton
              onClick={() =>
                void update({ upsertMethod: { provider: 'email', keys: 'shared' } }, 'Email code sign-in added')
              }
            >
              Add email code
            </ToolButton>
          </div>
        )}
        <Panel>
          <SpecRow label="Sender">
            {auth.smtp ? `${auth.smtp.senderName} <${auth.smtp.senderEmail}>` : 'BoxLite <noreply@boxlite.app>'}
          </SpecRow>
          <div className="mt-4 flex items-center justify-between gap-4 border-t border-border/60 pt-4">
            <div>
              <div className="text-foreground">Use your own SMTP server</div>
              <div className="text-[12px] text-muted-foreground">
                Codes come from your domain instead of boxlite.app.
              </div>
            </div>
            <Switch checked={custom} onCheckedChange={toggle} />
          </div>
          {custom && (
            <div className="mt-4 grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-muted-foreground">Sender email</span>
                <Input
                  value={form.senderEmail}
                  onChange={(e) => set({ senderEmail: e.target.value })}
                  placeholder="noreply@acme.com"
                  className="font-mono"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-muted-foreground">Sender name</span>
                <Input
                  value={form.senderName}
                  onChange={(e) => set({ senderName: e.target.value })}
                  className="font-mono"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-muted-foreground">Host</span>
                <Input
                  value={form.host}
                  onChange={(e) => set({ host: e.target.value })}
                  placeholder="smtp.acme.com"
                  className="font-mono"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-muted-foreground">Port</span>
                <select
                  value={form.port}
                  onChange={(e) => set({ port: Number(e.target.value) })}
                  className={TEXT_INPUT}
                >
                  {PORTS.map((port) => (
                    <option key={port} value={port}>
                      {port}
                      {port === 587 ? ' · STARTTLS' : port === 465 ? ' · TLS' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-muted-foreground">Username</span>
                <Input
                  value={form.username}
                  onChange={(e) => set({ username: e.target.value })}
                  className="font-mono"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-muted-foreground">Password</span>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={auth.smtp ? '•••••••• saved' : ''}
                  className="font-mono"
                />
              </label>
              <div className="col-span-2 flex items-center justify-end gap-3">
                {!complete && <span className="text-[12px] text-muted-foreground">Fill in every field to save.</span>}
                <FlatButton
                  variant="primary"
                  disabled={!complete}
                  onClick={() => {
                    setPassword('')
                    void update({ smtp: form }, `Codes are sent from ${form.senderEmail}`)
                  }}
                >
                  Save SMTP
                </FlatButton>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </Screen>
  )
}

function Users({
  app,
  auth,
  onSettings,
  onOpenLogs,
}: {
  app: AppDetail
  auth: AppAuth
  onSettings: () => void
  onOpenLogs: () => void
}) {
  const [search, setSearch] = useState('')
  const users = auth.users.filter((u) => !search || u.email.includes(search.toLowerCase()))
  const { run, pending } = useAppAction(app.id)
  const exportCsv = () =>
    downloadCsv(
      `${app.name}-${app.environment}-users.csv`,
      ['email', 'provider', 'first_seen', 'last_seen', 'sessions', 'blocked'],
      auth.users.map((u) => [u.email, u.provider, u.firstSeen, u.lastSeen, u.sessions, u.blocked ? 'yes' : 'no']),
    )
  return (
    <Screen
      title={`Users of ${app.environment}`}
      actions={
        <>
          <ToolButton onClick={onOpenLogs}>Auth log</ToolButton>
          <ToolButton onClick={exportCsv} disabled={auth.users.length === 0}>
            Export CSV
          </ToolButton>
          <GearButton onClick={onSettings} />
        </>
      }
      padded={false}
    >
      <div className="flex items-center gap-2 pb-3">
        <SearchField value={search} onChange={setSearch} placeholder="Filter users…" />
      </div>
      {users.length === 0 ? (
        <EmptyNote title={auth.users.length === 0 ? 'Nobody has signed in yet' : 'No user matches'} />
      ) : (
        <>
          <GridHeader grid={USER_GRID} columns={['Email', 'Provider', 'First seen', 'Last seen', 'Sessions', '']} />
          {users.map((user) => (
            <GridRow key={user.email} grid={USER_GRID}>
              <span className="flex min-w-0 items-center gap-3">
                <span
                  className={cn('truncate', user.blocked ? 'text-muted-foreground line-through' : 'text-foreground')}
                >
                  {user.email}
                </span>
                {user.blocked && <Tag tone="bad">Blocked</Tag>}
              </span>
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                <ProviderLogo provider={user.provider as AuthMethod['provider']} size={13} />
                {user.provider}
              </span>
              <span className="text-muted-foreground">{relTime(user.firstSeen)}</span>
              <span className="text-muted-foreground">{relTime(user.lastSeen)}</span>
              <span className="text-muted-foreground">{user.sessions}</span>
              <HoverActions>
                {user.blocked && (
                  <ToolButton
                    onClick={() =>
                      void run(
                        { type: 'blockUser', email: user.email, blocked: false },
                        `${user.email} can sign in again`,
                      )
                    }
                  >
                    Unblock
                  </ToolButton>
                )}
                {user.sessions > 0 && (
                  <ToolButton
                    title="Sign this user out everywhere"
                    loading={pending === `out:${user.email}`}
                    onClick={() =>
                      void run({ type: 'signOutUser', email: user.email }, `${user.email} is signed out everywhere`, {
                        key: `out:${user.email}`,
                      })
                    }
                  >
                    Sign out
                  </ToolButton>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <MoreButton />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[12rem] font-mono">
                    <DropdownMenuItem
                      className="cursor-pointer text-destructive focus:text-destructive"
                      onClick={() =>
                        void run(
                          { type: 'blockUser', email: user.email, blocked: !user.blocked },
                          user.blocked
                            ? `${user.email} can sign in again`
                            : `${user.email} blocked${user.sessions ? ` · ${user.sessions} ${user.sessions === 1 ? 'session' : 'sessions'} ended` : ''}`,
                          { undo: { type: 'blockUser', email: user.email, blocked: !!user.blocked } },
                        )
                      }
                    >
                      {user.blocked ? 'Unblock' : 'Block and sign out'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </HoverActions>
            </GridRow>
          ))}
        </>
      )}
    </Screen>
  )
}

export function UsersTab({
  app,
  section,
  onSection,
  onOpenLogs,
}: {
  app: AppDetail
  section?: string
  onSection: (next: Section) => void
  onOpenLogs: () => void
}) {
  const auth = app.auth
  const mutation = useAppMutation()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 'login' is the old name of the methods screen.
  const asked = section === 'login' ? 'methods' : section
  // Default to users once someone has signed in; until then the methods are what matter.
  const fallback: Section = auth.users.length > 0 ? 'users' : 'methods'
  const current: Section = SECTION_IDS.includes(asked as Section) ? (asked as Section) : fallback

  const update: Update = async (input, success) => {
    try {
      await mutation.mutateAsync({ kind: 'auth', appId: app.id, input })
      toast.success(success)
    } catch (error) {
      handleApiError(error, 'Failed to update login')
    }
  }
  const openSettings = () => setSettingsOpen(true)

  return (
    <Workbench<Section>
      items={[
        { id: 'users', label: 'Users', count: auth.users.length },
        { id: 'methods', label: 'Sign-in methods', count: auth.methods.length },
        { id: 'email', label: 'Email delivery' },
      ]}
      value={current}
      onChange={onSection}
    >
      {current === 'methods' ? (
        <Methods
          app={app}
          auth={auth}
          update={update}
          onEdit={setEditing}
          onSettings={openSettings}
          onOpenEmail={() => onSection('email')}
        />
      ) : current === 'users' ? (
        <Users app={app} auth={auth} onSettings={openSettings} onOpenLogs={onOpenLogs} />
      ) : (
        <EmailDelivery app={app} auth={auth} update={update} onSettings={openSettings} />
      )}

      {editing?.kind === 'oauth' && (
        <OAuthDialog
          provider={editing.provider}
          existing={editing.existing}
          auth={auth}
          onClose={() => setEditing(null)}
          update={update}
        />
      )}
      {editing?.kind === 'custom' && (
        <CustomOidcDialog existing={editing.existing} auth={auth} onClose={() => setEditing(null)} update={update} />
      )}
      {settingsOpen && (
        <AuthSettingsDialog app={app} auth={auth} update={update} onClose={() => setSettingsOpen(false)} />
      )}
    </Workbench>
  )
}
