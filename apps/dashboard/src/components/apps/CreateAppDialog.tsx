/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAppMutation } from '@/hooks/mutations/useAppMutations'
import type { AppDetail } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { FlatButton, DIALOG_FRAME } from './spec'

// A new app needs only a name. What it runs, which services it has and what it stores are
// declared by the agent in boxlite.toml; the app page that opens next is where the person
// hands it over.

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
  const mutation = useAppMutation()
  const [name, setName] = useState('')

  const valid = /^[a-z0-9][a-z0-9-]*$/.test(name)
  // Say why Create is blocked next to the field, once the user has typed something.
  const nameError =
    name === '' || valid ? null : 'Use lowercase letters, numbers and dashes, starting with a letter or number.'

  const submit = async () => {
    if (!valid) return
    try {
      const app = await mutation.mutateAsync({
        kind: 'create',
        input: { name },
      })
      if (app) {
        onOpenChange(false)
        setName('')
        onCreated(app)
      }
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
            aria-invalid={nameError !== null}
            className="h-10 font-mono"
          />
          {nameError ? (
            <div className="text-meta text-destructive">{nameError}</div>
          ) : (
            // The URL is shown for the name actually typed, never for the placeholder.
            <div className="text-meta text-muted-foreground">
              {name ? (
                <>
                  Opens at <span className="text-foreground">{name}-acme.boxlite.app</span>
                </>
              ) : (
                'Lowercase letters, digits and dashes.'
              )}
            </div>
          )}
          <p className="mt-2 text-meta text-muted-foreground">
            That is all you set. Creating it only reserves the name and URL: nothing runs and nothing is billed until
            your coding agent deploys, creating the runtime, database, sign-in and storage it needs.
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
