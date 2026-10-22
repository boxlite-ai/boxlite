/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Copy } from '@/components/ui/icon'
import { freshPrompt } from '@/lib/apps/handoff'
import type { AppDetail } from '@/lib/apps/types'
import { useState } from 'react'
import { toast } from 'sonner'
import { useRotateKeyFlow } from './HandoffToAgent'
import { copyText, PromptBlock, SectionTitle } from './spec'
import { ToolButton } from './SubNav'

// The console never asks a person to do the agent's work. One compact row
// hands the app to the agent: which app and environment, and the control
// plane's instructions on demand. The App key inside them is shown in full
// only once (at creation or rotation); after that it is masked, and Rotate key,
// next to the instructions, issues a new one.
export function AgentHandoffPanel({ app }: { app: AppDetail }) {
  const [open, setOpen] = useState(false)
  const flow = useRotateKeyFlow(app)
  const scope = `${app.name} · ${app.environment}`
  const fresh = freshPrompt(app.id)
  return (
    <section className="flex flex-col">
      <SectionTitle
        title="Hand off to your agent"
        count={scope}
        right={
          <>
            <ToolButton onClick={() => setOpen((v) => !v)}>
              {open ? 'Hide instructions' : 'View instructions'}
            </ToolButton>
            <ToolButton
              onClick={() => {
                copyText(fresh ?? app.handoffPrompt)
                toast.success(`Copied instructions for ${scope}`, {
                  description: fresh ? undefined : 'Its App key is masked; an agent already set up keeps using its own.',
                })
              }}
            >
              <Copy className="size-3.5" /> Copy instructions
            </ToolButton>
          </>
        }
      />
      {open && (
        <div className="flex flex-col gap-2">
          <PromptBlock text={app.handoffPrompt} compact />
          <div className="flex items-center gap-3 font-mono text-meta text-muted-foreground">
            <span>
              The App key{app.key ? ` (…${app.key.last4})` : ''} is shown only once. Lost it? A new key replaces it.
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
