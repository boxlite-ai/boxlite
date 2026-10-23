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
import { HandoffSteps, useRotateKeyFlow } from './HandoffToAgent'
import { copyText, PromptBlock, SectionTitle } from './spec'
import { ToolButton } from './SubNav'

// The console never asks a person to do the agent's work. This panel hands the app to an
// agent: on a new machine or in a new session, Copy prompt gives a prompt with a working
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
        title="Keep building with your agent"
        count={scope}
        right={
          <>
            <AgentLogos className="mr-3 hidden sm:inline-flex" />
            <ToolButton onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'}</ToolButton>
            <ToolButton primary loading={flow.issuing} onClick={copy}>
              <Copy className="size-3.5" /> Copy prompt
            </ToolButton>
          </>
        }
      />
      {open && (
        <div className="flex flex-col gap-2">
          <HandoffSteps last="Tell it what to change. It deploys the new version." />
          {/* The key stays masked on screen; Copy hands over a working one, like Copy prompt. */}
          <PromptBlock text={app.handoffPrompt} compact onCopy={copy} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-meta text-muted-foreground">
            <span>
              {fresh
                ? 'The App key is masked here; Copy prompt hands over the working one this tab was given.'
                : 'The App key is masked here. Each Copy prompt issues one more key (up to 10) and agents already set up keep theirs; Rotate key retires them all.'}
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
