/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { AppDetail } from '@/lib/apps/types'
import { useState } from 'react'
import { useRotateKeyFlow } from './HandoffToAgent'
import { SectionTitle } from './spec'
import { ToolButton } from './SubNav'

// The console never asks a person to do the agent's work. One compact row
// hands the app to the agent: the control plane's prompt, with the App key
// masked (it is shown in full only once). A new key and prompt come from
// rotating the key.
export function AgentHandoffPanel({ app }: { app: AppDetail }) {
  const [open, setOpen] = useState(false)
  const flow = useRotateKeyFlow(app)
  return (
    <section className="flex flex-col">
      <SectionTitle
        title="Hand off to your agent"
        count={app.key ? `key …${app.key.last4}` : undefined}
        right={
          <>
            <ToolButton onClick={() => setOpen((v) => !v)}>{open ? 'Hide prompt' : 'View prompt'}</ToolButton>
            <ToolButton loading={flow.pending} onClick={() => void flow.start()}>
              Rotate key
            </ToolButton>
          </>
        }
      />
      {/* No copy action: the key in it is masked, so a copy could not reach the app. */}
      {open && (
        <pre className="whitespace-pre-wrap break-words border border-border bg-[hsl(var(--code-background))] px-4 py-3 font-mono text-[12px] leading-[1.65] text-foreground">
          {app.handoffPrompt}
        </pre>
      )}
      {flow.element}
    </section>
  )
}
