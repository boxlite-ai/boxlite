/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Check, Copy } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { useCreateApp } from '@/hooks/mutations/useAppMutations'
import { useConsoleSession } from '@/hooks/queries/useAppsQuery'
import { nameProblem } from '@/lib/apps/format'
import type { AppDetail, CreatedApp } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { toast } from 'sonner'
import { AgentLogos } from './AgentLogos'
import { copyText, FlatButton, DIALOG_FRAME } from './spec'

// A new app needs only a name. What it runs, which services it has and what it
// stores are declared by the agent in boxlite.toml. Creating it mints the App
// key, which is shown once, inside the prompt for the agent: it lives in this
// dialog only and is gone when the dialog closes (the key can be rotated later).

function Heading({ children }: { children: string }) {
  return <div className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">{children}</div>
}

export function CreateAppDialog({
  open,
  onOpenChange,
  onOpen,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpen: (app: AppDetail) => void
}) {
  const mutation = useCreateApp()
  const { data: session } = useConsoleSession()
  const [name, setName] = useState('')
  const [created, setCreated] = useState<CreatedApp | null>(null)
  const [copied, setCopied] = useState(false)

  const problem = name ? nameProblem(name, session?.reservedNames) : null
  const valid = !!name && !problem

  const close = (next: boolean) => {
    if (next) return onOpenChange(true)
    // Forget the key with the dialog.
    const app = created?.app
    setCreated(null)
    setName('')
    setCopied(false)
    onOpenChange(false)
    if (app) onOpen(app)
  }

  const submit = async () => {
    if (!valid || mutation.isPending) return
    try {
      setCreated(await mutation.mutateAsync({ name }))
    } catch (error) {
      handleApiError(error, 'Failed to create app')
    }
  }

  const copy = () => {
    if (!created) return
    copyText(created.prompt)
    setCopied(true)
    toast.success('Copied. Paste it into your coding agent and tell it what to build.')
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[620px] font-mono text-body')}>
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">
            {created ? `${created.app.name} is ready for your agent` : 'New app'}
          </DialogTitle>
        </DialogHeader>

        {created ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <Heading>Prompt for your agent</Heading>
              <AgentLogos />
            </div>
            <pre className="whitespace-pre-wrap break-words border border-border bg-[hsl(var(--code-background))] px-[18px] py-[14px] font-mono text-meta leading-[1.75] text-foreground">
              {created.prompt}
            </pre>
            <p className="text-meta text-muted-foreground">
              It carries the App key, which is shown only now. The key can manage this one app and nothing else. Lost
              it? Rotate the key on the app page for a new prompt.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Heading>Name</Heading>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              placeholder="e.g. crm"
              aria-invalid={problem !== null}
              className="h-10 font-mono"
            />
            {problem ? (
              <div className="text-meta text-destructive">{problem}</div>
            ) : (
              // Each environment gets its own origin from the control plane when it is created, so there
              // is no URL to preview yet; the app's URL is shown once it exists.
              <div className="text-meta text-muted-foreground">
                {name
                  ? 'Gets its own URL, assigned when created.'
                  : 'Lowercase letters, digits and dashes, starting with a letter.'}
              </div>
            )}
            <p className="mt-2 text-meta text-muted-foreground">
              That is all you set. Creating it reserves the name and URL and issues the App key: nothing runs until your
              coding agent deploys, creating the runtime, database and storage it declares.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2">
          {created ? (
            <>
              <FlatButton onClick={() => close(false)}>Open app page</FlatButton>
              <FlatButton variant="primary" onClick={copy}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? 'Copied' : 'Copy prompt'}
              </FlatButton>
            </>
          ) : (
            <>
              <FlatButton onClick={() => close(false)}>Cancel</FlatButton>
              <FlatButton variant="primary" onClick={submit} disabled={!valid || mutation.isPending}>
                {mutation.isPending ? 'Creating…' : 'Create app'}
              </FlatButton>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
