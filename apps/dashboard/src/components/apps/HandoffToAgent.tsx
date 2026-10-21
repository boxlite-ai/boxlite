/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Check, Copy } from '@/components/ui/icon'
import { useRotateKey } from '@/hooks/mutations/useAppMutations'
import type { AppDetail } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { toast } from 'sonner'
import { AgentLogos } from './AgentLogos'
import { useConfirm } from './confirm'
import { copyText, DIALOG_FRAME, FlatButton, SectionTitle } from './spec'
import { ToolButton } from './SubNav'

// What a new (not yet deployed) environment shows instead of the live overview:
// the control plane's prompt for the agent. The App key inside it is shown in
// full only once (when the app is created, or right after a rotation); here it
// is masked. Rotating issues a new key and prompt and retires the old key.

/** Rotate key: confirm, call the control plane, show the new prompt once. */
export function useRotateKeyFlow(app: AppDetail) {
  const rotate = useRotateKey()
  const [confirm, confirmElement] = useConfirm()
  const [shown, setShown] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const start = async () => {
    const ok = await confirm({
      title: `Rotate the App key of ${app.name}?`,
      body: (
        <>
          A new key and prompt are shown once. The current key (…{app.key?.last4 ?? '????'}) stops working now, so an
          agent still using it has to be given the new prompt.
        </>
      ),
      confirmLabel: 'Rotate key',
      danger: true,
    })
    if (!ok) return
    try {
      const out = await rotate.mutateAsync(app.id)
      setCopied(false)
      setShown(out.prompt)
    } catch (error) {
      handleApiError(error, 'Could not rotate the key')
    }
  }

  const element = (
    <>
      {confirmElement}
      <Dialog open={!!shown} onOpenChange={(open) => !open && setShown(null)}>
        <DialogContent className={cn(DIALOG_FRAME, 'max-w-[620px] font-mono text-body')}>
          <DialogHeader>
            <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">
              New prompt for {app.name}
            </DialogTitle>
          </DialogHeader>
          <pre className="whitespace-pre-wrap break-words border border-border bg-[hsl(var(--code-background))] px-[18px] py-[14px] font-mono text-meta leading-[1.75] text-foreground">
            {shown}
          </pre>
          <p className="text-meta text-muted-foreground">
            The new key is shown only now. Copy the prompt before closing.
          </p>
          <DialogFooter className="gap-2">
            <FlatButton onClick={() => setShown(null)}>Close</FlatButton>
            <FlatButton
              variant="primary"
              onClick={() => {
                if (!shown) return
                copyText(shown)
                setCopied(true)
                toast.success('Copied. Paste it into your coding agent.')
              }}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? 'Copied' : 'Copy prompt'}
            </FlatButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
  return { start, pending: rotate.isPending, element }
}

export function HandoffToAgent({ app }: { app: AppDetail }) {
  const flow = useRotateKeyFlow(app)
  return (
    <div className="flex flex-col">
      <section className="flex flex-col">
        <SectionTitle
          title="Hand off to your agent"
          right={
            <>
              <AgentLogos className="mr-3" />
              <ToolButton primary loading={flow.pending} onClick={() => void flow.start()}>
                Rotate key and get prompt
              </ToolButton>
            </>
          }
        />
        <pre className="whitespace-pre-wrap break-words border border-border bg-[hsl(var(--code-background))] px-[22px] py-[18px] font-mono text-meta leading-[1.75] text-foreground">
          {app.handoffPrompt}
        </pre>
        <p className="mt-3 font-mono text-meta text-muted-foreground">
          The prompt with its key was shown when the app was created. Paste it into Claude Code, Codex, Cursor or any
          coding agent and tell it what to build; this page turns live when its first deployment does. Lost the prompt?
          Rotate the key for a new one.
        </p>
      </section>
      {flow.element}
    </div>
  )
}
