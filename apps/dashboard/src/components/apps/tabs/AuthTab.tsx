/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ArrowUpRight, Settings } from '@/components/ui/icon'
import { Spinner } from '@/components/ui/spinner'
import { useEndUserAction } from '@/hooks/mutations/useAppMutations'
import { useAppAuth } from '@/hooks/queries/useAppsQuery'
import { downloadUrl, errorText } from '@/lib/apps/client'
import { capitalize, relTime, VISIBILITY_GLYPH, VISIBILITY_LABEL } from '@/lib/apps/format'
import type { AppAuthStatus, AppDetail, AppEndUser, AppSignInMethod } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { OAuthClientDialog } from '../OAuthClientDialog'
import { ProviderLogo } from '../ProviderLogo'
import {
  copyText,
  DIALOG_FRAME,
  EmptyNote,
  FlatButton,
  GridHeader,
  GridRow,
  HoverActions,
  MoreButton,
  SearchField,
} from '../spec'
import { Screen, ToolButton, Workbench } from '../SubNav'
import { Tag } from '../viz'

// Sign-in of this environment, laid out as the approved mock: a rail of Users,
// Sign-in methods, one screen on the right. What the control
// plane runs is shown as it is: the methods are BoxLite's own OAuth apps, which
// the app's boxlite.toml turns on, so adding a method or changing settings is the
// agent's job and the console offers instructions for it rather than switches.

type Section = 'users' | 'methods'
const SECTIONS: Section[] = ['users', 'methods']

const USER_GRID = 'grid-cols-[1.8fr_0.8fr_1fr_1fr_0.6fr_120px] gap-x-3'
const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  microsoft: 'Microsoft',
  apple: 'Apple',
  x: 'X',
  facebook: 'Facebook',
}
const providerLabel = (provider: string) => PROVIDER_LABEL[provider] ?? capitalize(provider)

/** `/api/*` → `/api/…`: the pages behind sign-in, said without glob syntax. */
const pathWords = (glob: string) => glob.replace(/\/\*$/, '/…').replace(/\*/g, '…')

/** The methods that put people through: listed in this environment's sign-in and set up by BoxLite. */
const working = (status: AppAuthStatus) => status.methods.filter((m) => m.declared && m.status === 'ready')

/** What the agent needs to turn sign-in on, with the snippet; copied, never shown as page copy. */
function turnOnPrompt(app: AppDetail, status: AppAuthStatus): string {
  const ready = status.methods.filter((m) => m.status === 'ready').map((m) => `"${m.provider}"`)
  return [
    `Turn on sign-in for the BoxLite app "${app.name}" (environment ${app.environment}).`,
    'Add this to boxlite.toml:',
    '',
    '[auth]',
    `providers = [${ready.length ? ready.join(', ') : '"github"'}]`,
    'protect = ["/*"]',
    '',
    'Narrow protect to the paths that need a signed-in user (or leave it empty if the app sends people to /.boxlite/auth/login itself), then run `boxlite-app deploy` and give me the sign-in page URL.',
  ].join('\n')
}

/** Adding a method BoxLite already runs: one line in [auth] and a deploy. */
const addMethodPrompt = (app: AppDetail, status: AppAuthStatus, provider: string) =>
  [
    `Add ${providerLabel(provider)} sign-in to the BoxLite app "${app.name}" (environment ${app.environment}).`,
    `In boxlite.toml set [auth] providers = [${[...status.providers, provider].map((p) => `"${p}"`).join(', ')}], then run \`boxlite-app deploy\`.`,
  ].join('\n')

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

const LINK_BUTTON =
  'inline-flex h-[28px] items-center gap-1.5 whitespace-nowrap border border-border px-[10px] font-mono text-[12px] text-muted-foreground outline-none transition-colors hover:border-brand hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/35'

function UserActions({ app, user }: { app: AppDetail; user: AppEndUser }) {
  const action = useEndUserAction()
  const [busy, setBusy] = useState<string | null>(null)
  const who = user.email ?? user.name ?? user.id
  const run = async (op: 'sign-out' | 'block' | 'unblock', success: string, undo?: 'block' | 'unblock') => {
    setBusy(op)
    try {
      await action.mutateAsync({ appId: app.id, userId: user.id, op })
      toast.success(success, undo && { action: { label: 'Undo', onClick: () => void run(undo, `${who} restored`) } })
    } catch (error) {
      handleApiError(error, 'That did not work')
    } finally {
      setBusy(null)
    }
  }
  const sessions = `${user.sessions} ${user.sessions === 1 ? 'session' : 'sessions'}`
  return (
    <HoverActions>
      {user.blocked ? (
        <ToolButton loading={busy === 'unblock'} onClick={() => void run('unblock', `${who} can sign in again`)}>
          Unblock
        </ToolButton>
      ) : (
        user.sessions > 0 && (
          <ToolButton
            title="Sign this user out everywhere"
            loading={busy === 'sign-out'}
            onClick={() => void run('sign-out', `${who} is signed out everywhere`)}
          >
            Sign out
          </ToolButton>
        )
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <MoreButton />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[12rem] font-mono">
          {user.blocked ? (
            <DropdownMenuItem
              className="cursor-pointer"
              onClick={() => void run('unblock', `${who} can sign in again`, 'block')}
            >
              Unblock
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              className="cursor-pointer text-destructive focus:text-destructive"
              onClick={() =>
                void run('block', `${who} blocked${user.sessions ? ` · ${sessions} ended` : ''}`, 'unblock')
              }
            >
              Block and sign out
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </HoverActions>
  )
}

function Users({
  app,
  users,
  loading,
  error,
  onSettings,
  onOpenLog,
}: {
  app: AppDetail
  users: AppEndUser[]
  loading: boolean
  error: unknown
  onSettings: () => void
  onOpenLog: () => void
}) {
  const [search, setSearch] = useState('')
  const needle = search.toLowerCase()
  const shown = users.filter((u) => !needle || `${u.email ?? ''} ${u.name ?? ''}`.toLowerCase().includes(needle))
  return (
    <Screen
      title="Users"
      actions={
        <>
          <ToolButton onClick={onOpenLog} title="Sign-ins, sign-outs and refusals in Logs">
            Auth log
          </ToolButton>
          {users.length > 0 ? (
            <a
              href={downloadUrl(
                `/apps/${encodeURIComponent(app.id)}/users.csv?env=${encodeURIComponent(app.environment)}`,
              )}
              download
              className={LINK_BUTTON}
            >
              Export CSV
            </a>
          ) : (
            <ToolButton disabled>Export CSV</ToolButton>
          )}
          <GearButton onClick={onSettings} />
        </>
      }
      padded={false}
    >
      <div className="flex items-center gap-2 pb-3">
        <SearchField value={search} onChange={setSearch} placeholder="Filter users…" />
      </div>
      {error ? (
        <EmptyNote title="Users could not be read">{errorText(error)}</EmptyNote>
      ) : loading ? (
        <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
          <Spinner className="size-4" /> Loading users…
        </div>
      ) : shown.length === 0 ? (
        <EmptyNote title={users.length === 0 ? 'Nobody has signed in yet' : 'No user matches'} />
      ) : (
        <>
          <GridHeader grid={USER_GRID} columns={['Email', 'Provider', 'First seen', 'Last seen', 'Sessions', '']} />
          {shown.map((user) => (
            <GridRow key={user.id} grid={USER_GRID}>
              <span className="flex min-w-0 items-center gap-3">
                <span
                  className={cn('truncate', user.blocked ? 'text-muted-foreground line-through' : 'text-foreground')}
                  title={user.name ?? undefined}
                >
                  {user.email ?? user.name ?? user.id}
                </span>
                {user.blocked && <Tag tone="bad">Blocked</Tag>}
              </span>
              <span className="inline-flex items-center gap-2 text-muted-foreground">
                <ProviderLogo provider={user.provider} size={13} />
                {user.provider}
              </span>
              <span className="text-muted-foreground">{user.firstSeen ? relTime(user.firstSeen) : '—'}</span>
              <span className="text-muted-foreground">{user.lastSeen ? relTime(user.lastSeen) : '—'}</span>
              <span className="tabular-nums text-muted-foreground">{user.sessions}</span>
              <UserActions app={app} user={user} />
            </GridRow>
          ))}
        </>
      )}
    </Screen>
  )
}

function MethodMenu({ items, onEdit }: { items: { label: string; text: string; done: string }[]; onEdit: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <MoreButton />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[14rem] font-mono">
        <DropdownMenuItem className="cursor-pointer" onClick={onEdit}>
          Edit OAuth app…
        </DropdownMenuItem>
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            className="cursor-pointer"
            onClick={() => {
              copyText(item.text)
              toast.success(item.done)
            }}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MethodRow({
  app,
  status,
  method,
  onEdit,
}: {
  app: AppDetail
  status: AppAuthStatus
  method: AppSignInMethod
  onEdit: () => void
}) {
  const label = providerLabel(method.provider)
  const copyUri = { label: 'Copy redirect URI', text: method.redirectUri, done: `${label} redirect URI copied` }
  const ready = method.status === 'ready'
  // Clicking a method opens its OAuth app: BoxLite-managed keys or the app's own.
  const rowProps = {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onEdit,
    onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && e.target === e.currentTarget && onEdit(),
    'data-testid': `method-${method.provider}`,
  }
  const stop = {
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
  }
  if (!ready) {
    return (
      <div
        {...rowProps}
        className="flex min-h-[48px] cursor-pointer items-center gap-4 border-b border-border/60 px-2 text-muted-foreground outline-none transition-colors hover:bg-card/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/35"
      >
        <span className="flex w-5 justify-center opacity-60">
          <ProviderLogo provider={method.provider} />
        </span>
        <span>{label}</span>
        <span className="truncate text-[12px]">Needs your own {label} OAuth app.</span>
        <span className="ml-auto flex shrink-0 items-center gap-3" {...stop}>
          <ToolButton onClick={onEdit}>Set up</ToolButton>
          <MethodMenu items={[copyUri]} onEdit={onEdit} />
        </span>
      </div>
    )
  }
  const keys = method.keys === 'own' ? 'Your OAuth app' : 'BoxLite-managed'
  return (
    <div
      {...rowProps}
      className="flex min-h-[56px] cursor-pointer items-center gap-4 border-b border-border/60 px-2 outline-none transition-colors hover:bg-card/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/35"
    >
      <span className="flex w-5 justify-center text-foreground">
        <ProviderLogo provider={method.provider} />
      </span>
      <span className={cn('font-semibold', method.declared ? 'text-foreground' : 'text-muted-foreground')}>
        {label}
      </span>
      {!method.declared && (
        <span className="truncate text-[12px] text-muted-foreground">
          Ready, but not on this app&apos;s sign-in page
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-3" {...stop}>
        <Tag tone={method.declared ? 'good' : 'neutral'}>{keys} · ready</Tag>
        <MethodMenu
          onEdit={onEdit}
          items={
            method.declared
              ? [copyUri]
              : [
                  {
                    label: 'Copy instructions for your agent',
                    text: addMethodPrompt(app, status, method.provider),
                    done: 'Instructions copied. Paste them to your agent.',
                  },
                  copyUri,
                ]
          }
        />
      </span>
    </div>
  )
}

function SignInOff({ app, status }: { app: AppDetail; status: AppAuthStatus }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center font-mono">
      <div className="font-display text-em font-semibold text-foreground">Sign-in is off.</div>
      <div className="max-w-[460px] text-meta text-muted-foreground">
        Anyone who can open the app uses it without an account. Your agent turns sign-in on with GitHub
        {status.methods.some((m) => m.provider === 'google' && m.status === 'ready') ? ' or Google' : ''}.
      </div>
      <FlatButton
        variant="primary"
        className="mt-2"
        onClick={() => {
          copyText(turnOnPrompt(app, status))
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        }}
      >
        {copied ? 'Copied' : 'Copy instructions for your agent'}
      </FlatButton>
    </div>
  )
}

function Methods({ app, status, onSettings }: { app: AppDetail; status: AppAuthStatus; onSettings: () => void }) {
  const [editing, setEditing] = useState<AppSignInMethod | null>(null)
  // Working methods first, then ones BoxLite runs that this app does not use, then the unconfigured ones.
  const rank = (m: AppSignInMethod) => (m.status !== 'ready' ? 2 : m.declared ? 0 : 1)
  const methods = [...status.methods].sort((a, b) => rank(a) - rank(b))
  return (
    <Screen
      title="Sign-in methods"
      actions={
        <>
          {status.enforced && (
            <a href={status.loginUrl} target="_blank" rel="noreferrer" className={LINK_BUTTON}>
              Test login <ArrowUpRight className="size-3.5" />
            </a>
          )}
          <GearButton onClick={onSettings} />
        </>
      }
    >
      {/* Off: say so first; the methods below can still be prepared before turning sign-in on. */}
      {!status.declared && <SignInOff app={app} status={status} />}
      <div className="border-t border-border/60">
        {methods.map((method) => (
          <MethodRow
            key={method.provider}
            app={app}
            status={status}
            method={method}
            onEdit={() => setEditing(method)}
          />
        ))}
      </div>
      {editing && <OAuthClientDialog app={app} method={editing} onClose={() => setEditing(null)} />}
    </Screen>
  )
}

function SettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-6 border-b border-border/60 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-foreground">{label}</div>
        {hint && <div className="text-[12px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex items-center gap-2 text-right">{children}</div>
    </div>
  )
}

/** What applies to every method. Only what the control plane runs; it is all read-only here. */
function AuthSettingsDialog({ app, status, onClose }: { app: AppDetail; status: AppAuthStatus; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={cn(DIALOG_FRAME, 'max-w-[600px] font-mono text-body')}
      >
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">Auth settings</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col pb-5">
          <SettingRow label="Who can open the app" hint="Set from the access menu in the app header.">
            <span>
              {VISIBILITY_GLYPH[app.visibility]} {VISIBILITY_LABEL[app.visibility]}
            </span>
          </SettingRow>
          <SettingRow
            label="Where visitors must sign in"
            hint={
              status.protect.length
                ? 'Visitors must sign in to open these; the rest of the app stays open.'
                : 'No page requires it; the app sends people to the sign-in page itself.'
            }
          >
            <span className="max-w-[220px] truncate">
              {status.protect.length ? status.protect.map(pathWords).join(', ') : 'Nowhere'}
            </span>
          </SettingRow>
          <SettingRow label="Session length" hint="Each visit extends it, up to 30 days in all.">
            <span>7 days after the last visit</span>
          </SettingRow>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function AuthTab({ app }: { app: AppDetail }) {
  const { data, isLoading, error } = useAppAuth(app.id)
  const [searchParams, setSearchParams] = useSearchParams()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const status = data?.status ?? app.auth
  const users = data?.users ?? []
  const off = !status.declared
  const userCount = data ? users.length : status.users

  // Default to users once someone has signed in; until then the methods are what matter.
  const asked = searchParams.get('section') as Section | null
  const fallback: Section = userCount > 0 ? 'users' : 'methods'
  const askedOk = asked && SECTIONS.includes(asked) && !(off && asked !== 'methods' && userCount === 0)
  const current: Section = askedOk ? asked : fallback

  const go = (params: Record<string, string>) => {
    const next = new URLSearchParams(searchParams)
    next.delete('section')
    next.delete('source')
    for (const [key, value] of Object.entries(params)) next.set(key, value)
    setSearchParams(next)
  }
  const openSettings = () => setSettingsOpen(true)

  return (
    <Workbench<Section>
      items={[
        { id: 'users', label: 'Users', count: userCount, disabled: off && userCount === 0 },
        { id: 'methods', label: 'Sign-in methods', count: off ? 'off' : working(status).length },
      ]}
      value={current}
      onChange={(section) => go({ tab: 'auth', section })}
    >
      {current === 'users' ? (
        <Users
          app={app}
          users={users}
          loading={isLoading}
          error={error}
          onSettings={openSettings}
          onOpenLog={() => go({ tab: 'logs', section: 'runtime', source: 'auth' })}
        />
      ) : (
        <Methods app={app} status={status} onSettings={openSettings} />
      )}
      {settingsOpen && <AuthSettingsDialog app={app} status={status} onClose={() => setSettingsOpen(false)} />}
    </Workbench>
  )
}
