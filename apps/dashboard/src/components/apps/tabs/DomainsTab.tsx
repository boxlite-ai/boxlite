/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ArrowUpRight } from '@/components/ui/icon'
import { capitalize, VISIBILITY_LABEL } from '@/lib/apps/format'
import { openApp } from '@/lib/apps/open'
import type { AppDetail } from '@/lib/apps/types'
import { CopyIconButton, SectionTitle } from '../spec'
import { ToolButton } from '../SubNav'
import { Tag } from '../viz'

// Two kinds of domain, shown apart, as in the design. Every environment has its
// BoxLite address from the moment it exists: it always serves, so it has no
// status, only who may open it (changed from the header's Access menu). Bringing
// your own domain is not offered by this platform yet: the section keeps the
// design's Add domain, disabled, and says why.

export function DomainsTab({ app }: { app: AppDetail }) {
  const host = app.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const open = () => void openApp(app.id, app.environment)
  return (
    <div className="flex flex-col gap-10">
      <section>
        <SectionTitle title="BoxLite domain" count={app.environment} />
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

      <section>
        <SectionTitle
          title="Your domains"
          right={
            <ToolButton disabled title="Custom domains are not available on this preview platform yet">
              Add domain
            </ToolButton>
          }
        />
        <p className="px-2 py-2 font-mono text-[13px] text-muted-foreground">
          Custom domains are not available on this preview platform yet. The app is always reachable at its BoxLite
          domain above.
        </p>
      </section>
    </div>
  )
}
