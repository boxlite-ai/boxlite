/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Spinner } from '@/components/ui/spinner'
import { useEndUserAction } from '@/hooks/mutations/useAppMutations'
import { useAppAuth } from '@/hooks/queries/useAppsQuery'
import { downloadUrl } from '@/lib/apps/client'
import { capitalize, relTime, STATUS } from '@/lib/apps/format'
import { errorText } from '@/lib/apps/client'
import type { AppDetail, AppEndUser, AppSignInMethod } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { useState } from 'react'
import { toast } from 'sonner'
import { useConfirm } from '../confirm'
import { cn } from '@/lib/utils'
import {
  CopyIconButton,
  EmptyNote,
  GridHeader,
  GridRow,
  HoverActions,
  Panel,
  PromptBlock,
  SearchField,
  SpecRow,
  StatusBadge,
} from '../spec'
import { Screen, ToolButton } from '../SubNav'
import { Tag } from '../viz'

// Sign-in of this environment: what boxlite.toml declares in [auth], which
// sign-in methods the control plane can run (BoxLite's own OAuth apps), and the
// people who have signed in. Bringing your own OAuth app and adding providers
// come later, so they are not offered here.

const GRID = 'grid-cols-[minmax(0,1.4fr)_110px_140px_90px_200px] gap-x-4'
const PROVIDER_LABEL: Record<string, string> = { github: 'GitHub', google: 'Google' }
const METHOD_GRID = 'grid-cols-[120px_200px_140px_minmax(0,1fr)] gap-x-4'
const EVENT_GRID = 'grid-cols-[150px_minmax(0,1fr)] gap-x-4'

/** Why a method is or is not usable, in the console's words. */
function methodNote(method: AppSignInMethod): string {
  if (method.status === 'ready') return 'BoxLite runs the OAuth app; nothing to set up.'
  return `BoxLite has not registered a ${PROVIDER_LABEL[method.provider] ?? method.provider} OAuth app on this control plane yet, so its button is hidden and only ready methods are offered.`
}

function UserRow({ app, user }: { app: AppDetail; user: AppEndUser }) {
  const action = useEndUserAction()
  const [confirm, confirmElement] = useConfirm()
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (op: 'sign-out' | 'block' | 'unblock') => {
    if (op === 'block') {
      const ok = await confirm({
        title: `Block ${user.email ?? user.id} in ${app.environment}?`,
        body: <>Their sessions end now and they cannot sign in again until unblocked.</>,
        confirmLabel: 'Block',
        danger: true,
      })
      if (!ok) return
    }
    setBusy(op)
    try {
      await action.mutateAsync({ appId: app.id, userId: user.id, op })
      toast.success(op === 'sign-out' ? 'Signed out' : op === 'block' ? 'Blocked' : 'Unblocked')
    } catch (error) {
      handleApiError(error, 'That did not work')
    } finally {
      setBusy(null)
    }
  }
  return (
    <GridRow grid={GRID}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-foreground">{user.email ?? user.name ?? user.id}</span>
        {user.blocked && <Tag tone="bad">Blocked</Tag>}
      </span>
      <span className="text-muted-foreground">{user.provider}</span>
      <span className="text-muted-foreground">{user.lastSeen ? relTime(user.lastSeen) : '—'}</span>
      <span className="tabular-nums text-muted-foreground">{user.sessions}</span>
      <HoverActions>
        <ToolButton loading={busy === 'sign-out'} onClick={() => void run('sign-out')}>
          Sign out
        </ToolButton>
        <ToolButton
          danger={!user.blocked}
          loading={busy === 'block' || busy === 'unblock'}
          onClick={() => void run(user.blocked ? 'unblock' : 'block')}
        >
          {user.blocked ? 'Unblock' : 'Block'}
        </ToolButton>
      </HoverActions>
      {confirmElement}
    </GridRow>
  )
}

export function AuthTab({ app }: { app: AppDetail }) {
  const { data, isLoading, error } = useAppAuth(app.id)
  const [search, setSearch] = useState('')
  const status = data?.status ?? app.auth
  const users = (data?.users ?? []).filter(
    (u) => !search || `${u.email ?? ''} ${u.name ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <div className="flex flex-col gap-10">
      <Screen title={`Sign-in in ${app.environment}`}>
        {status.declared ? (
          <Panel>
            <div className="mb-4">
              <StatusBadge
                label={status.enforced ? 'Signing visitors in' : 'Declared, no ready provider'}
                color={status.enforced ? STATUS.running : STATUS.idle}
              />
            </div>
            <SpecRow label="Providers">{status.providers.join(', ') || '—'}</SpecRow>
            <SpecRow label="Protected paths">{status.protect.join(', ') || 'none'}</SpecRow>
            <SpecRow label="Sign-in page">{status.loginUrl}</SpecRow>
            {status.note && <SpecRow label="Note">{status.note}</SpecRow>}
          </Panel>
        ) : (
          <EmptyNote
            title="No sign-in declared"
            action={
              <div className="w-full max-w-[640px] text-left">
                <PromptBlock
                  text={'[auth]\nproviders = ["github"]\nprotect = ["/app/*"]\n\n# then: boxlite-app deploy'}
                  compact
                />
              </div>
            }
          >
            Your agent adds this to boxlite.toml. Until then, access ({app.visibility}) is the only gate in front of the
            app.
          </EmptyNote>
        )}
      </Screen>

      <Screen title="Sign-in methods" padded={false}>
        <GridHeader grid={METHOD_GRID} columns={['Method', 'Status', 'In this environment', 'Redirect URI']} />
        {status.methods.map((method) => (
          <div key={method.provider} className="border-b border-border/60" data-testid={`method-${method.provider}`}>
            <div className={`grid ${METHOD_GRID} min-h-[48px] items-center px-2 py-2 font-mono text-body`}>
              <span className="text-foreground">{PROVIDER_LABEL[method.provider] ?? capitalize(method.provider)}</span>
              <StatusBadge
                label={method.status === 'ready' ? 'BoxLite-managed · ready' : 'Not configured'}
                color={method.status === 'ready' ? STATUS.running : STATUS.dim}
              />
              <span className="text-muted-foreground">{method.declared ? 'Listed in [auth]' : 'Not in [auth]'}</span>
              <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <span className="truncate" title={method.redirectUri}>
                  {method.redirectUri}
                </span>
                <CopyIconButton text={method.redirectUri} title="Copy redirect URI" />
              </span>
            </div>
            <div className="px-2 pb-2 text-[12px] text-muted-foreground">{methodNote(method)}</div>
          </div>
        ))}
      </Screen>

      <Screen
        title="Users"
        actions={
          (data?.users.length ?? 0) > 0 ? (
            <a
              href={downloadUrl(
                `/apps/${encodeURIComponent(app.id)}/users.csv?env=${encodeURIComponent(app.environment)}`,
              )}
              download
              className="inline-flex h-[28px] items-center border border-border px-[10px] font-mono text-[12px] text-muted-foreground transition-colors hover:border-brand hover:text-foreground"
            >
              Export CSV
            </a>
          ) : undefined
        }
        padded={false}
      >
        <div className="pb-3">
          <SearchField value={search} onChange={setSearch} placeholder="Filter users…" />
        </div>
        {error ? (
          <EmptyNote title="Users could not be read">{errorText(error)}</EmptyNote>
        ) : isLoading ? (
          <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
            <Spinner className="size-4" /> Loading users…
          </div>
        ) : users.length === 0 ? (
          <EmptyNote title={data?.users.length ? 'No user matches' : 'Nobody has signed in yet'} />
        ) : (
          <>
            <GridHeader grid={GRID} columns={['User', 'Provider', 'Last seen', 'Sessions', '']} />
            {users.map((user) => (
              <UserRow key={user.id} app={app} user={user} />
            ))}
          </>
        )}
      </Screen>

      <Screen title="Recent sign-ins" padded={false}>
        {(data?.events.length ?? 0) === 0 ? (
          <EmptyNote title="No sign-in events yet">
            Sign-ins, sign-outs and refusals are written to the auth log source and listed here.
          </EmptyNote>
        ) : (
          <>
            <GridHeader grid={EVENT_GRID} columns={['When', 'Event']} />
            {(data?.events ?? []).map((event) => (
              <GridRow key={event.id} grid={EVENT_GRID} className="min-h-[40px]">
                <span className="text-muted-foreground" title={event.ts}>
                  {new Date(event.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' })}
                </span>
                <span
                  className={cn(
                    'truncate',
                    event.level === 'error'
                      ? 'text-destructive'
                      : event.level === 'warn'
                        ? 'text-warning'
                        : 'text-foreground',
                  )}
                >
                  {event.line}
                </span>
              </GridRow>
            ))}
          </>
        )}
      </Screen>
    </div>
  )
}
