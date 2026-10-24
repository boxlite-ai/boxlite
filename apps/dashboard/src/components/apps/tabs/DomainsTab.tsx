/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ArrowUpRight } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { useDomains } from '@/hooks/mutations/useAppMutations'
import { capitalize, VISIBILITY_LABEL } from '@/lib/apps/format'
import { openApp } from '@/lib/apps/open'
import type { AppDetail, AppDomain } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { toast } from 'sonner'
import { useConfirm } from '../confirm'
import { CopyIconButton, DIALOG_FRAME, FlatButton, HoverActions, SectionTitle } from '../spec'
import { ToolButton } from '../SubNav'
import { Tag } from '../viz'

// Two kinds of domain, shown apart, as in the design. Every environment has its
// BoxLite address from the moment it exists: it always serves, so it has no
// status, only who may open it (changed from the header's Access menu). Your own
// domains are added here where the platform routes them: the owner gets the two
// DNS records to add, then verifies; elsewhere Add domain stays disabled and says why.

export function DomainsTab({ app }: { app: AppDetail }) {
  const host = app.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const open = () => void openApp(app.id, app.environment)
  return (
    <div className="flex flex-col gap-10">
      <section>
        <SectionTitle title="BoxLite domain" />
        <div className="flex min-h-[48px] items-center gap-3 border-b border-border/60 px-2 font-mono text-body">
          <span className="inline-flex min-w-0 items-center gap-2">
            {app.activeRelease ? (
              <button type="button" onClick={open} className="truncate font-semibold text-foreground hover:underline">
                {host}
              </button>
            ) : (
              <span className="truncate font-semibold text-foreground">{host}</span>
            )}
            <CopyIconButton text={app.url} title="Copy URL" />
            {app.activeRelease && (
              <button
                type="button"
                onClick={open}
                aria-label={`Open ${host}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <ArrowUpRight className="size-3" />
              </button>
            )}
          </span>
          <Tag>Primary</Tag>
          <span className="ml-auto text-[12px] text-muted-foreground" title="Change it from Access in the header">
            Access: <span className="text-foreground">{capitalize(VISIBILITY_LABEL[app.visibility])}</span>
          </span>
        </div>
      </section>

      <YourDomains app={app} />
    </div>
  )
}

/** The two records the owner adds at the DNS provider, each copyable. */
function Records({ domain }: { domain: AppDomain }) {
  return (
    <div className="flex flex-col gap-2">
      {domain.records.map((r) => (
        <div key={r.type} className="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 bg-card/60 px-3 py-2 text-[12px]">
          <span className="text-muted-foreground">{r.type}</span>
          <span className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 truncate text-foreground" title={r.name}>
              {r.name}
            </code>
            <CopyIconButton text={r.name} title={`Copy ${r.type} name`} />
          </span>
          <span className="text-muted-foreground">value</span>
          <span className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 truncate text-foreground" title={r.value}>
              {r.value}
            </code>
            <CopyIconButton text={r.value} title={`Copy ${r.type} value`} />
          </span>
        </div>
      ))}
    </div>
  )
}

function AddDomainDialog({ app, onClose }: { app: AppDetail; onClose: () => void }) {
  const { add, verify } = useDomains()
  const [host, setHost] = useState('')
  const [added, setAdded] = useState<AppDomain | null>(null)
  const submit = async () => {
    try {
      setAdded(await add.mutateAsync({ appId: app.id, host: host.trim() }))
    } catch (error) {
      handleApiError(error, 'Could not add the domain')
    }
  }
  const check = async () => {
    if (!added) return
    try {
      const r = await verify.mutateAsync({ appId: app.id, host: added.host })
      toast.success(`${r.host} is yours`, {
        description: r.cname_ok ? 'Visitors reach the app there now.' : 'Visitors reach the app there once the CNAME record is in place.',
      })
      onClose()
    } catch (error) {
      handleApiError(error, 'Not verified yet')
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[560px] font-mono text-body')} data-testid="add-domain-dialog">
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">Add your domain</DialogTitle>
        </DialogHeader>
        {added ? (
          <div className="flex flex-col gap-3">
            <p className="text-[12px] text-muted-foreground">
              Add these two records where {added.host}&apos;s DNS is managed. DNS changes can take a few minutes; then
              verify.
            </p>
            <Records domain={added} />
          </div>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted-foreground">Domain</span>
            <Input
              value={host}
              autoFocus
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && host.trim() && void submit()}
              placeholder="shop.example.com"
              className="font-mono"
            />
          </label>
        )}
        <DialogFooter className="gap-2">
          <FlatButton onClick={onClose}>{added ? 'Verify later' : 'Cancel'}</FlatButton>
          {added ? (
            <FlatButton variant="primary" disabled={verify.isPending} onClick={() => void check()}>
              Verify
            </FlatButton>
          ) : (
            <FlatButton variant="primary" disabled={!host.trim() || add.isPending} onClick={() => void submit()}>
              Add
            </FlatButton>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DomainRow({ app, domain }: { app: AppDetail; domain: AppDomain }) {
  const { verify, remove } = useDomains()
  const [confirm, confirmElement] = useConfirm()
  const [open, setOpen] = useState(domain.status !== 'active')
  const check = async () => {
    try {
      await verify.mutateAsync({ appId: app.id, host: domain.host })
      toast.success(`${domain.host} is yours`)
    } catch (error) {
      handleApiError(error, 'Not verified yet')
    }
  }
  const drop = async () => {
    const ok = await confirm({
      title: `Remove ${domain.host}?`,
      body: <>Visitors who open {domain.host} no longer reach the app. The BoxLite domain keeps working.</>,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    try {
      await remove.mutateAsync({ appId: app.id, host: domain.host })
      toast.success(`Removed ${domain.host}`)
    } catch (error) {
      handleApiError(error, `Could not remove ${domain.host}`)
    }
  }
  return (
    <div className="border-b border-border/60" data-testid={`domain-${domain.host}`}>
      <div className="group flex min-h-[48px] items-center gap-3 px-2 font-mono text-body">
        <button type="button" className="truncate font-semibold text-foreground hover:underline" onClick={() => setOpen((v) => !v)}>
          {domain.host}
        </button>
        <Tag tone={domain.status === 'active' ? 'good' : 'neutral'}>{domain.status === 'active' ? 'Active' : 'Waiting for DNS'}</Tag>
        <span className="ml-auto">
          <HoverActions>
            {domain.status !== 'active' && (
              <ToolButton primary loading={verify.isPending} onClick={() => void check()}>
                Verify
              </ToolButton>
            )}
            <ToolButton danger loading={remove.isPending} onClick={() => void drop()}>
              Remove
            </ToolButton>
          </HoverActions>
        </span>
      </div>
      {open && domain.status !== 'active' && (
        <div className="px-2 pb-3">
          <Records domain={domain} />
        </div>
      )}
      {confirmElement}
    </div>
  )
}

function YourDomains({ app }: { app: AppDetail }) {
  const [adding, setAdding] = useState(false)
  const supported = !!app.domains?.supported
  const list = app.domains?.list ?? []
  return (
    <section>
      <SectionTitle
        title="Your domains"
        right={
          <ToolButton
            primary={supported}
            disabled={!supported}
            title={supported ? undefined : 'Custom domains are not available on this preview platform yet'}
            onClick={() => setAdding(true)}
          >
            Add domain
          </ToolButton>
        }
      />
      {!supported ? (
        <p className="px-2 py-2 font-mono text-[13px] text-muted-foreground">
          Custom domains are not available on this preview platform yet. The app is always reachable at its BoxLite
          domain above.
        </p>
      ) : list.length ? (
        <div className="border-t border-border/60">
          {list.map((d) => (
            <DomainRow key={d.host} app={app} domain={d} />
          ))}
        </div>
      ) : (
        <p className="px-2 py-2 font-mono text-[13px] text-muted-foreground">
          Serve this environment at a domain you own, such as shop.example.com. You add two DNS records; the app stays
          reachable at its BoxLite domain too.
        </p>
      )}
      {adding && <AddDomainDialog app={app} onClose={() => setAdding(false)} />}
    </section>
  )
}
