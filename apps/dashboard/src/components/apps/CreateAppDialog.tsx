/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useCreateApp } from '@/hooks/mutations/useAppMutations'
import { useConsoleSession } from '@/hooks/queries/useAppsQuery'
import { nameProblem } from '@/lib/apps/format'
import type { AppDetail } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { FlatButton, DIALOG_FRAME } from './spec'

// A new app needs only a name. What it runs, which services it has and what it
// stores are declared by the agent in boxlite.toml. Creating it opens the app's
// page, where the prompt for the agent waits; the App key minted with it stays
// in this tab's memory so Copy prompt there hands over the working key.

function Heading({ children }: { children: string }) {
  return <div className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">{children}</div>
}

export function CreateAppDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (app: AppDetail) => void
}) {
  const mutation = useCreateApp()
  const { data: session } = useConsoleSession()
  const [name, setName] = useState('')
  const problem = name ? nameProblem(name, session?.reservedNames) : null
  const valid = !!name && !problem

  const submit = async () => {
    if (!valid || mutation.isPending) return
    try {
      const created = await mutation.mutateAsync({ name })
      onOpenChange(false)
      setName('')
      onCreated(created.app)
    } catch (error) {
      handleApiError(error, 'Failed to create app')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[520px] font-mono text-body')}>
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">New app</DialogTitle>
        </DialogHeader>

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
            // Each environment gets its own address when it is created, so there is none to preview yet.
            <div className="text-meta text-muted-foreground">
              {name ? 'Gets its own URL when you create it.' : 'Lowercase letters, digits and dashes.'}
            </div>
          )}
          <p className="mt-2 text-meta text-muted-foreground">
            That is all you set. Creating it only reserves the name and URL: nothing runs until your coding agent
            deploys, creating the runtime, database, sign-in and storage it needs.
          </p>
        </div>

        <DialogFooter className="gap-2">
          <FlatButton onClick={() => onOpenChange(false)}>Cancel</FlatButton>
          <FlatButton variant="primary" onClick={submit} disabled={!valid || mutation.isPending}>
            {mutation.isPending ? 'Creating…' : 'Create app'}
          </FlatButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
