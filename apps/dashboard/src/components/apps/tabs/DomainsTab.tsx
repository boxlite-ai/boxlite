/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ArrowUpRight } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { useDomains } from '@/hooks/mutations/useAppMutations'
import { capitalize, VISIBILITY_LABEL } from '@/lib/apps/format'
import { useOpenApp } from '@/lib/apps/open'
import type { AppDetail, AppDomain } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { RoutePath } from '@/enums/RoutePath'
import { toast } from 'sonner'
import { useConfirm } from '../confirm'
import { CopyIconButton, DIALOG_FRAME, FlatButton, HoverActions, SectionTitle } from '../spec'
import { ToolButton } from '../SubNav'
import { Tag } from '../viz'

// Each environment keeps its default URL; additional platform domains reuse organization ownership.

export function DomainsTab({ app }: { app: AppDetail }) {
  const openApp = useOpenApp()
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

function AddDomainDialog({ app, onClose }: { app: AppDetail; onClose: () => void }) {
  const { add } = useDomains()
  const [host, setHost] = useState('')
  const submit = async () => {
    try {
      const domain = await add.mutateAsync({ appId: app.id, host: host.trim() })
      toast.success(`${domain.host} now serves ${app.environment}`)
      onClose()
    } catch (error) {
      handleApiError(error, 'Could not bind the domain')
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[560px] font-mono text-body')} data-testid="add-domain-dialog">
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">
            Bind a platform domain
          </DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground">
          Enter a full platform domain already held by your organization. Request one in{' '}
          <Link className="underline" to={RoutePath.DOMAINS}>
            Domains
          </Link>{' '}
          first.
        </p>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted-foreground">Full hostname</span>
          <Input
            value={host}
            autoFocus
            onChange={(event) => setHost(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && host.trim() && void submit()}
            placeholder="my-app.apps.example"
            className="font-mono"
          />
        </label>
        <DialogFooter className="gap-2">
          <FlatButton onClick={onClose}>Cancel</FlatButton>
          <FlatButton
            requiresWrite
            variant="primary"
            disabled={!host.trim() || add.isPending}
            onClick={() => void submit()}
          >
            Bind domain
          </FlatButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DomainRow({ app, domain }: { app: AppDetail; domain: AppDomain }) {
  const { remove } = useDomains()
  const [confirm, confirmElement] = useConfirm()
  const drop = async () => {
    const accepted = await confirm({
      title: `Unbind ${domain.host}?`,
      body: <>This name stops serving the App and remains held by your organization. The default URL keeps working.</>,
      confirmLabel: 'Unbind',
      danger: true,
    })
    if (!accepted) return
    try {
      await remove.mutateAsync({ appId: app.id, host: domain.host })
      toast.success(`Unbound ${domain.host}`)
    } catch (error) {
      handleApiError(error, `Could not unbind ${domain.host}`)
    }
  }
  return (
    <div className="border-b border-border/60" data-testid={`domain-${domain.host}`}>
      <div className="group flex min-h-[48px] items-center gap-3 px-2 font-mono text-body">
        <span className="truncate font-semibold text-foreground">{domain.host}</span>
        <Tag tone="good">Active</Tag>
        <span className="ml-auto">
          <HoverActions>
            <ToolButton requiresWrite danger loading={remove.isPending} onClick={() => void drop()}>
              Unbind
            </ToolButton>
          </HoverActions>
        </span>
      </div>
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
        title="Additional platform domains"
        right={
          <ToolButton requiresWrite primary={supported} disabled={!supported} onClick={() => setAdding(true)}>
            Bind domain
          </ToolButton>
        }
      />
      <p className="px-2 py-2 font-mono text-[13px] text-muted-foreground">
        {supported ? (
          <>
            Bind a platform domain held by your organization. Request one in{' '}
            <Link className="underline" to={RoutePath.DOMAINS}>
              Domains
            </Link>
            . Bringing your own domain is not available.
          </>
        ) : (
          'Additional platform domains are unavailable on this deployment.'
        )}
      </p>
      {list.length > 0 && (
        <div className="border-t border-border/60">
          {list.map((domain) => (
            <DomainRow key={domain.host} app={app} domain={domain} />
          ))}
        </div>
      )}
      {adding && <AddDomainDialog app={app} onClose={() => setAdding(false)} />}
    </section>
  )
}
