/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Check, ChevronDown, Plus } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { useAppMutation } from '@/hooks/mutations/useAppMutations'
import { useAppEnvironments } from '@/hooks/queries/useAppsQuery'
import { appStatusOf } from '@/lib/apps/format'
import type { EnvironmentSummary } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { toast } from 'sonner'
import { FlatButton, DIALOG_FRAME } from './spec'

// An app has one or more environments; everything on the app page below the
// header belongs to the one picked here. It sits beside the app name, at
// reading size, because it is the scope of the whole page: crm / production.
// It carries no health colour: which environment it is and how it is doing
// are separate facts, and the header states the second one next to it.

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

export function EnvironmentSwitcher({
  appId,
  appName,
  current,
  onSwitch,
}: {
  appId: string
  appName: string
  current: string
  onSwitch: (env: string) => void
}) {
  const { data: envs = [] } = useAppEnvironments(appId)
  const [creating, setCreating] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-[30px] items-center gap-1.5 border border-dashed border-border px-[10px] font-mono text-body text-muted-foreground transition-colors hover:border-brand hover:text-foreground data-[state=open]:border-brand data-[state=open]:text-foreground"
          >
            {current}
            <ChevronDown className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[19rem] font-mono text-[13px]">
          <div className="px-2 py-1.5 text-[12px] text-muted-foreground">Environments</div>
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
                    <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                      <span className="inline-block size-[6px]" style={{ background: status.color }} />
                      {env.lastDeploy ? `${env.lastDeploy.releaseId} · ${status.label}` : status.label}
                    </span>
                  </span>
                  <span className="truncate text-[12px] text-muted-foreground">
                    {env.url ? env.url.replace(/^https:\/\//, '') : 'Not published'} · box {env.box}
                  </span>
                </span>
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="cursor-pointer gap-3" onClick={() => setCreating(true)}>
            <span className="w-4">
              <Plus className="size-4" />
            </span>
            New environment
          </DropdownMenuItem>
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
  const [from, setFrom] = useState<string | null>(current)
  const taken = envs.some((e) => e.name === name)
  const error = !name
    ? null
    : !NAME_RE.test(name)
      ? 'Use lowercase letters, digits and dashes.'
      : taken
        ? `${name} already exists.`
        : null
  const blocked = !name || !!error || mutation.isPending

  const create = async () => {
    if (blocked) return
    try {
      await mutation.mutateAsync({ kind: 'createEnvironment', appId, name, from })
      toast.success(`${name} created`)
      onCreated(name)
    } catch (err) {
      handleApiError(err, 'Failed to create the environment')
    }
  }

  const sources: { id: string | null; label: string; hint: string }[] = [
    ...envs.map((e) => ({
      id: e.name,
      label: `Copy from ${e.name}`,
      hint: 'variables, secrets, sign-in methods, database schema, volume names',
    })),
    { id: null, label: 'Start empty', hint: 'Google and GitHub sign-in, nothing else' },
  ]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[520px] font-mono text-body')}>
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">
            New environment for {appName}
          </DialogTitle>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted-foreground">Name</span>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="staging"
            aria-invalid={!!error}
            className="font-mono"
          />
          <span className={cn('text-[12px]', error ? 'text-destructive' : 'text-muted-foreground')}>
            {error ?? `URL ${appName}-${name || 'staging'}-acme.boxlite.app · its own box`}
          </span>
        </label>
        <div className="flex flex-col gap-2" role="radiogroup">
          {sources.map((source) => (
            <button
              key={source.id ?? 'empty'}
              type="button"
              role="radio"
              aria-checked={from === source.id}
              onClick={() => setFrom(source.id)}
              className={cn(
                'flex flex-col items-start gap-0.5 border px-3 py-2 text-left transition-colors',
                from === source.id ? 'border-foreground/50 bg-card' : 'border-border hover:border-brand',
              )}
            >
              <span className="text-foreground">{source.label}</span>
              <span className="text-[12px] text-muted-foreground">{source.hint}</span>
            </button>
          ))}
        </div>
        {/* The one thing people get wrong about environments: data never travels with the copy. */}
        <span className="text-[12px] text-muted-foreground">
          Rows, users and files are never copied. The new environment starts with nothing deployed.
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
