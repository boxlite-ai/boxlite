/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useCreateApp } from '@/hooks/mutations/useAppMutations'
import { nameProblem } from '@/lib/apps/format'
import type { AppDetail } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { FlatButton, DIALOG_FRAME } from './spec'

// A new app needs only a name. What it runs, which services it has and what it
// stores are declared by the agent in boxlite.toml. Creating it opens the app's
// page with setup instructions for the agent.

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
  const [name, setName] = useState('')
  // Closing it, however, starts the next one empty.
  const close = (next: boolean) => {
    if (!next) setName('')
    onOpenChange(next)
  }
  const problem = name ? nameProblem(name) : null
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
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[520px] font-sans text-body')}>
        <DialogHeader>
          <DialogTitle className="font-display text-section font-semibold">New app</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <label htmlFor="new-app-name" className="form-field-label">
            Name
          </label>
          <Input
            id="new-app-name"
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
            <div className="text-body text-muted-foreground">
              Lowercase letters, digits and dashes. This name does not set your app’s address.
            </div>
          )}
          <p className="mt-2 text-body text-muted-foreground">
            BoxLite assigns an address with a generated ID. Create the app, then use your coding agent to deploy it.
            Nothing runs until the first deployment.
          </p>
        </div>

        <DialogFooter className="gap-2">
          <FlatButton onClick={() => close(false)}>Cancel</FlatButton>
          <FlatButton variant="primary" onClick={submit} disabled={!valid || mutation.isPending}>
            {mutation.isPending ? 'Creating…' : 'Start building'}
          </FlatButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
