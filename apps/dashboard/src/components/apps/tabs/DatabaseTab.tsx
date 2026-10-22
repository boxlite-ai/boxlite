/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useAppSql, useRestoreDatabase } from '@/hooks/mutations/useAppMutations'
import { useAppDatabase, useTableRows } from '@/hooks/queries/useAppsQuery'
import { formatBytes, relTime, STATUS } from '@/lib/apps/format'
import type { AppDatabaseDetail, AppDetail, AppTable, QueryResult } from '@/lib/apps/types'
import { downloadUrl, errorBody, errorText } from '@/lib/apps/client'
import {
  isDdlKind,
  isWriteKind,
  lineAndColumn,
  loadHistory,
  nextMigrationFile,
  saveHistory,
  statementKinds,
} from '@/lib/apps/sql'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useConfirm } from '../confirm'
import { useAppAction } from '../useAppAction'
import {
  CopyIconButton,
  downloadCsv,
  EmptyNote,
  GridHeader,
  GridRow,
  HoverActions,
  Panel,
  SearchField,
  PromptBlock,
  SpecRow,
  StatusBadge,
} from '../spec'
import { FilterChip, Screen, ToolButton, Workbench } from '../SubNav'

// The environment's Postgres (a Neon branch), read through the control plane:
// its tables, a SQL console (read-only unless a write is confirmed; schema
// changes on main go through migrations), migration history from
// boxlite_migrations, backups (named restore points) and the connection the app
// is given. The password is never shown: the app receives it as DATABASE_URL.

type Section = 'tables' | 'sql' | 'migrations' | 'backups' | 'connection'
const SECTION_IDS: Section[] = ['tables', 'sql', 'migrations', 'backups', 'connection']

const asText = (rows: QueryResult['rows']) => rows.map((row) => row.map((cell) => (cell === null ? '' : String(cell))))

/** A download streamed by the control plane (whole table as CSV, or the database as a SQL dump). */
const exportUrl = (app: AppDetail, query: Record<string, string>) =>
  downloadUrl(
    `/apps/${encodeURIComponent(app.id)}/database/export?${new URLSearchParams({ env: app.environment, ...query })}`,
  )

/** An anchor that looks like a ToolButton, for downloads the browser saves itself. */
const DOWNLOAD_LINK =
  'inline-flex h-[28px] items-center border border-border px-[10px] font-mono text-[12px] text-muted-foreground transition-colors hover:border-brand hover:text-foreground'

const looksJson = (text: string) => /^[[{]/.test(text) && /[\]}]$/.test(text)

/** NULL is shown as such; JSON is collapsed to one line and opens in full on click. */
function Cell({ value }: { value: QueryResult['rows'][number][number] }) {
  const [open, setOpen] = useState(false)
  if (value === null) return <span className="italic text-muted-foreground/60">NULL</span>
  const text = String(value)
  if (typeof value === 'string' && looksJson(text) && text.length > 40) {
    return open ? (
      <button type="button" onClick={() => setOpen(false)} className="text-left">
        <pre className="max-w-[480px] whitespace-pre-wrap break-words text-[12px] text-foreground">
          {(() => {
            try {
              return JSON.stringify(JSON.parse(text), null, 2)
            } catch {
              return text
            }
          })()}
        </pre>
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="max-w-[320px] truncate text-left text-brand"
        title="Show JSON"
      >
        {text}
      </button>
    )
  }
  return <>{text}</>
}

function NoDatabase({ app }: { app: AppDetail }) {
  return (
    <Screen title="Database">
      <EmptyNote
        title="No database yet"
        action={
          <div className="w-full max-w-[640px] text-left">
            <PromptBlock
              text={
                '[database]\nmigrations = "migrations/"\n\n# schema in migrations/0001_init.sql, then: boxlite-app apply'
              }
              compact
            />
          </div>
        }
      >
        Add [database] to boxlite.toml and run boxlite-app apply. The control plane creates a Postgres branch for{' '}
        {app.environment} and gives the app its connection string as DATABASE_URL.
      </EmptyNote>
    </Screen>
  )
}

function Connection({ app, db }: { app: AppDetail; db: AppDatabaseDetail }) {
  const connection = `postgresql://${db.user}@${db.host}/${db.name}?sslmode=require`
  const statusColor = db.status === 'ready' ? STATUS.running : STATUS.idle
  return (
    <Screen
      title="Connection"
      actions={
        <a
          href={exportUrl(app, { format: 'sql' })}
          download
          title="Schema and data of every table, as SQL"
          className={DOWNLOAD_LINK}
        >
          Download dump
        </a>
      }
    >
      <div className="flex flex-col gap-3">
        <Panel>
          <div className="mb-4 flex items-center gap-3">
            <StatusBadge label={db.status === 'ready' ? 'Ready' : 'Unknown'} color={statusColor} />
            <span className="text-muted-foreground">
              {db.sizeBytes != null && <>· {formatBytes(db.sizeBytes)} </>}
              {db.tables && <>· {db.tables.length} tables </>}
              {db.backups?.[0] && <>· last backup {relTime(db.backups[0].ts)}</>}
            </span>
          </div>
          <SpecRow label="Connection string">
            <span className="inline-flex max-w-full items-center gap-2">
              <span className="min-w-0 truncate" title={connection}>
                {connection}
              </span>
              <CopyIconButton text={connection} />
            </span>
          </SpecRow>
          <SpecRow label="Password">not shown · the app receives it inside DATABASE_URL</SpecRow>
          <SpecRow label="Injected as">
            {app.database?.injectedAs ?? 'DATABASE_URL'} →{' '}
            {app.database?.injectedInto.length ? app.database.injectedInto.join(', ') : 'no service yet'}
          </SpecRow>
          <SpecRow label="Engine">{db.engine}</SpecRow>
          {db.branch && <SpecRow label="Branch">{db.branch}</SpecRow>}
        </Panel>
        <div className="flex flex-col gap-2 text-[12px] text-muted-foreground">
          <span>To work against this database from a laptop, your agent runs:</span>
          <PromptBlock
            text={`boxlite-app app dev${app.environment === 'main' ? '' : ` --env ${app.environment}`}`}
            compact
          />
          <span>
            It runs the services locally with DATABASE_URL pointing at a local proxy, so no password is written
            anywhere. For psql or an ORM: boxlite-app app db proxy (read-only unless --write). For one-off queries:
            boxlite-app app sql &quot;select …&quot;.
          </span>
        </div>
      </div>
    </Screen>
  )
}

function Tables({ app, db, onQuery }: { app: AppDetail; db: AppDatabaseDetail; onQuery: (query: string) => void }) {
  const GRID = 'grid-cols-[minmax(0,1fr)_110px_280px_100px] gap-x-6'
  const [browsing, setBrowsing] = useState<AppTable | null>(null)
  const tables = db.tables ?? []
  return (
    <Screen title="Tables" padded={false}>
      {db.tables === null ? (
        <EmptyNote title="Tables could not be read">{db.errors?.join(' · ')}</EmptyNote>
      ) : tables.length === 0 ? (
        <EmptyNote
          title="No tables yet"
          action={
            <div className="w-full max-w-[560px] text-left">
              <PromptBlock
                text={
                  '# migrations/0001_init.sql\ncreate table items (id serial primary key, title text not null);\n\n# then: boxlite-app deploy'
                }
                compact
              />
            </div>
          }
        >
          Tables come from migrations, applied on deploy in file order, one transaction each.
        </EmptyNote>
      ) : (
        <>
          <GridHeader
            grid={GRID}
            columns={[
              'Table',
              <span key="rows" className="block text-right">
                Rows
              </span>,
              'Schema',
              '',
            ]}
          />
          {tables.map((table) => (
            <GridRow key={`${table.schema}.${table.name}`} grid={GRID} onClick={() => setBrowsing(table)}>
              <span className="truncate text-foreground">{table.name}</span>
              <span className="text-right tabular-nums text-foreground">
                {table.rows === null ? '—' : table.rows.toLocaleString('en-US')}
              </span>
              <span className="truncate whitespace-nowrap text-muted-foreground">
                {table.schema}
                {table.name === 'boxlite_migrations' && <span className="ml-2">· managed by BoxLite</span>}
              </span>
              <HoverActions>
                <ToolButton onClick={() => setBrowsing(table)}>Browse</ToolButton>
              </HoverActions>
            </GridRow>
          ))}
        </>
      )}
      {browsing && <TableSheet app={app} table={browsing} onQuery={onQuery} onClose={() => setBrowsing(null)} />}
    </Screen>
  )
}

const SNIPPETS: { label: string; sql: string }[] = [
  {
    label: 'Table sizes',
    sql: "select relname, n_live_tup from pg_stat_user_tables where schemaname = 'public' order by n_live_tup desc",
  },
  { label: 'Migrations', sql: 'select file, deployment, applied_at from boxlite_migrations order by file' },
  {
    label: 'Columns',
    sql: "select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position",
  },
]

function Sql({ app, db, initial }: { app: AppDetail; db: AppDatabaseDetail; initial?: string | null }) {
  const sql = useAppSql()
  const [confirm, confirmElement] = useConfirm()
  const [query, setQuery] = useState(initial ?? SNIPPETS[0].sql)
  const [history, setHistory] = useState<string[]>(() => loadHistory(app.id, app.environment))
  const [error, setError] = useState<string | null>(null)
  // The text that produced the results below; once the editor differs, they are marked as earlier.
  const [ran, setRan] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const kinds = statementKinds(query)
  const writes = kinds.filter(isWriteKind)
  const ddl = kinds.filter(isDdlKind)
  const isWrite = writes.length > 0
  const lines = Math.max(query.split('\n').length, 6)
  const migration = nextMigrationFile((db.migrations ?? []).map((m) => m.file))

  const remember = (q: string) => {
    const next = [q, ...history.filter((h) => h !== q)].slice(0, 10)
    setHistory(next)
    saveHistory(app.id, app.environment, next)
  }

  const execute = async (opts: { explain?: boolean; write?: boolean }) => {
    setError(null)
    try {
      await sql.mutateAsync({ appId: app.id, query, ...opts })
      setRan(query)
      if (!opts.explain) remember(query)
    } catch (err) {
      const position = Number(errorBody(err)?.position)
      const where = Number.isInteger(position) && position > 0 ? lineAndColumn(query, position) : null
      setError(`${errorText(err)}${where ? ` (line ${where.line}, column ${where.column})` : ''}`)
      setRan(query)
    }
  }

  const run = async () => {
    if (!query.trim()) return
    // The control plane refuses schema changes on main; say so, with the migration to write, before sending.
    if (ddl.length > 0 && app.environment === 'main') {
      setRan(query)
      setError(
        `${ddl.join(', ')} changes the schema, which main only takes through a migration. Next: put it in migrations/${migration} and run boxlite-app deploy (or try it on another environment first).`,
      )
      return
    }
    if (isWrite) {
      const named = [...new Set(writes)].join(', ')
      const ok = await confirm({
        title: `Run ${named} on ${app.environment}?`,
        body: (
          <>
            {kinds.length > 1 ? `${kinds.length} statements run in one transaction and commit together. ` : ''}
            This changes {app.environment}&apos;s data and commits. Take a backup first (Backups) if you may want it
            undone.
          </>
        ),
        confirmLabel: `Run ${named}`,
        danger: true,
      })
      if (!ok) return
    }
    await execute({ write: isWrite })
  }

  useEffect(() => {
    ref.current?.focus()
    // Arriving from a table's panel: show its rows straight away.
    if (initial) void run()
  }, [])

  const data = sql.data
  return (
    <Screen
      title="SQL console"
      actions={
        <>
          <ToolButton
            title="Show the plan without running the query"
            disabled={sql.isPending || !query.trim()}
            onClick={() => void execute({ explain: true })}
          >
            Explain
          </ToolButton>
          <ToolButton
            primary={!isWrite}
            danger={isWrite}
            onClick={() => void run()}
            disabled={sql.isPending || !query.trim()}
            title="⌘⏎"
          >
            {sql.isPending ? 'Running…' : isWrite ? `Run ${writes[0]} ⌘⏎` : 'Run query ⌘⏎'}
          </ToolButton>
        </>
      }
      padded={false}
    >
      <div className="flex flex-wrap items-center gap-1 pb-3">
        <span className="mr-2 text-[10px] uppercase tracking-[1px] text-muted-foreground">Snippets</span>
        {SNIPPETS.map((snippet) => (
          <FilterChip key={snippet.label} selected={query === snippet.sql} onClick={() => setQuery(snippet.sql)}>
            {snippet.label}
          </FilterChip>
        ))}
        {history.length > 0 && (
          <>
            <span className="ml-4 mr-2 text-[10px] uppercase tracking-[1px] text-muted-foreground">Recent</span>
            {history.map((q, i) => (
              <FilterChip key={i} onClick={() => setQuery(q)} title={q}>
                {q.length > 28 ? `${q.slice(0, 28)}…` : q}
              </FilterChip>
            ))}
          </>
        )}
      </div>

      <div className="grid grid-cols-[44px_minmax(0,1fr)] border border-border bg-background">
        <div className="select-none border-r border-border/60 py-3 text-right text-[12px] leading-[20px] text-muted-foreground/60">
          {Array.from({ length: lines }).map((_, i) => (
            <div key={i} className="pr-2">
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={ref}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void run()
            }
          }}
          spellCheck={false}
          rows={lines}
          className="resize-none bg-transparent px-3 py-3 font-mono text-[13px] leading-[20px] text-foreground outline-none"
        />
      </div>

      <div className="flex h-10 items-center gap-3 text-[12px] text-muted-foreground">
        <span className="text-[11px] uppercase tracking-[2px] text-foreground">
          <span className="text-brand">▸</span> Results
        </span>
        {error ? (
          <span className="text-destructive">Failed</span>
        ) : data ? (
          <>
            {ran && ran !== query && (
              <span className="max-w-[360px] truncate text-warning" title={ran}>
                of an earlier query: {ran.replace(/\s+/g, ' ')}
              </span>
            )}
            {data.columns.length === 0 ? (
              <span className="text-foreground" data-testid="sql-affected">
                {data.row_count ?? 0} {data.row_count === 1 ? 'row' : 'rows'} affected · committed
              </span>
            ) : (
              <>
                <span className="text-foreground">
                  {data.rows.length} rows{data.truncated ? ' (first 1000)' : ''}
                </span>
                <span>· {data.columns.length} columns</span>
              </>
            )}
            {data.elapsed_ms !== undefined && <span>· {data.elapsed_ms} ms</span>}
            <span className="ml-auto flex items-center gap-2">
              <ToolButton onClick={() => downloadCsv(`${app.name}-query.csv`, data.columns, asText(data.rows))}>
                Export CSV
              </ToolButton>
              <CopyIconButton text={JSON.stringify(data.rows)} title="Copy as JSON" />
            </span>
          </>
        ) : (
          <span>{sql.isPending ? 'Running…' : 'Read-only unless you run a write. Run a query to see results.'}</span>
        )}
      </div>
      {error && (
        <p
          className="whitespace-pre-wrap border border-destructive/40 bg-destructive/[0.04] px-3 py-2 text-[13px] text-destructive"
          data-testid="sql-error"
        >
          {error}
        </p>
      )}
      {data && !error && data.columns.length > 0 && (
        <div className={cn('overflow-x-auto transition-opacity', ran && ran !== query && 'opacity-50')}>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border text-[12px] text-muted-foreground">
                <th className="w-[44px] px-3 py-2 font-normal">#</th>
                {data.columns.map((column, i) => (
                  <th key={`${column}-${i}`} className="px-3 py-2 font-normal">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i} className="border-b border-border/60 hover:bg-card/50">
                  <td className="px-3 py-[6px] text-muted-foreground/60">{i + 1}</td>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={cn(
                        'whitespace-pre px-3 py-[6px] text-foreground',
                        typeof cell === 'number' && 'tabular-nums',
                      )}
                    >
                      <Cell value={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirmElement}
    </Screen>
  )
}

function Migrations({ db, onOpenDeployment }: { db: AppDatabaseDetail; onOpenDeployment: (n: number) => void }) {
  const GRID = 'grid-cols-[minmax(0,1fr)_110px_120px_120px] gap-x-3'
  const migrations = db.migrations ?? []
  return (
    <Screen title="Migrations" padded={false}>
      {db.migrations === null ? (
        <EmptyNote title="Migrations could not be read">{db.errors?.join(' · ')}</EmptyNote>
      ) : migrations.length === 0 ? (
        <EmptyNote
          title="No migrations applied"
          action={
            <div className="w-full max-w-[560px] text-left">
              <PromptBlock
                text={'boxlite-app app db migration new init   # writes migrations/0001_init.sql\nboxlite-app deploy'}
                compact
              />
            </div>
          }
        >
          Each file under migrations/ runs once, in file order, on the next deploy. Applied files never change.
        </EmptyNote>
      ) : (
        <>
          <GridHeader grid={GRID} columns={['File', 'Deployment', 'Applied', 'Status']} />
          {migrations.map((migration) => (
            <GridRow key={migration.file} grid={GRID}>
              <span className="truncate text-foreground">{migration.file}</span>
              <span className="text-muted-foreground">
                {migration.deployment != null ? (
                  <button
                    type="button"
                    className="underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => migration.deployment != null && onOpenDeployment(migration.deployment)}
                  >
                    #{migration.deployment}
                  </button>
                ) : (
                  '—'
                )}
              </span>
              <span className="text-muted-foreground">
                {migration.applied_at ? relTime(migration.applied_at) : '—'}
              </span>
              <StatusBadge
                label={
                  migration.status === 'applied' ? 'Applied' : migration.status === 'pending' ? 'Pending' : 'Changed'
                }
                color={
                  migration.status === 'applied'
                    ? STATUS.running
                    : migration.status === 'pending'
                      ? STATUS.idle
                      : STATUS.error
                }
                caps
                className="justify-self-end"
              />
            </GridRow>
          ))}
        </>
      )}
    </Screen>
  )
}

function Backups({ app, db }: { app: AppDetail; db: AppDatabaseDetail }) {
  const GRID = 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_220px] gap-x-3'
  const { run, pending } = useAppAction(app.id)
  const restoreDb = useRestoreDatabase()
  const [confirm, confirmElement] = useConfirm()
  const [restoring, setRestoring] = useState<string | null>(null)
  const backups = db.backups ?? []
  const windowHours = db.restoreWindowHours ?? 6
  // Restoring rewinds the Neon branch through its history, which only reaches this far back.
  const restorable = (ts: string) => Date.now() - Date.parse(ts) < windowHours * 3_600_000
  const restore = async (id: string, at: string) => {
    const when = new Date(at).toLocaleString()
    const ok = await confirm({
      title: `Restore ${app.environment}'s database to ${when}?`,
      body: (
        <>
          Every row written in {app.environment} since then is replaced by the state at that time. Code, files and other
          environments are not touched. The current state is kept as a separate Neon branch, so this can be undone.
        </>
      ),
      confirmLabel: 'Restore',
      danger: true,
      typeToConfirm: app.environment,
    })
    if (!ok) return
    setRestoring(id)
    try {
      const out = await restoreDb.mutateAsync({ appId: app.id, snapshot: id })
      toast.success(`${app.environment} restored to ${when}`, {
        description: `The previous state is kept as ${out.preserved_as}`,
      })
    } catch (error) {
      handleApiError(error, 'Restore failed')
    } finally {
      setRestoring(null)
    }
  }
  return (
    <Screen
      title="Backups"
      actions={
        <ToolButton
          loading={pending === 'createBackup'}
          onClick={() => void run({ type: 'createBackup' }, `Backed up ${app.environment}'s database`)}
        >
          Back up now
        </ToolButton>
      }
      padded={false}
    >
      <p className="pb-3 text-[12px] text-muted-foreground" data-testid="restore-window">
        A backup names a point in the database&apos;s history; restoring rewinds {app.environment}&apos;s Neon branch to
        it. Neon keeps {windowHours} hours of history on this plan, so a backup can be restored for {windowHours} hours
        after it was taken. Every deployment that runs migrations records its own restore point too.
      </p>
      {db.backups === null ? (
        <EmptyNote title="Backups could not be read">{db.errors?.join(' · ')}</EmptyNote>
      ) : backups.length === 0 ? (
        <EmptyNote title="No backups yet">Take one now; it takes a moment.</EmptyNote>
      ) : (
        <>
          <GridHeader grid={GRID} columns={['Taken', 'Note', 'By', '']} />
          {backups.map((backup) => (
            <GridRow key={backup.id} grid={GRID}>
              <span className="text-foreground" title={backup.ts}>
                {new Date(backup.ts).toLocaleString()}
              </span>
              <span className="truncate text-muted-foreground">{backup.message ?? '—'}</span>
              <span className="text-muted-foreground">{backup.by}</span>
              <HoverActions className={restoring === backup.id ? 'opacity-100' : undefined}>
                {restorable(backup.ts) ? (
                  <ToolButton loading={restoring === backup.id} onClick={() => void restore(backup.id, backup.ts)}>
                    Restore to {app.environment}
                  </ToolButton>
                ) : (
                  <span
                    className="text-[12px] text-muted-foreground"
                    title={`Older than Neon's ${windowHours}-hour history`}
                  >
                    outside the {windowHours} h window
                  </span>
                )}
              </HoverActions>
            </GridRow>
          ))}
        </>
      )}
      {confirmElement}
    </Screen>
  )
}

/** Rows of one table in a side panel, so browsing does not lose the list. Paging and search run in the database. */
function TableSheet({
  app,
  table,
  onQuery,
  onClose,
}: {
  app: AppDetail
  table: AppTable
  onQuery: (query: string) => void
  onClose: () => void
}) {
  const PAGE = 20
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState('')
  const [needle, setNeedle] = useState('')
  // Typing filters after a short pause, server-side, across the whole table.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setNeedle(filter.trim())
      setPage(0)
    }, 250)
    return () => window.clearTimeout(id)
  }, [filter])
  const { data, isFetching, error } = useTableRows(app.id, table.name, needle, PAGE, page * PAGE)
  const ident = `"${table.name.replace(/"/g, '""')}"`
  const where = needle ? ` where ${ident}::text ilike '%${needle.replace(/'/g, "''")}%'` : ''
  const total = data?.total ?? 0
  const from = total === 0 ? 0 : page * PAGE + 1
  const to = Math.min(total, (page + 1) * PAGE)
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[760px] max-w-[90vw] gap-4 p-6 font-mono sm:max-w-[760px]"
      >
        <SheetHeader>
          <SheetTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">
            {table.schema}.{table.name}
          </SheetTitle>
        </SheetHeader>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <SearchField value={filter} onChange={setFilter} placeholder={`Search ${table.name}…`} />
          <span className="ml-auto flex gap-1">
            <ToolButton
              onClick={() => {
                onClose()
                onQuery(`select *\nfrom ${table.schema}.${ident}${where}\nlimit 100;`)
              }}
            >
              Query in SQL console
            </ToolButton>
            <a
              href={exportUrl(app, { table: table.name, format: 'csv' })}
              download
              title={`Every row of ${table.name}, not only this page`}
              className={DOWNLOAD_LINK}
            >
              Export CSV
            </a>
          </span>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>
            {!data
              ? ''
              : total === 0
                ? 'No rows match'
                : `Rows ${from}–${to} of ${total.toLocaleString('en-US')}${needle ? ' matching' : ''} · ${app.environment}`}
          </span>
          <span className="ml-auto flex gap-1">
            <ToolButton disabled={page === 0 || isFetching} onClick={() => setPage((p) => p - 1)}>
              ← Previous
            </ToolButton>
            <ToolButton disabled={to >= total || isFetching} onClick={() => setPage((p) => p + 1)}>
              Next →
            </ToolButton>
          </span>
        </div>
        {error ? (
          <div className="py-6 text-[13px] text-destructive">
            {error instanceof Error ? error.message : String(error)}
          </div>
        ) : !data ? (
          <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
            <Spinner className="size-4" /> Loading rows…
          </div>
        ) : (
          <div className={cn('overflow-auto transition-opacity', isFetching && 'opacity-50')}>
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-border text-[12px] text-muted-foreground">
                  {data.columns.map((column, i) => (
                    <th key={`${column}-${i}`} className="whitespace-nowrap px-3 py-2 font-normal">
                      <span className="block text-foreground">{column}</span>
                      {data.types?.[i] && (
                        <span className="block text-[10px] text-muted-foreground">{data.types[i]}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={i} className="border-b border-border/60 hover:bg-card/50">
                    {row.map((cell, j) => (
                      <td
                        key={j}
                        className={cn(
                          'whitespace-nowrap px-3 py-[7px] text-foreground',
                          typeof cell === 'number' && 'tabular-nums',
                        )}
                      >
                        <Cell value={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

export function DatabaseTab({
  app,
  section,
  onSection,
  onOpenDeployment,
}: {
  app: AppDetail
  section?: string
  onSection: (next: Section) => void
  onOpenDeployment: (n: number) => void
}) {
  const { data: db, isLoading, error } = useAppDatabase(app.id, !!app.database)
  const current: Section = SECTION_IDS.includes(section as Section) ? (section as Section) : 'tables'
  // A query handed over from another screen (a table's panel) opens in the console.
  const [draft, setDraft] = useState<string | null>(null)
  if (!app.database || db?.status === 'none') {
    return (
      <Workbench<Section> items={[]} value="tables" onChange={onSection}>
        <NoDatabase app={app} />
      </Workbench>
    )
  }
  if (isLoading || !db) {
    return (
      <Screen title="Database">
        {error ? (
          <EmptyNote title="The database could not be reached">
            {error instanceof Error ? error.message : String(error)}
          </EmptyNote>
        ) : (
          <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
            <Spinner className="size-4" /> Connecting to the database (a sleeping Neon compute takes a few seconds)…
          </div>
        )}
      </Screen>
    )
  }
  return (
    <Workbench<Section>
      items={[
        { id: 'tables', label: 'Tables', count: db.tables?.length },
        { id: 'sql', label: 'SQL console' },
        { id: 'migrations', label: 'Migrations', count: db.migrations?.length },
        { id: 'backups', label: 'Backups', count: db.backups?.length },
        { id: 'connection', label: 'Connection' },
      ]}
      value={current}
      onChange={onSection}
    >
      {current === 'tables' ? (
        <Tables
          app={app}
          db={db}
          onQuery={(query) => {
            setDraft(query)
            onSection('sql')
          }}
        />
      ) : current === 'sql' ? (
        <Sql key={draft ?? 'blank'} app={app} db={db} initial={draft} />
      ) : current === 'migrations' ? (
        <Migrations db={db} onOpenDeployment={onOpenDeployment} />
      ) : current === 'backups' ? (
        <Backups app={app} db={db} />
      ) : (
        <Connection app={app} db={db} />
      )}
    </Workbench>
  )
}
