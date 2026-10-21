/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Copy } from '@/components/ui/icon'
import type { AppDetail } from '@/lib/apps/types'
import { useState } from 'react'
import { toast } from 'sonner'
import { copyText, PromptBlock, SectionTitle } from './spec'
import { ToolButton } from './SubNav'

// The console never asks a person to do the agent's work. One compact row
// hands the app to the agent: which app and environment, one general set of
// instructions (where it is, how to deploy and inspect it, credentials). The
// text itself is there on demand; copying says exactly what was copied.
export function AgentHandoffPanel({ app }: { app: AppDetail }) {
  const [open, setOpen] = useState(false)
  const scope = `${app.name} · ${app.environment}`
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
                copyText(app.handoffPrompt)
                toast.success(`Copied instructions for ${scope}`)
              }}
            >
              <Copy className="size-3.5" /> Copy instructions
            </ToolButton>
          </>
        }
      />
      {open && <PromptBlock text={app.handoffPrompt} compact />}
    </section>
  )
}
