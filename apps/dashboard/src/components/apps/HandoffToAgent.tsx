/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Check, Copy } from '@/components/ui/icon'
import { useRotateKey } from '@/hooks/mutations/useAppMutations'
import { freshPrompt } from '@/lib/apps/handoff'
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
// the control plane's prompt for the agent, marked with the agents it works in.
// The App key inside it is shown in full only once (when the app is created, or
// right after a rotation): the page shows it masked, and Copy prompt copies the
// working prompt while this tab still holds it, or issues a new key first.

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
  const [copied, setCopied] = useState(false)
  const fresh = freshPrompt(app.id)
  // The prompt with its working key is known right after creation; later only a new key can make one.
  const copy = () => {
    if (!fresh) return void flow.start()
    copyText(fresh)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
    toast.success('Copied. Paste it into your coding agent, then tell it what to build.')
  }
  return (
    <div className="flex flex-col">
      <section className="flex flex-col">
        <SectionTitle
          title="Hand off to your agent"
          right={
            <>
              <AgentLogos className="mr-3" />
              <ToolButton primary loading={flow.pending} onClick={copy}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? 'Copied' : 'Copy prompt'}
              </ToolButton>
            </>
          }
        />
        <pre className="whitespace-pre-wrap break-words border border-border bg-[hsl(var(--code-background))] px-[22px] py-[18px] font-mono text-meta leading-[1.75] text-foreground">
          {app.handoffPrompt}
        </pre>
        <p className="mt-3 font-mono text-meta text-muted-foreground">
          Paste it into Claude Code, Codex, Cursor or any coding agent, then tell it what to build. The key in it can
          manage only this app{fresh ? '' : '; copying gives a new key and retires the old one'}.
        </p>
      </section>
      {flow.element}
    </div>
  )
}
