/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Copy } from '@/components/ui/icon'
import { freshPrompt } from '@/lib/apps/handoff'
import type { AppDetail } from '@/lib/apps/types'
import { useState } from 'react'
import { toast } from 'sonner'
import { AgentLogos } from './AgentLogos'
import { useRotateKeyFlow } from './HandoffToAgent'
import { copyText, PromptBlock, SectionTitle } from './spec'
import { ToolButton } from './SubNav'

// The console never asks a person to do the agent's work. This panel hands the app to an
// agent: on a new machine or in a new session, Copy instructions gives a prompt with a working
// App key. While this tab holds the key it was just given, that prompt is copied; otherwise a new
// key is issued next to the ones in use and its prompt is shown once. Rotate key retires them all.
export function AgentHandoffPanel({ app }: { app: AppDetail }) {
  const [open, setOpen] = useState(true)
  const flow = useRotateKeyFlow(app)
  const scope = `${app.name} · ${app.environment}`
  const fresh = freshPrompt(app.id)
  const copy = () => {
    if (!fresh) return void flow.issue()
    copyText(fresh)
    toast.success(`Copied instructions for ${scope}`, { description: 'Paste them into your coding agent.' })
  }
  return (
    <section className="flex flex-col">
      <SectionTitle
        title="Hand off to your agent"
        count={scope}
        right={
          <>
            <AgentLogos className="mr-3 hidden sm:inline-flex" />
            <ToolButton onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'}</ToolButton>
            <ToolButton primary loading={flow.issuing} onClick={copy}>
              <Copy className="size-3.5" /> Copy instructions
            </ToolButton>
          </>
        }
      />
      {open && (
        <div className="flex flex-col gap-2">
          <PromptBlock text={fresh ?? app.handoffPrompt} compact />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-meta text-muted-foreground">
            <span>
              {fresh
                ? 'The App key in it is shown only in this tab.'
                : 'The App key is masked here. Copy instructions issues a new one for the agent; agents already set up keep theirs.'}
            </span>
            <ToolButton loading={flow.pending} onClick={() => void flow.start()}>
              Rotate key
            </ToolButton>
          </div>
        </div>
      )}
      {flow.element}
    </section>
  )
}
