/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ChevronDown } from '@/components/ui/icon'
import { useAppMutation } from '@/hooks/mutations/useAppMutations'
import { useAppEnvironments } from '@/hooks/queries/useAppsQuery'
import type { AppDetail, PendingChange } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { toast } from 'sonner'
import { useConfirm } from '../confirm'
import {
  EmptyNote,
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
// references in one list, the way the app sees them. Everything is editable in
// place: add a row, click a value to change it, remove with undo, paste a .env
// to import many at once. Secrets stay in the org store and are never shown.
// What BoxLite injects on its own is listed read-only underneath, so this
// screen describes the whole runtime configuration. Changes apply on the next
// deployment, and every confirmation says so.

const ENV_GRID = 'grid-cols-[240px_minmax(0,1fr)_minmax(0,1.1fr)_120px_120px] gap-x-4'
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/
const ORG_SECRETS = ['org/stripe-live', 'org/openai', 'org/slack-bot', 'org/sendgrid', 'org/github-app']

interface Row {
  name: string
  value: string
  kind: string
  usedBy: string
  secret: boolean
  raw?: string
}

/** Parses KEY=VALUE lines; ignores blanks and comments, strips matching quotes. */
function parseDotenv(text: string): { values: Record<string, string>; invalid: number[] } {
  const values: Record<string, string> = {}
  const invalid: number[] = []
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) {
      invalid.push(i + 1)
      continue
    }
    let value = m[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[m[1].toUpperCase()] = value
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
  const nameError = name && !NAME_RE.test(name) ? 'UPPER_SNAKE_CASE' : null
  const blocked = !name || !!nameError || busy
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !blocked) onSave(name, value)
    if (e.key === 'Escape') onCancel()
  }
  return (
    <div className={`grid ${ENV_GRID} items-center bg-card/60 px-2 py-2`}>
      <span className="flex flex-col gap-1">
        <input
          autoFocus={!lockName}
          disabled={lockName}
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
          onKeyDown={keys}
          placeholder="NAME"
          className={cn(TEXT_INPUT, 'h-8 disabled:opacity-70')}
        />
        {nameError && <span className="text-[12px] text-destructive">Use {nameError}</span>}
      </span>
      <input
        autoFocus={lockName}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={keys}
        placeholder="value"
        className={cn(TEXT_INPUT, 'col-span-2 h-8')}
      />
      <span className="col-span-2 flex justify-end gap-1">
        <ToolButton onClick={onCancel}>Cancel</ToolButton>
        <ToolButton primary loading={busy} disabled={blocked} onClick={() => onSave(name, value)}>
          Save
        </ToolButton>
      </span>
    </div>
  )
}

function ImportDialog({
  existing,
  secrets,
  pendingChanges,
  busy,
  onImport,
  onClose,
}: {
  existing: Record<string, string>
  secrets: string[]
  pendingChanges: PendingChange[]
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
  // The values the running deployment uses, so the preview can say where each name ends up.
  const live: Record<string, string> = { ...existing }
  for (const c of pendingChanges) {
    if (c.secret) continue
    if (c.change === 'added') delete live[c.name]
    else if (c.live !== undefined) live[c.name] = c.live
  }
  const after = { ...existing, ...changes }
  const notLive =
    [...new Set([...Object.keys(live), ...Object.keys(after)])].filter((name) => live[name] !== after[name]).length +
    pendingChanges.filter((c) => c.secret).length
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
                <span className="flex min-w-0 flex-col py-1">
                  <span className="truncate text-muted-foreground">
                    {p.effect === 'update' ? `${p.before} → ${p.value}` : p.value || '(empty)'}
                  </span>
                  {p.name in live && live[p.name] !== p.before && (
                    <span className="truncate text-[12px] text-muted-foreground">live: {live[p.name]}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {plan.length > 0 && (
          <span className="text-[12px] text-muted-foreground">
            After import: {notLive} {notLive === 1 ? 'change' : 'changes'} not live. Nothing reaches the app until you
            deploy.
          </span>
        )}
        {invalid.length > 0 && (
          <span className="text-[12px] text-warning">Skipped line {invalid.join(', ')}: not KEY=VALUE</span>
        )}
        <DialogFooter className="gap-1">
          <FlatButton onClick={onClose}>Cancel</FlatButton>
          <FlatButton variant="primary" disabled={!label} loading={busy} onClick={() => onImport(changes)}>
            {label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Nothing to change'}
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
  onSave: (input: { name: string; from: string; inject: 'env' | 'placeholder'; hosts?: string[] }) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [from, setFrom] = useState(ORG_SECRETS[0])
  const [inject, setInject] = useState<'env' | 'placeholder'>('env')
  const [hosts, setHosts] = useState('')
  const hostList = hosts
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  const blocked = !NAME_RE.test(name) || (inject === 'placeholder' && hostList.length === 0)
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
            placeholder="STRIPE_KEY"
            className={cn(TEXT_INPUT, 'h-10')}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-muted-foreground">Secret in your org&apos;s store</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)} className={cn(TEXT_INPUT, 'h-10')}>
            {ORG_SECRETS.map((secret) => (
              <option key={secret} value={secret}>
                {secret}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-2" role="radiogroup">
          <span className="text-[13px] text-muted-foreground">How it reaches the app</span>
          {(
            [
              ['env', 'In the environment', 'The process can read the value.'],
              [
                'placeholder',
                'Only on requests to certain hosts',
                'The app holds a placeholder; BoxLite swaps in the real value on the way out.',
              ],
            ] as const
          ).map(([id, label, hint]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={inject === id}
              onClick={() => setInject(id)}
              className={cn(
                'flex flex-col items-start gap-0.5 border px-3 py-2 text-left transition-colors',
                inject === id ? 'border-foreground/50 bg-card' : 'border-border hover:border-foreground/30',
              )}
            >
              <span className="text-foreground">{label}</span>
              <span className="text-[13px] text-muted-foreground">{hint}</span>
            </button>
          ))}
          {inject === 'placeholder' && (
            <input
              value={hosts}
              onChange={(e) => setHosts(e.target.value)}
              placeholder="api.stripe.com, api.openai.com"
              className={cn(TEXT_INPUT, 'h-10')}
            />
          )}
        </div>
        <DialogFooter className="gap-1">
          <FlatButton onClick={onClose}>Cancel</FlatButton>
          <FlatButton
            variant="primary"
            disabled={blocked}
            loading={busy}
            onClick={() => onSave({ name, from, inject, hosts: inject === 'placeholder' ? hostList : undefined })}
          >
            Add reference
          </FlatButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function VariablesTab({ app }: { app: AppDetail }) {
  const { run, pending } = useAppAction(app.id)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'import' | 'secret' | null>(null)

  const secrets: Row[] = app.secrets.map((s) => ({
    name: s.name,
    value: `•••••• from ${s.from} · v${s.version}`,
    kind:
      s.inject === 'env'
        ? 'Secret · in the environment'
        : `Secret · added to requests to ${s.hosts?.join(', ') ?? 'its hosts'}`,
    usedBy: s.usedBy.join(', '),
    secret: true,
  }))
  const plain: Row[] = Object.entries(app.workspace.env).map(([name, value]) => ({
    name,
    value,
    raw: value,
    kind: 'Plain value',
    usedBy: 'All services',
    secret: false,
  }))
  const managed = [
    ...(app.database
      ? [
          {
            name: app.database.injectedAs,
            value: `postgresql://${app.database.user}@${app.database.host}/…`,
            kind: 'Database',
          },
        ]
      : []),
    ...app.storages.map((bucket) => ({
      name: `${bucket.envPrefix}_*`,
      value: `endpoint, bucket and keys for ${bucket.name}`,
      kind: 'Volume',
    })),
    { name: 'BOXLITE_ENV', value: app.environment, kind: 'Environment' },
  ]
  const rows = [...secrets, ...plain]
  // Saved but not yet live: marked on their rows, and removed ones stay listed until deployed.
  const pendingBy = new Map((app.pendingChanges ?? []).map((c) => [c.name, c]))
  const removed = (app.pendingChanges ?? []).filter((c) => c.change === 'removed')

  const save = async (name: string, value: string) => {
    const existed = name in app.workspace.env
    const previous = app.workspace.env[name]
    const ok = await run({ type: 'setVariable', name, value }, `${name} ${existed ? 'changed' : 'added'}`, {
      key: `set:${name}`,
      undo: existed ? { type: 'setVariable', name, value: previous } : { type: 'removeVariable', name },
    })
    if (ok) {
      setAdding(false)
      setEditing(null)
    }
  }

  const revert = (c: PendingChange) => {
    if (c.change === 'added') {
      void run({ type: 'removeVariable', name: c.name }, `${c.name} reverted`, { key: `revert:${c.name}` })
    } else if (c.live !== undefined && !c.secret) {
      void run({ type: 'setVariable', name: c.name, value: c.live }, `${c.name} reverted to its live value`, {
        key: `revert:${c.name}`,
      })
    }
  }

  const remove = (row: Row) =>
    void run({ type: 'removeVariable', name: row.name }, `${row.name} removed`, {
      key: `remove:${row.name}`,
      undo: row.secret ? undefined : { type: 'setVariable', name: row.name, value: row.raw ?? '' },
    })

  return (
    <Screen
      title={`Variables in ${app.environment}`}
      actions={
        <>
          <CopyFrom app={app} />
          <ToolButton onClick={() => setDialog('import')}>Import .env</ToolButton>
          <ToolButton onClick={() => setDialog('secret')}>Reference a secret</ToolButton>
          <ToolButton primary onClick={() => setAdding(true)} disabled={adding}>
            Add variable
          </ToolButton>
        </>
      }
      padded={false}
    >
      <p className="pb-4 font-mono text-[13px] text-muted-foreground">
        Secrets stay in your org&apos;s secret store and are never shown. Saved changes go live when you deploy them.
      </p>
      <GridHeader grid={ENV_GRID} columns={['Name', 'Value', 'How it reaches the app', 'Used by', '']} />
      {adding && (
        <InlineEditor busy={pending?.startsWith('set:') ?? false} onSave={save} onCancel={() => setAdding(false)} />
      )}
      {rows.length === 0 && !adding ? (
        <EmptyNote title="Nothing set">Add a value, paste a .env, or reference a secret from the org store.</EmptyNote>
      ) : (
        rows.map((row) =>
          editing === row.name ? (
            <InlineEditor
              key={row.name}
              initialName={row.name}
              initialValue={row.raw}
              lockName
              busy={pending === `set:${row.name}`}
              onSave={save}
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
                {pendingBy.get(row.name) && (
                  <Tag tone="warn">{pendingBy.get(row.name)?.change === 'added' ? 'Added' : 'Changed'}</Tag>
                )}
              </span>
              <span className="flex min-w-0 flex-col" title={row.secret ? undefined : 'Click to edit'}>
                <span className="truncate text-foreground">{row.value}</span>
                {pendingBy.get(row.name)?.change === 'changed' && (
                  <span className="truncate text-[12px] text-muted-foreground">
                    live:{' '}
                    {pendingBy.get(row.name)?.secret
                      ? `•••••• from ${pendingBy.get(row.name)?.live}`
                      : pendingBy.get(row.name)?.live}
                  </span>
                )}
              </span>
              <span className="truncate text-muted-foreground">{row.kind}</span>
              <span className="truncate text-muted-foreground">{row.usedBy}</span>
              <span onClick={(e) => e.stopPropagation()}>
                <HoverActions>
                  {pendingBy.get(row.name) &&
                  !(pendingBy.get(row.name)?.secret && pendingBy.get(row.name)?.change === 'changed') ? (
                    <ToolButton
                      title="Go back to the value the running deployment uses"
                      loading={pending === `revert:${row.name}`}
                      onClick={() => revert(pendingBy.get(row.name) as PendingChange)}
                    >
                      Revert
                    </ToolButton>
                  ) : (
                    !row.secret && <ToolButton onClick={() => setEditing(row.name)}>Edit</ToolButton>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <MoreButton />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[10rem] font-mono">
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive focus:text-destructive"
                        onClick={() => remove(row)}
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
      {removed.map((c) => (
        <GridRow key={`removed:${c.name}`} grid={ENV_GRID}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold text-muted-foreground line-through">{c.name}</span>
            <Tag tone="warn">Removed</Tag>
          </span>
          <span className="truncate text-[13px] text-muted-foreground">
            live: {c.secret ? `•••••• from ${c.live}` : c.live}
          </span>
          <span className="truncate text-muted-foreground">Still set in the running deployment</span>
          <span />
          <HoverActions>
            {!c.secret && (
              <ToolButton loading={pending === `revert:${c.name}`} onClick={() => revert(c)}>
                Restore
              </ToolButton>
            )}
          </HoverActions>
        </GridRow>
      ))}

      <div className="pt-10">
        <SectionTitle title="Set by BoxLite" />
      </div>
      <GridHeader grid={ENV_GRID} columns={['Name', 'Value', 'Source', '', '']} />
      {managed.map((row) => (
        <GridRow key={row.name} grid={ENV_GRID}>
          <span className="truncate font-semibold text-foreground">{row.name}</span>
          <span className="truncate text-muted-foreground">{row.value}</span>
          <span className="truncate text-muted-foreground">{row.kind}</span>
          <span />
          <span />
        </GridRow>
      ))}

      {dialog === 'import' && (
        <ImportDialog
          existing={app.workspace.env}
          secrets={app.secrets.map((secret) => secret.name)}
          pendingChanges={app.pendingChanges ?? []}
          busy={pending === 'importVariables'}
          onClose={() => setDialog(null)}
          onImport={async (values) => {
            if (
              await run(
                { type: 'importVariables', values },
                `Imported ${Object.keys(values).length} ${Object.keys(values).length === 1 ? 'variable' : 'variables'}`,
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
            if (await run({ type: 'referenceSecret', ...input }, `${input.name} references ${input.from}`))
              setDialog(null)
          }}
        />
      )}
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
          {app.environment}&apos;s plain values and secret references are replaced with {from}&apos;s. Secret values
          themselves stay in the org store. Nothing goes live until you deploy.
        </>
      ),
      confirmLabel: `Copy from ${from}`,
    })
    if (!ok) return
    try {
      await mutation.mutateAsync({ kind: 'copyVariables', appId: app.id, from })
      toast.success(`Copied from ${from}`)
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
