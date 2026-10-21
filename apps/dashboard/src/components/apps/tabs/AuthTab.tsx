/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Spinner } from '@/components/ui/spinner'
import { useEndUserAction } from '@/hooks/mutations/useAppMutations'
import { useAppAuth } from '@/hooks/queries/useAppsQuery'
import { downloadUrl } from '@/lib/apps/client'
import { capitalize, relTime, STATUS } from '@/lib/apps/format'
import type { AppDetail, AppEndUser } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { useState } from 'react'
import { toast } from 'sonner'
import { useConfirm } from '../confirm'
import {
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
const METHOD_GRID = 'grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)_80px] gap-x-4'

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
  const { data, isLoading } = useAppAuth(app.id)
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
                  text={`Add sign-in to the BoxLite app "${app.name}": declare [auth] with providers = ["google", "github"] and the paths to protect in boxlite.toml, then deploy.`}
                  compact
                />
              </div>
            }
          >
            Until then, access ({app.visibility}) is the only gate in front of the app.
          </EmptyNote>
        )}
      </Screen>

      <Screen title="Sign-in methods" padded={false}>
        <GridHeader grid={METHOD_GRID} columns={['Method', 'Keys', 'In this environment', '']} />
        {status.methods.map((method) => (
          <GridRow key={method.provider} grid={METHOD_GRID}>
            <span className="text-foreground">{PROVIDER_LABEL[method.provider] ?? capitalize(method.provider)}</span>
            <StatusBadge
              label={method.status === 'ready' ? 'BoxLite-managed · ready' : 'Not configured'}
              color={method.status === 'ready' ? STATUS.running : STATUS.dim}
            />
            <span className="text-muted-foreground">{method.declared ? 'Listed in [auth]' : 'Not in [auth]'}</span>
            <span />
          </GridRow>
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
        {isLoading ? (
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
    </div>
  )
}
