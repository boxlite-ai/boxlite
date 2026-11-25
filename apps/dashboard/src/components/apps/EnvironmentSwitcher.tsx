/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Check, ChevronDown, GitBranch, Plus, Trash2 } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { useAppMutation } from '@/hooks/mutations/useAppMutations'
import { useAppEnvironments } from '@/hooks/queries/useAppsQuery'
import { useAppsScope } from '@/lib/apps/client'
import { appStatusOf, nameProblem } from '@/lib/apps/format'
import type { EnvironmentSummary } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { toast } from 'sonner'
import { FlatButton, DIALOG_FRAME } from './spec'

// An app has one or more environments; everything on the app page below the
// header belongs to the one picked here. It sits beside the app name, at
// reading size, because it is the scope of the whole page: crm / main.
// It carries no health colour: which environment it is and how it is doing
// are separate facts, and the header states the second one next to it.

export function EnvironmentSwitcher({
  appId,
  appName,
  current,
  onSwitch,
  onDelete,
}: {
  appId: string
  appName: string
  current: string
  onSwitch: (env: string) => void
  /** Deletes the current environment (asks first); main is deleted only with the App. */
  onDelete: () => void
}) {
  const { data: envs = [] } = useAppEnvironments(appId)
  const { canWrite } = useAppsScope()
  const [creating, setCreating] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" aria-label="Switch environment">
            <GitBranch className="size-3.5 shrink-0" />
            {current}
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[19rem] font-sans text-body">
          <div className="px-2 py-1.5 text-meta text-muted-foreground">Environments</div>
          {envs.map((env) => {
            const status = appStatusOf(env.status)
            return (
              <DropdownMenuItem
                key={env.name}
                className="cursor-pointer items-start gap-3 py-2"
                onClick={() => onSwitch(env.name)}
              >
                <span className="mt-[3px] w-4 shrink-0">
                  {env.name === current && <Check className="size-4 text-foreground" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-foreground">{env.name}</span>
                    <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
                      <span className="inline-block size-[6px]" style={{ background: status.color }} />
                      {env.lastDeploy ? `${env.lastDeploy.releaseId} · ${status.label}` : status.label}
                    </span>
                  </span>
                  <span className="truncate text-meta text-muted-foreground">
                    {env.url ? env.url.replace(/^https?:\/\//, '') : 'URL unavailable'}
                  </span>
                </span>
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!canWrite} className="cursor-pointer gap-3" onClick={() => setCreating(true)}>
            <span className="w-4">
              <Plus className="size-4" />
            </span>
            New environment
          </DropdownMenuItem>
          {current === 'main' ? (
            <div className="px-2 py-1.5 pl-9 text-meta text-muted-foreground">main is deleted only with the app</div>
          ) : (
            <DropdownMenuItem
              disabled={!canWrite}
              className="cursor-pointer gap-3 text-destructive focus:text-destructive"
              onClick={onDelete}
            >
              <span className="w-4">
                <Trash2 className="size-4" />
              </span>
              Delete {current}…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {creating && (
        <NewEnvironmentDialog
          appId={appId}
          appName={appName}
          envs={envs}
          current={current}
          onClose={() => setCreating(false)}
          onCreated={(name) => {
            setCreating(false)
            onSwitch(name)
          }}
        />
      )}
    </>
  )
}

function NewEnvironmentDialog({
  appId,
  appName,
  envs,
  current,
  onClose,
  onCreated,
}: {
  appId: string
  appName: string
  envs: EnvironmentSummary[]
  current: string
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const mutation = useAppMutation()
  const [name, setName] = useState('')
  const [from, setFrom] = useState<string>(current)
  const [withData, setWithData] = useState(false)
  const taken = envs.some((e) => e.name === name)
  const error = !name ? null : taken ? `${name} already exists.` : nameProblem(name)
  const blocked = !name || !!error || mutation.isPending

  const create = async () => {
    if (blocked) return
    try {
      await mutation.mutateAsync({ kind: 'createEnvironment', appId, name, from, withData })
      toast.success(`${name} created`)
      onCreated(name)
    } catch (err) {
      handleApiError(err, 'Failed to create the environment')
    }
  }

  // The control plane branches the new environment's database from another environment's.
  const sources: { id: string; withData: boolean; label: string; hint: string }[] = envs.flatMap((e) => [
    { id: e.name, withData: false, label: `Branch from ${e.name}`, hint: 'database schema only, no rows' },
    { id: e.name, withData: true, label: `Branch from ${e.name} with its data`, hint: 'database schema and rows' },
  ])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[520px] font-sans text-body')}>
        <DialogHeader>
          <DialogTitle className="font-display text-section font-semibold">New environment for {appName}</DialogTitle>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <span className="text-meta text-muted-foreground">Name</span>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="staging"
            aria-invalid={!!error}
            className="font-mono"
          />
          <span className={cn('text-meta', error ? 'text-destructive' : 'text-muted-foreground')}>
            {error ?? 'Its own URL, assigned when created · its own Box'}
          </span>
        </label>
        <div className="flex flex-col gap-2" role="radiogroup">
          {sources.map((source) => (
            <button
              key={`${source.id}:${source.withData}`}
              type="button"
              role="radio"
              aria-checked={from === source.id && withData === source.withData}
              onClick={() => {
                setFrom(source.id)
                setWithData(source.withData)
              }}
              className={cn(
                'flex flex-col items-start gap-0.5 border px-3 py-2 text-left transition-colors',
                from === source.id && withData === source.withData
                  ? 'border-foreground/50 bg-card'
                  : 'border-border hover:border-brand',
              )}
            >
              <span className="text-foreground">{source.label}</span>
              <span className="text-meta text-muted-foreground">{source.hint}</span>
            </button>
          ))}
        </div>
        <span className="text-meta text-muted-foreground">
          Files are never copied, and variables are your agent&apos;s to set. The new environment starts with nothing
          deployed; hand it to your agent from its Overview.
        </span>
        <DialogFooter className="gap-2">
          <FlatButton onClick={onClose}>Cancel</FlatButton>
          <FlatButton variant="primary" disabled={blocked} onClick={() => void create()}>
            Create environment
          </FlatButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
