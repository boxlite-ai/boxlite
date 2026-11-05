/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RoutePath } from '@/enums/RoutePath'
import type { AppDetail } from '@/lib/apps/types'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AgentLogos } from './AgentLogos'
import { PromptBlock, SectionTitle } from './spec'
import { ToolButton } from './SubNav'

export function AgentHandoffPanel({ app }: { app: AppDetail }) {
  const [open, setOpen] = useState(true)
  const draft = app.status === 'draft'
  return (
    <section className="flex flex-col">
      <SectionTitle
        title={draft ? 'Start building with your agent' : 'Keep building with your agent'}
        count={`${app.name} · ${app.environment}`}
        right={
          <>
            <AgentLogos className="mr-3 hidden sm:inline-flex" />
            {!draft && <ToolButton onClick={() => setOpen((visible) => !visible)}>{open ? 'Hide' : 'Show'}</ToolButton>}
          </>
        }
      />
      {(draft || open) && (
        <div className="flex flex-col gap-2">
          <p className="font-mono text-meta text-muted-foreground">
            Copy the instructions into your coding agent, then tell it what to {draft ? 'build' : 'change'}.
          </p>
          <PromptBlock text={app.handoffPrompt} compact={!draft} />
          <p className="font-mono text-meta text-muted-foreground">
            Use an organization key from{' '}
            <Link to={RoutePath.KEYS} className="underline">
              API Keys
            </Link>{' '}
            to sign in to the CLI. Its permissions apply across the organization.
          </p>
        </div>
      )}
    </section>
  )
}
