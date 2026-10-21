/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useAppSql } from '@/hooks/mutations/useAppMutations'
import { formatBytes, relTime, STATUS } from '@/lib/apps/format'
import type { AppDatabase, AppDetail } from '@/lib/apps/types'
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

// The app's database: its tables, a SQL console, migration history, backups,
// and the connection the app is given. Volumes are their own tab.

type Section = 'tables' | 'sql' | 'migrations' | 'backups' | 'connection'
const SECTION_IDS: Section[] = ['tables', 'sql', 'migrations', 'backups', 'connection']

function NoDatabase({ app }: { app: AppDetail }) {
  const { run, pending } = useAppAction(app.id)
  return (
    <Screen title="Database">
      <EmptyNote
        title="No database attached"
        action={
          <div className="flex w-full max-w-[640px] flex-col items-center gap-3">
            <PromptBlock
              text={`Attach a managed database to BoxLite app "${app.name}" with \`boxlite app add database ${app.name}\`, then add migrations/ and deploy.`}
              compact
            />
            <ToolButton
              primary
              loading={pending === 'attachDatabase'}
              onClick={() => void run({ type: 'attachDatabase' }, `Postgres attached to ${app.environment}`)}
            >
              Attach a database
            </ToolButton>
          </div>
        }
      >
        Your agent runs <span className="text-foreground">boxlite app add database {app.name}</span>. The connection
        string is injected as DATABASE_URL and the endpoint is allow-listed for this box.
      </EmptyNote>
    </Screen>
  )
}

function Database({ app, db }: { app: AppDetail; db: AppDatabase }) {
  const { run, pending } = useAppAction(app.id)
  const [confirm, confirmElement] = useConfirm()
  const rotate = async () => {
    const ok = await confirm({
      title: `Rotate ${app.environment}'s database password?`,
      body: (
        <>
          A new password is injected as {db.injectedAs} on the next restart. The old one keeps working for 10 minutes,
          so running services are not cut off.
        </>
      ),
      confirmLabel: 'Rotate password',
    })
    if (ok) void run({ type: 'rotateDatabasePassword' }, 'Password rotated; the old one stops working in 10 minutes')
  }
  const dump = () =>
    toast.promise(new Promise((resolve) => setTimeout(resolve, 1400)), {
      loading: `Preparing a dump of ${db.name}…`,
      success: () => {
        const url = URL.createObjectURL(new Blob([`-- pg_dump of ${db.name} (mock)\n`], { type: 'application/sql' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `${app.name}-${app.environment}.sql`
        link.click()
        URL.revokeObjectURL(url)
        return `Downloaded ${app.name}-${app.environment}.sql`
      },
      error: 'The dump failed',
    })
  const [revealed, setRevealed] = useState(false)
  const connection = `postgresql://${db.user}:${revealed ? 'mock-password-9f3k' : '••••••••'}@${db.host}:5432/${db.name}`
  const statusColor = db.status === 'ready' ? STATUS.running : db.status === 'error' ? STATUS.error : STATUS.idle
  return (
    <Screen
      title="Connection"
      actions={
        <>
          <ToolButton onClick={() => void rotate()} loading={pending === 'rotateDatabasePassword'}>
            Rotate password
          </ToolButton>
          <ToolButton onClick={dump}>Download pg_dump</ToolButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Panel>
          <div className="mb-4 flex items-center gap-3">
            <StatusBadge label={db.status.charAt(0).toUpperCase() + db.status.slice(1)} color={statusColor} />
            <span className="text-muted-foreground">
              · {formatBytes(db.sizeBytes)} · {db.tables.length} tables · last backup{' '}
              {db.backups[0] ? relTime(db.backups[0].at) : 'tonight'}
            </span>
          </div>
          <SpecRow label="Connection string">
            <span className="inline-flex max-w-full items-center gap-2">
              <span className="min-w-0 truncate" title={connection}>
                {connection}
              </span>
              <button
                type="button"
                onClick={() => setRevealed((v) => !v)}
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                {revealed ? 'Hide' : 'Reveal'}
              </button>
              <CopyIconButton text={connection} />
            </span>
          </SpecRow>
          <SpecRow label="Injected as">
            {db.injectedAs} → {db.injectedInto.length ? db.injectedInto.join(', ') : 'no service yet'}
          </SpecRow>
          <SpecRow label="Reachable from">
            {db.host}:5432 allow-listed for {app.workspace.boxName}
          </SpecRow>
          <SpecRow label="Isolation">one database per app · owner role {db.user}</SpecRow>
        </Panel>
        <p className="text-[12px] text-muted-foreground">
          Rotating the password keeps the old one valid for 10 minutes, so a running app is not cut off.
        </p>
      </div>
      {confirmElement}
    </Screen>
  )
}

function Tables({ app, db, onQuery }: { app: AppDetail; db: AppDatabase; onQuery: (query: string) => void }) {
  const GRID = 'grid-cols-[minmax(0,1fr)_110px_280px_100px] gap-x-6'
  const [browsing, setBrowsing] = useState<AppDatabase['tables'][number] | null>(null)
  return (
    <Screen title="Tables" padded={false}>
      {db.tables.length === 0 ? (
        <EmptyNote title="No tables yet">Migrations run on deploy, in file order, one transaction each.</EmptyNote>
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
          {db.tables.map((table) => (
            <GridRow key={`${table.schema}.${table.name}`} grid={GRID} onClick={() => setBrowsing(table)}>
              <span className="truncate text-foreground">{table.name}</span>
              <span className="text-right tabular-nums text-foreground">{table.rows.toLocaleString('en-US')}</span>
              <span className="truncate whitespace-nowrap text-muted-foreground">
                {table.schema}
                {table.schema === 'boxlite' && <span className="ml-2">· managed by BoxLite</span>}
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
  { label: 'Count users', sql: 'select count(*) from boxlite.users' },
  {
    label: 'Recent users',
    sql: 'select email, provider, last_seen from boxlite.users order by last_seen desc limit 20',
  },
  {
    label: 'Table sizes',
    sql: 'select schemaname, relname, n_live_tup from pg_stat_user_tables order by n_live_tup desc',
  },
]

function Sql({ app, initial }: { app: AppDetail; initial?: string | null }) {
  const sql = useAppSql()
  const [query, setQuery] = useState(initial ?? SNIPPETS[0].sql)
  const [history, setHistory] = useState<string[]>([])
  const [elapsed, setElapsed] = useState<number | null>(null)
  // The text that produced the results below; once the editor differs, they are marked as earlier.
  const [ran, setRan] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const isWrite = /^\s*(insert|update|delete|drop|alter|create|truncate)/i.test(query)
  const lines = Math.max(query.split('\n').length, 6)

  const explain = async () => {
    const started = performance.now()
    await sql.mutateAsync({ appId: app.id, query: `explain ${query}` }).catch(() => undefined)
    setElapsed(Math.round(performance.now() - started))
    setRan(`explain ${query}`)
  }

  const run = async () => {
    if (!query.trim()) return
    const started = performance.now()
    await sql.mutateAsync({ appId: app.id, query }).catch(() => undefined)
    setElapsed(Math.round(performance.now() - started))
    setRan(query)
    setHistory((h) => [query, ...h.filter((q) => q !== query)].slice(0, 5))
  }

  useEffect(() => {
    ref.current?.focus()
    // Arriving from a table's panel: show its rows straight away.
    if (initial) void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Screen
      title="SQL console"
      actions={
        <>
          <ToolButton
            title="Show the plan without running the query"
            disabled={sql.isPending || !query.trim()}
            onClick={() => void explain()}
          >
            Explain
          </ToolButton>
          <ToolButton
            primary={!isWrite}
            danger={isWrite}
            onClick={run}
            disabled={sql.isPending || !query.trim()}
            title="⌘⏎"
          >
            {sql.isPending ? 'Running…' : isWrite ? 'Run write query ⌘⏎' : 'Run query ⌘⏎'}
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
        {sql.data ? (
          <>
            {ran && ran.replace(/^explain /, '') !== query && (
              <span className="max-w-[360px] truncate text-warning" title={ran}>
                of an earlier query: {ran.replace(/\s+/g, ' ')}
              </span>
            )}
            <span className="text-foreground">{sql.data.rows.length} rows</span>
            <span>· {elapsed ?? 0} ms</span>
            <span>· {sql.data.columns.length} columns</span>
            <span className="ml-auto flex items-center gap-2">
              <ToolButton
                onClick={() => sql.data && downloadCsv(`${app.name}-query.csv`, sql.data.columns, sql.data.rows)}
              >
                Export CSV
              </ToolButton>
              <CopyIconButton text={JSON.stringify(sql.data.rows)} title="Copy as JSON" />
            </span>
          </>
        ) : (
          <span>{sql.isPending ? 'Running…' : 'Run a query to see results'}</span>
        )}
      </div>
      {sql.data && (
        <div
          className={cn(
            'overflow-x-auto transition-opacity',
            ran && ran.replace(/^explain /, '') !== query && 'opacity-50',
          )}
        >
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border text-[12px] text-muted-foreground">
                <th className="w-[44px] px-3 py-2 font-normal">#</th>
                {sql.data.columns.map((column) => (
                  <th key={column} className="px-3 py-2 font-normal">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sql.data.rows.map((row, i) => (
                <tr key={i} className="border-b border-border/60 hover:bg-card/50">
                  <td className="px-3 py-[6px] text-muted-foreground/60">{i + 1}</td>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={cn('px-3 py-[6px] text-foreground', typeof cell === 'number' && 'tabular-nums')}
                    >
                      {String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Screen>
  )
}

function Migrations({ app, db }: { app: AppDetail; db: AppDatabase }) {
  const GRID = 'grid-cols-[minmax(0,1fr)_110px_120px_120px] gap-x-3'
  return (
    <Screen title="Migrations" padded={false}>
      {db.migrations.length === 0 ? (
        <EmptyNote title="No migrations applied">
          Put SQL files under migrations/; the next deploy applies the new ones in file order.
        </EmptyNote>
      ) : (
        <>
          <GridHeader grid={GRID} columns={['File', 'Deployment', 'Applied', 'Status']} />
          {db.migrations.map((migration) => (
            <GridRow key={migration.file} grid={GRID}>
              <span className="truncate text-foreground">{migration.file}</span>
              <span className="text-muted-foreground">{migration.appliedIn}</span>
              <span className="text-muted-foreground">{relTime(migration.at)}</span>
              <StatusBadge label="Applied" color={STATUS.running} caps className="justify-self-end" />
            </GridRow>
          ))}
        </>
      )}
    </Screen>
  )
}

function Backups({ app, db }: { app: AppDetail; db: AppDatabase }) {
  const GRID = 'grid-cols-[minmax(0,1fr)_120px_120px_220px] gap-x-3'
  const { run, pending } = useAppAction(app.id)
  const [confirm, confirmElement] = useConfirm()
  const [restoring, setRestoring] = useState<string | null>(null)
  const restore = async (at: string) => {
    const when = new Date(at).toLocaleString()
    const ok = await confirm({
      title: `Restore ${app.environment}'s database to ${when}?`,
      body: (
        <>
          Every row written in {app.environment} since then is replaced by the backup. Code, files and other
          environments are not touched. A backup of the current state is taken first, so this can be undone.
        </>
      ),
      confirmLabel: 'Restore',
      danger: true,
      typeToConfirm: app.environment,
    })
    if (!ok) return
    setRestoring(at)
    await toast
      .promise(new Promise((resolve) => setTimeout(resolve, 1600)), {
        loading: `Restoring ${app.environment} to ${when}…`,
        success: `${app.environment} restored to ${when}`,
        error: 'Restore failed',
      })
      .unwrap()
      .catch(() => undefined)
    setRestoring(null)
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
      {db.backups.length === 0 ? (
        <EmptyNote title="First backup runs tonight">Or take one now; it takes a few seconds.</EmptyNote>
      ) : (
        <>
          <GridHeader grid={GRID} columns={['Taken', 'Size', 'Kind', '']} />
          {db.backups.map((backup) => (
            <GridRow key={backup.at} grid={GRID}>
              <span className="text-foreground" title={backup.at}>
                {new Date(backup.at).toLocaleString()}
              </span>
              <span className="text-muted-foreground">{formatBytes(backup.bytes)}</span>
              <span className="text-muted-foreground">{backup.manual ? 'Manual' : 'Scheduled'}</span>
              <HoverActions className={restoring === backup.at ? 'opacity-100' : undefined}>
                <ToolButton loading={restoring === backup.at} onClick={() => void restore(backup.at)}>
                  Restore to {app.environment}
                </ToolButton>
              </HoverActions>
            </GridRow>
          ))}
        </>
      )}
      {confirmElement}
    </Screen>
  )
}

/** Rows of one table in a side panel, so browsing does not lose the list. */
function TableSheet({
  app,
  table,
  onQuery,
  onClose,
}: {
  app: AppDetail
  table: AppDatabase['tables'][number]
  onQuery: (query: string) => void
  onClose: () => void
}) {
  const sql = useAppSql()
  const PAGE = 20
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState('')
  const [needle, setNeedle] = useState('')
  // Typing filters after a short pause, server-side, across the whole table.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setNeedle(filter.trim().toLowerCase().replace(/'/g, "''"))
      setPage(0)
    }, 250)
    return () => window.clearTimeout(id)
  }, [filter])
  const where = needle ? ` where ${table.name}::text ilike '%${needle}%'` : ''
  const query = `select * from ${table.schema}.${table.name}${where} order by 1 limit ${PAGE} offset ${page * PAGE}`
  // The last page stays on screen (dimmed) while the next one loads, so paging does not jump.
  const [data, setData] = useState<Awaited<ReturnType<typeof sql.mutateAsync>> | null>(null)
  useEffect(() => {
    sql
      .mutateAsync({ appId: app.id, query })
      .then(setData)
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])
  const total = data?.total ?? table.rows
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
                onQuery(`select *\nfrom ${table.schema}.${table.name}${where}\norder by 1\nlimit 100;`)
              }}
            >
              Query in SQL console
            </ToolButton>
            <ToolButton
              disabled={!data}
              onClick={() => data && downloadCsv(`${table.name}.csv`, data.columns, data.rows)}
            >
              Export CSV
            </ToolButton>
          </span>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>
            {total === 0
              ? 'No rows match'
              : `Rows ${from}–${to} of ${total.toLocaleString('en-US')}${needle ? ' matching' : ''} · ${app.environment}`}
          </span>
          <span className="ml-auto flex gap-1">
            <ToolButton disabled={page === 0 || sql.isPending} onClick={() => setPage((p) => p - 1)}>
              ← Previous
            </ToolButton>
            <ToolButton disabled={to >= total || sql.isPending} onClick={() => setPage((p) => p + 1)}>
              Next →
            </ToolButton>
          </span>
        </div>
        {!data ? (
          <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
            <Spinner className="size-4" /> Loading rows…
          </div>
        ) : (
          <div className={cn('overflow-auto transition-opacity', sql.isPending && 'opacity-50')}>
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-border text-[12px] text-muted-foreground">
                  {data.columns.map((column) => (
                    <th key={column} className="whitespace-nowrap px-3 py-2 font-normal">
                      {column}
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
                        {String(cell)}
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
}: {
  app: AppDetail
  section?: string
  onSection: (next: Section) => void
}) {
  const db = app.database
  const current: Section = SECTION_IDS.includes(section as Section) ? (section as Section) : 'tables'
  // A query handed over from another screen (a table's panel) opens in the console.
  const [draft, setDraft] = useState<string | null>(null)
  if (!db) {
    return (
      <Workbench<Section> items={[]} value="tables" onChange={onSection}>
        <NoDatabase app={app} />
      </Workbench>
    )
  }
  return (
    <Workbench<Section>
      items={[
        { id: 'tables', label: 'Tables', count: db.tables.length },
        { id: 'sql', label: 'SQL console' },
        { id: 'migrations', label: 'Migrations', count: db.migrations.length },
        { id: 'backups', label: 'Backups', count: db.backups.length },
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
        <Sql key={draft ?? 'blank'} app={app} initial={draft} />
      ) : current === 'migrations' ? (
        <Migrations app={app} db={db} />
      ) : current === 'backups' ? (
        <Backups app={app} db={db} />
      ) : (
        <Database app={app} db={db} />
      )}
    </Workbench>
  )
}
