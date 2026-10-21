/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ArrowUpRight } from '@/components/ui/icon'
import { useAppMutation } from '@/hooks/mutations/useAppMutations'
import { relTime, STATUS } from '@/lib/apps/format'
import type { AppCustomDomain, AppDetail } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { toast } from 'sonner'
import { CopyIconButton, Disclosure, HoverActions, MoreButton, SectionTitle, StatusBadge, TEXT_INPUT } from '../spec'
import { useConfirm } from '../confirm'
import { ToolButton } from '../SubNav'
import { Tag } from '../viz'

// Two kinds of domain, shown apart. Every app has its BoxLite address from
// the moment it is created; it always serves, so it has no status, only a
// subdomain that can be changed. Bringing your own domain is optional; those
// rows carry the only state that matters (serving or waiting for DNS) and the
// DNS record to add. The first domain you bring becomes primary: the one Visit,
// Overview and the Apps list show. The BoxLite address keeps working.

interface DomainsInput {
  slug?: string
  addDomain?: string
  removeDomain?: string
  verifyDomain?: string
  makePrimary?: string | null
}
type Update = (input: DomainsInput, success: string) => Promise<void>

const APP_DOMAIN = 'boxlite.app'
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/

function serving(c: AppCustomDomain) {
  // A domain whose DNS checks out but whose certificate is not issued yet is still waiting, to the user.
  return c.status === 'verified' && c.tls === 'issued'
}

function DomainLink({ host }: { host: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <a href={`https://${host}`} target="_blank" rel="noreferrer" className="truncate font-semibold hover:underline">
        {host}
      </a>
      <CopyIconButton text={`https://${host}`} />
      <a
        href={`https://${host}`}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground hover:text-foreground"
        aria-label={`Open ${host}`}
      >
        <ArrowUpRight className="size-3" />
      </a>
    </span>
  )
}

function BoxLiteDomain({ app, update, busy }: { app: AppDetail; update: Update; busy: boolean }) {
  const d = app.domains
  const [slug, setSlug] = useState<string | null>(null)
  const isPrimary = d.primary === null
  return (
    <section>
      <SectionTitle title="BoxLite domain" count={app.environment} />
      {slug === null ? (
        <div className="group flex min-h-[48px] items-center gap-3 px-2 border-b border-border/60 transition-colors hover:bg-card/50">
          <DomainLink host={d.defaultDomain} />
          {isPrimary && <Tag>Primary</Tag>}
          <HoverActions className="ml-auto">
            {!isPrimary && (
              <ToolButton
                disabled={busy}
                onClick={() => update({ makePrimary: null }, `${d.defaultDomain} is now primary`)}
              >
                Make primary
              </ToolButton>
            )}
            <ToolButton onClick={() => setSlug(d.slug)}>Change subdomain</ToolButton>
          </HoverActions>
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-y border-border/60 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center">
              <input
                autoFocus
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                className={cn(TEXT_INPUT, 'w-[220px]')}
              />
              <span className="pl-2 text-muted-foreground">.{APP_DOMAIN}</span>
            </span>
            <span className="ml-auto flex gap-1">
              <ToolButton onClick={() => setSlug(null)}>Cancel</ToolButton>
              <ToolButton
                primary
                disabled={busy || !/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug === d.slug}
                onClick={() => {
                  const next = slug
                  setSlug(null)
                  void update({ slug: next }, `Now ${next}.${APP_DOMAIN}`)
                }}
              >
                Save
              </ToolButton>
            </span>
          </div>
          {/* The consequence shows while it can still be avoided, not as a standing footnote. */}
          <span className="text-[12px] text-warning">
            {d.defaultDomain} stops working as soon as you save; links, OAuth callbacks and webhooks pointing at it
            break.
          </span>
        </div>
      )}
    </section>
  )
}

function RecordField({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] uppercase tracking-[1px] text-muted-foreground">{label}</span>
      <span className="inline-flex min-w-0 items-center gap-2 text-foreground">
        <span className="truncate">{value}</span>
        <CopyIconButton text={value} title={`Copy ${label.toLowerCase()}`} />
      </span>
    </span>
  )
}

function CustomRow({
  c,
  primary,
  update,
  busy,
  onRemove,
}: {
  c: AppCustomDomain
  primary: boolean
  update: Update
  busy: boolean
  onRemove: (domain: string) => Promise<void>
}) {
  const ok = serving(c)
  const state = ok
    ? { label: 'Active', color: STATUS.running }
    : c.status === 'invalid'
      ? { label: 'Failed', color: STATUS.error }
      : { label: 'Waiting for DNS', color: STATUS.idle }
  return (
    <div className="border-b border-border/60">
      <div className="group grid min-h-[48px] grid-cols-[minmax(0,1fr)_170px_auto] items-center gap-4 px-3 transition-colors hover:bg-card/50">
        <span className="flex min-w-0 items-center gap-3">
          <DomainLink host={c.domain} />
          {primary && <Tag>Primary</Tag>}
        </span>
        <StatusBadge label={state.label} color={state.color} caps />
        <span className="flex items-center justify-end gap-1">
          {!ok && (
            <ToolButton disabled={busy} onClick={() => update({ verifyDomain: c.domain }, `Checked ${c.domain}`)}>
              Check now
            </ToolButton>
          )}
          <HoverActions>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <MoreButton />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[11rem] font-mono">
                {ok && !primary && (
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onClick={() => update({ makePrimary: c.domain }, `${c.domain} is now primary`)}
                  >
                    Make primary
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="cursor-pointer text-destructive focus:text-destructive"
                  onClick={() => void onRemove(c.domain)}
                >
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </HoverActions>
        </span>
      </div>
      {!ok && (
        <div className="flex flex-col gap-3 px-3 pb-4">
          <div className="grid grid-cols-[100px_minmax(0,1fr)_minmax(0,1.4fr)] gap-6 bg-card/50 px-4 py-3 font-mono text-[13px]">
            <RecordField label="Type" value="CNAME" />
            <RecordField label="Name" value={c.domain} />
            <RecordField label="Target" value={c.cname} />
          </div>
          {c.lastCheck && (
            <Disclosure label={`Last check${c.lastCheckedAt ? ` · ${relTime(c.lastCheckedAt)}` : ''}`}>
              <span className="pl-5 font-mono text-[12px] text-muted-foreground">{c.lastCheck}</span>
            </Disclosure>
          )}
        </div>
      )}
    </div>
  )
}

function YourDomains({ app, update, busy }: { app: AppDetail; update: Update; busy: boolean }) {
  const d = app.domains
  const [adding, setAdding] = useState<string | null>(null)
  const valid = adding !== null && DOMAIN_RE.test(adding) && !d.custom.some((c) => c.domain === adding)
  const [confirm, confirmElement] = useConfirm()
  const remove = async (domain: string) => {
    const ok = await confirm({
      title: `Remove ${domain}?`,
      body: (
        <>
          {domain} stops serving {app.name} right away
          {d.primary === domain ? `, and ${d.defaultDomain} becomes the primary domain` : ''}. Your DNS record is not
          changed.
        </>
      ),
      confirmLabel: 'Remove domain',
      danger: true,
    })
    if (ok) await update({ removeDomain: domain }, `${domain} removed`)
  }
  const add = () => {
    if (!valid || adding === null) return
    const domain = adding
    setAdding(null)
    void update({ addDomain: domain }, `${domain} added`)
  }
  return (
    <section>
      <SectionTitle
        title="Your domains"
        count={d.custom.length || undefined}
        right={adding === null ? <ToolButton onClick={() => setAdding('')}>Add domain</ToolButton> : undefined}
      />
      {adding !== null && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 py-3">
          <input
            autoFocus
            value={adding}
            onChange={(e) => setAdding(e.target.value.trim().toLowerCase())}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="app.acme.com"
            className={cn(TEXT_INPUT, 'w-[300px]')}
          />
          <span className="ml-auto flex gap-1">
            <ToolButton onClick={() => setAdding(null)}>Cancel</ToolButton>
            <ToolButton primary disabled={busy || !valid} onClick={add}>
              Add
            </ToolButton>
          </span>
        </div>
      )}
      <div className="border-t border-border/60">
        {d.custom.length === 0 && adding === null ? (
          <p className="py-4 font-mono text-[13px] text-muted-foreground">
            Bring your own domain and visitors see your brand.
          </p>
        ) : (
          d.custom.map((c) => (
            <CustomRow
              key={c.domain}
              c={c}
              primary={d.primary === c.domain}
              update={update}
              busy={busy}
              onRemove={remove}
            />
          ))
        )}
      </div>
      {confirmElement}
    </section>
  )
}

export function DomainsTab({ app }: { app: AppDetail }) {
  const mutation = useAppMutation()
  const update: Update = async (input, success) => {
    try {
      await mutation.mutateAsync({ kind: 'domains', appId: app.id, input })
      toast.success(success)
    } catch (error) {
      handleApiError(error, 'Failed to update domains')
    }
  }
  return (
    // Two sections, each with its own ▸ label; a screen title above them would only repeat the tab.
    <div className="flex flex-col gap-10 font-mono text-body">
      <BoxLiteDomain app={app} update={update} busy={mutation.isPending} />
      <YourDomains app={app} update={update} busy={mutation.isPending} />
    </div>
  )
}
