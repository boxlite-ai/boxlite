/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ChevronDown } from '@/components/ui/icon'
import { useAppMutation } from '@/hooks/mutations/useAppMutations'
import { useAppEnvironments, useOrgSecrets } from '@/hooks/queries/useAppsQuery'
import type { AppDetail } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { useConfirm } from '../confirm'
import {
  EmptyNote,
  PromptBlock,
  FlatButton,
  GridHeader,
  GridRow,
  HoverActions,
  MoreButton,
  SectionTitle,
  TEXT_INPUT,
  DIALOG_FRAME,
} from '../spec'
import { Screen, ToolButton } from '../SubNav'
import { useAppAction } from '../useAppAction'
import { Tag } from '../viz'

// Variables are what the app's services start with: plain values and secret
// references in one list, the way the app sees them. There is no draft state:
// each save is one deployment of this environment, which restarts the services
// with the new values (no rebuild) and is listed in Deployments like any other.
// Secrets stay in the control plane's org store and are never shown. What
// BoxLite sets on its own is listed read-only underneath.

const ENV_GRID = 'grid-cols-[240px_minmax(0,1fr)_minmax(0,1.1fr)_120px_120px] gap-x-4'
// The control plane checks names with the same rules as boxlite.toml (VARIABLE_NAME_RE and the
// platform names of @microcloud/shared); these mirror them so the form can say so before saving.
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/
const PLATFORM_RE = /^(BOXLITE_.*|DATABASE_URL|PORT)$/

interface Row {
  name: string
  value: string
  kind: string
  usedBy: string
  secret: boolean
  missing?: boolean
  raw?: string
  /** Saved, but the release serving now still has the old value. */
  pending?: boolean
}

/** What the control plane answered with: the deployment the save started. */
const deployingNote = (app: AppDetail | null) => (app?.releases[0] ? ` · deploying ${app.releases[0].id}` : '')

/** Parses KEY=VALUE lines; ignores blanks and comments, strips matching quotes. */
function parseDotenv(text: string): { values: Record<string, string>; invalid: number[] } {
  const values: Record<string, string> = {}
  const invalid: number[] = []
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || !NAME_RE.test(m[1]) || PLATFORM_RE.test(m[1])) {
      invalid.push(i + 1)
      continue
    }
    let value = m[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[m[1]] = value
  }
  return { values, invalid }
}

function InlineEditor({
  initialName,
  initialValue,
  lockName,
  busy,
  onSave,
  onCancel,
}: {
  initialName?: string
  initialValue?: string
  lockName?: boolean
  busy: boolean
  onSave: (name: string, value: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initialName ?? '')
  const [value, setValue] = useState(initialValue ?? '')
  const nameError =
    name && !NAME_RE.test(name)
      ? 'Use upper-case letters, digits and _ (like LOG_LEVEL)'
      : name && PLATFORM_RE.test(name)
        ? 'Set by BoxLite'
        : null
  const blocked = !name || !!nameError || busy || (lockName && value === initialValue)
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !blocked) onSave(name, value)
    if (e.key === 'Escape') onCancel()
  }
  return (
    <div className={`grid ${ENV_GRID} items-center bg-card/60 px-2 py-2`}>
      <span className="flex flex-col gap-1">
        <input
          autoFocus={!lockName && !initialName}
          disabled={lockName}
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
          onKeyDown={keys}
          placeholder="NAME"
          className={cn(TEXT_INPUT, 'h-8 disabled:opacity-70')}
        />
        {nameError && <span className="text-[12px] text-destructive">{nameError}</span>}
      </span>
      <input
        autoFocus={lockName || !!initialName}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={keys}
        placeholder="value"
        className={cn(TEXT_INPUT, 'col-span-2 h-8')}
      />
      <span className="col-span-2 flex justify-end gap-1">
        <ToolButton onClick={onCancel}>Cancel</ToolButton>
        <ToolButton
          primary
          loading={busy}
          disabled={blocked}
          onClick={() => onSave(name, value)}
          title="Saves and deploys"
        >
          Save and deploy
        </ToolButton>
      </span>
    </div>
  )
}

function ImportDialog({
  environment,
  existing,
  secrets,
  busy,
  onImport,
  onClose,
}: {
  environment: string
  existing: Record<string, string>
  secrets: string[]
  busy: boolean
  onImport: (values: Record<string, string>) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const { values, invalid } = parseDotenv(text)
  // What saving would do to each name, so nothing is overwritten unseen.
  const plan = Object.entries(values).map(([name, value]) => ({
    name,
    value,
    effect: secrets.includes(name)
      ? ('replaces a secret' as const)
      : !(name in existing)
        ? ('add' as const)
        : existing[name] === value
          ? ('unchanged' as const)
          : ('update' as const),
    before: existing[name],
  }))
  const changes = Object.fromEntries(plan.filter((p) => p.effect !== 'unchanged').map((p) => [p.name, p.value]))
  const count = (effect: string) => plan.filter((p) => p.effect === effect).length
  const adds = count('add')
  const updates = count('update') + count('replaces a secret')
  const label = [adds && `add ${adds}`, updates && `update ${updates}`].filter(Boolean).join(', ')
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[640px] font-mono text-body')}>
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">Import from .env</DialogTitle>
        </DialogHeader>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'DATABASE_POOL=10\nFEATURE_FLAGS="beta,search"\n# comments are ignored'}
          rows={6}
          spellCheck={false}
          className="resize-none border border-border bg-background p-3 font-mono text-[13px] leading-[1.6] text-foreground outline-none focus:border-foreground/40"
        />
        {plan.length === 0 ? (
          <span className="text-[13px] text-muted-foreground">
            Paste KEY=VALUE lines. You see what changes before saving.
          </span>
        ) : (
          <div className="flex max-h-[220px] flex-col overflow-y-auto text-[13px]">
            {plan.map((p) => (
              <div
                key={p.name}
                className="grid min-h-[32px] grid-cols-[180px_130px_minmax(0,1fr)] items-center gap-x-3 border-b border-border/60"
              >
                <span
                  className={cn('truncate', p.effect === 'unchanged' ? 'text-muted-foreground' : 'text-foreground')}
                >
                  {p.name}
                </span>
                <Tag tone={p.effect === 'add' ? 'good' : p.effect === 'unchanged' ? 'neutral' : 'warn'}>
                  {p.effect === 'add'
                    ? 'Add'
                    : p.effect === 'update'
                      ? 'Update'
                      : p.effect === 'unchanged'
                        ? 'Unchanged'
                        : 'Replaces a secret'}
                </Tag>
                <span className="truncate py-1 text-muted-foreground">
                  {p.effect === 'update' ? `${p.before} → ${p.value}` : p.value || '(empty)'}
                </span>
              </div>
            ))}
          </div>
        )}
        {plan.length > 0 && (
          <span className="text-[12px] text-muted-foreground">
            Saving starts one deployment of {environment} with these values.
          </span>
        )}
        {invalid.length > 0 && (
          <span className="text-[12px] text-warning">
            Skipped line {invalid.join(', ')}: not KEY=VALUE, or a name BoxLite sets
          </span>
        )}
        <DialogFooter className="gap-1">
          <FlatButton onClick={onClose}>Cancel</FlatButton>
          <FlatButton variant="primary" disabled={!label} loading={busy} onClick={() => onImport(changes)}>
            {label ? `${label.charAt(0).toUpperCase() + label.slice(1)} and deploy` : 'Nothing to change'}
          </FlatButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SecretDialog({
  busy,
  onSave,
  onClose,
}: {
  busy: boolean
  onSave: (input: { name: string; from: string }) => void
  onClose: () => void
}) {
  const { data: orgSecrets = [], isLoading } = useOrgSecrets(true)
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const chosen = from || orgSecrets[0]?.name || ''
  const blocked = !NAME_RE.test(name) || PLATFORM_RE.test(name) || !chosen
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[540px] font-mono text-body')}>
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">Reference a secret</DialogTitle>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-muted-foreground">Variable name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            placeholder="OPENAI_API_KEY"
            className={cn(TEXT_INPUT, 'h-10')}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-muted-foreground">Secret in the org&apos;s store</span>
          {orgSecrets.length === 0 ? (
            <span className="text-[13px] text-muted-foreground">
              {isLoading
                ? 'Loading…'
                : 'No org secrets yet. An admin adds one on the control plane (PUT /admin/secrets/org/<name>).'}
            </span>
          ) : (
            <select value={chosen} onChange={(e) => setFrom(e.target.value)} className={cn(TEXT_INPUT, 'h-10')}>
              {orgSecrets.map((secret) => (
                <option key={secret.name} value={secret.name}>
                  {secret.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <span className="text-[12px] text-muted-foreground">
          The app reads it from its environment. The value itself is never shown here.
        </span>
        <DialogFooter className="gap-1">
          <FlatButton onClick={onClose}>Cancel</FlatButton>
          <FlatButton
            variant="primary"
            disabled={blocked}
            loading={busy}
            onClick={() => onSave({ name, from: chosen })}
          >
            Add reference and deploy
          </FlatButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function VariablesTab({ app }: { app: AppDetail }) {
  const { run, pending } = useAppAction(app.id)
  const [confirm, confirmElement] = useConfirm()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  // ?add=NAME (from "Set NAME" on a crashing service): open that variable, then drop the parameter.
  const [params, setParams] = useSearchParams()
  const [prefill, setPrefill] = useState<string | undefined>()
  useEffect(() => {
    const name = params.get('add')
    if (!name) return
    if (app.variables && name in app.variables) setEditing(name)
    else {
      setPrefill(name)
      setAdding(true)
    }
    const next = new URLSearchParams(params)
    next.delete('add')
    setParams(next, { replace: true })
  }, [params, setParams, app.variables])
  const [dialog, setDialog] = useState<'import' | 'secret' | null>(null)
  const variables = app.variables
  const configured = variables !== null

  const secrets: Row[] = app.secrets.map((s) => ({
    name: s.name,
    value: `•••••• from ${s.from}`,
    kind: s.present ? 'Secret · in the environment' : `Secret · ${s.from} no longer exists`,
    usedBy: s.usedBy.join(', ') || '—',
    secret: true,
    missing: !s.present,
  }))
  const live = app.liveVariables
  const plain: Row[] = Object.entries(variables ?? {}).map(([name, value]) => ({
    name,
    value,
    raw: value,
    kind: 'Plain value',
    usedBy: 'All services',
    secret: false,
    pending: !!app.activeRelease && live !== null && live[name] !== value,
  }))
  // Removed in the saved configuration but still set in the release serving now.
  const removed = Object.keys(live ?? {}).filter((name) => app.activeRelease && !(name in (variables ?? {})))
  const rows = [...secrets, ...plain]

  const save = async (name: string, value: string) => {
    const existed = name in (variables ?? {})
    const ok = await run(
      { type: 'setVariable', name, value },
      (next) => `${name} ${existed ? 'changed' : 'added'}${deployingNote(next)}`,
      { key: `set:${name}` },
    )
    if (ok) {
      setAdding(false)
      setPrefill(undefined)
      setEditing(null)
    }
  }

  const remove = async (row: Row) => {
    const ok = await confirm({
      title: `Remove ${row.name} from ${app.environment}?`,
      body: <>A deployment restarts the services without it.</>,
      confirmLabel: 'Remove and deploy',
      danger: true,
    })
    if (!ok) return
    void run(
      row.secret ? { type: 'removeSecret', name: row.name } : { type: 'removeVariable', name: row.name },
      (next) => `${row.name} removed${deployingNote(next)}`,
      { key: `remove:${row.name}` },
    )
  }

  return (
    <Screen
      title={`Variables in ${app.environment}`}
      actions={
        configured ? (
          <>
            <CopyFrom app={app} />
            <ToolButton onClick={() => setDialog('import')}>Import .env</ToolButton>
            <ToolButton onClick={() => setDialog('secret')}>Reference a secret</ToolButton>
            <ToolButton primary onClick={() => setAdding(true)} disabled={adding}>
              Add variable
            </ToolButton>
          </>
        ) : undefined
      }
      padded={false}
    >
      {!configured ? (
        <EmptyNote
          title="Nothing configured yet"
          action={
            <div className="w-full max-w-[560px] text-left">
              <PromptBlock
                text={`Give BoxLite app "${app.name}" the settings it needs as variables, take API keys from the org's secret store, and deploy.`}
                compact
              />
            </div>
          }
        >
          Your agent sets them up with the first deployment. Then they are listed here and you can change them; each
          save restarts the services with the new values.
        </EmptyNote>
      ) : (
        <>
          <p className="pb-4 font-mono text-[13px] text-muted-foreground">
            Secrets stay in your org&apos;s secret store and are never shown. Saving restarts the services with the new
            values; no rebuild.
          </p>
          {removed.length > 0 && (
            <p className="pb-3 font-mono text-[12px] text-warning">
              {removed.join(', ')} {removed.length === 1 ? 'is' : 'are'} removed; the release serving now still has{' '}
              {removed.length === 1 ? 'it' : 'them'} until {app.deploying?.id ?? 'the next deployment'} is live.
            </p>
          )}
          <GridHeader grid={ENV_GRID} columns={['Name', 'Value', 'How it reaches the app', 'Used by', '']} />
          {adding && (
            <InlineEditor
              initialName={prefill}
              busy={pending?.startsWith('set:') ?? false}
              onSave={(name, value) => void save(name, value)}
              onCancel={() => {
                setAdding(false)
                setPrefill(undefined)
              }}
            />
          )}
          {rows.length === 0 && !adding ? (
            <EmptyNote title="Nothing set">
              Add a value, paste a .env, or reference a secret from the org store.
            </EmptyNote>
          ) : (
            rows.map((row) =>
              editing === row.name ? (
                <InlineEditor
                  key={row.name}
                  initialName={row.name}
                  initialValue={row.raw}
                  lockName
                  busy={pending === `set:${row.name}`}
                  onSave={(name, value) => void save(name, value)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <GridRow
                  key={row.name}
                  grid={ENV_GRID}
                  onClick={row.secret ? undefined : () => setEditing(row.name)}
                  className={cn(pending === `remove:${row.name}` && 'opacity-40')}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-semibold text-foreground">{row.name}</span>
                    {row.missing && <Tag tone="bad">Missing</Tag>}
                    {row.pending && (
                      <span
                        title={
                          app.deploying
                            ? `Takes effect when ${app.deploying.id} is live`
                            : 'Not in the live release yet'
                        }
                      >
                        <Tag tone="warn">{app.deploying ? `Pending · ${app.deploying.id}` : 'Not live'}</Tag>
                      </span>
                    )}
                  </span>
                  <span className="truncate text-foreground" title={row.secret ? undefined : 'Click to edit'}>
                    {row.value}
                  </span>
                  <span className={cn('truncate', row.missing ? 'text-destructive' : 'text-muted-foreground')}>
                    {row.kind}
                  </span>
                  <span className="truncate text-muted-foreground">{row.usedBy}</span>
                  <span onClick={(e) => e.stopPropagation()}>
                    <HoverActions>
                      {!row.secret && <ToolButton onClick={() => setEditing(row.name)}>Edit</ToolButton>}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <MoreButton />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[10rem] font-mono">
                          <DropdownMenuItem
                            className="cursor-pointer text-destructive focus:text-destructive"
                            onClick={() => void remove(row)}
                          >
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </HoverActions>
                  </span>
                </GridRow>
              ),
            )
          )}
        </>
      )}

      <div className="pt-10">
        <SectionTitle title="Set by BoxLite" />
      </div>
      <GridHeader grid={ENV_GRID} columns={['Name', 'Value', 'Source', '', '']} />
      {app.platformVariables.map((row) => (
        <GridRow key={row.name} grid={ENV_GRID}>
          <span className="truncate font-semibold text-foreground">{row.name}</span>
          <span className="truncate text-muted-foreground" title={row.value}>
            {row.value}
          </span>
          <span className="truncate text-muted-foreground">{row.kind}</span>
          <span />
          <span />
        </GridRow>
      ))}

      {dialog === 'import' && (
        <ImportDialog
          environment={app.environment}
          existing={variables ?? {}}
          secrets={app.secrets.map((secret) => secret.name)}
          busy={pending === 'importVariables'}
          onClose={() => setDialog(null)}
          onImport={async (values) => {
            const n = Object.keys(values).length
            if (
              await run(
                { type: 'importVariables', values },
                (next) => `Imported ${n} ${n === 1 ? 'variable' : 'variables'}${deployingNote(next)}`,
              )
            )
              setDialog(null)
          }}
        />
      )}
      {dialog === 'secret' && (
        <SecretDialog
          busy={pending === 'referenceSecret'}
          onClose={() => setDialog(null)}
          onSave={async (input) => {
            if (
              await run(
                { type: 'referenceSecret', ...input },
                (next) => `${input.name} references ${input.from}${deployingNote(next)}`,
              )
            )
              setDialog(null)
          }}
        />
      )}
      {confirmElement}
    </Screen>
  )
}

function CopyFrom({ app }: { app: AppDetail }) {
  const { data: envs = [] } = useAppEnvironments(app.id)
  const mutation = useAppMutation()
  const [confirm, confirmElement] = useConfirm()
  const others = envs.filter((e) => e.name !== app.environment)
  if (others.length === 0) return null
  const copy = async (from: string) => {
    const ok = await confirm({
      title: `Copy variables from ${from}?`,
      body: (
        <>
          {app.environment}&apos;s plain values and secret references are replaced with {from}&apos;s, in one deployment
          of {app.environment}. Secret values themselves stay in the org store.
        </>
      ),
      confirmLabel: `Copy from ${from} and deploy`,
    })
    if (!ok) return
    try {
      const next = await mutation.mutateAsync({ kind: 'copyVariables', appId: app.id, from })
      toast.success(`Copied from ${from}${deployingNote(next)}`)
    } catch (error) {
      handleApiError(error, 'Failed to copy variables')
    }
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-[28px] items-center gap-1.5 whitespace-nowrap border border-border px-[10px] font-mono text-[12px] text-muted-foreground outline-none transition-colors hover:border-brand hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/35 data-[state=open]:border-brand data-[state=open]:text-foreground"
          >
            Copy from <ChevronDown className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[12rem] font-mono">
          {others.map((env) => (
            <DropdownMenuItem key={env.name} className="cursor-pointer" onClick={() => void copy(env.name)}>
              {env.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmElement}
    </>
  )
}
