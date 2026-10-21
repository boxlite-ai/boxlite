/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RoutePath } from '@/enums/RoutePath'
import { formatBytes, relTime } from '@/lib/apps/format'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { AppDetail, AppStorage } from '@/lib/apps/types'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CopyIconButton, Disclosure, EmptyNote, HoverActions, PromptBlock, SpecRow } from '../spec'
import { ChevronRight } from '@/components/ui/icon'
import { cn } from '@/lib/utils'
import { useConfirm } from '../confirm'
import { Screen, ToolButton } from '../SubNav'
import { useAppAction } from '../useAppAction'

// Volumes attached to this environment. Each leads with what it holds and who
// can read it, then the two ways in (the app over S3, the workspace as a
// mounted folder); endpoints and keys are behind "Connection details". The
// volume itself lives on the Volumes page; this tab links there.

export function VolumesTab({ app }: { app: AppDetail }) {
  return (
    <Screen
      title={`Volumes in ${app.environment}`}
      actions={
        <Link
          to={RoutePath.VOLUMES}
          className="inline-flex h-[28px] items-center gap-1 border border-border px-[10px] font-mono text-[12px] text-muted-foreground transition-colors hover:border-brand hover:text-foreground"
        >
          All volumes →
        </Link>
      }
    >
      <VolumeList app={app} />
    </Screen>
  )
}

// A small, believable tree for the mock: folders open in place, files can be
// downloaded, and a public volume also offers each object's URL.
const OBJECT_TREE: Record<string, { name: string; bytes?: number; objects?: number; at: number }[]> = {
  '': [
    { name: 'avatars/', objects: 74, at: 2 },
    { name: 'exports/', objects: 111, at: 30 },
    { name: 'imports/', objects: 9, at: 300 },
    { name: 'notes/', objects: 259, at: 45 },
    { name: 'logo.png', bytes: 889_000, at: 9000 },
  ],
  'avatars/': [
    { name: 'u_1000.png', bytes: 48_200, at: 2 },
    { name: 'u_1001.png', bytes: 51_900, at: 40 },
    { name: 'u_1002.jpg', bytes: 132_400, at: 600 },
  ],
  'exports/': [
    { name: 'deals-2026-10.csv', bytes: 412_000, at: 30 },
    { name: 'deals-2026-09.csv', bytes: 389_000, at: 43_000 },
  ],
  'imports/': [{ name: 'contacts.csv', bytes: 711_000, at: 300 }],
  'notes/': [
    { name: 'attachments/', objects: 251, at: 45 },
    { name: 'n_318.md', bytes: 2_100, at: 120 },
  ],
  'notes/attachments/': [{ name: 'contract-acme.pdf', bytes: 533_000, at: 45 }],
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

/** The objects in one volume, in a side panel you can walk through. */
function ObjectsSheet({ bucket, onClose }: { bucket: AppStorage; onClose: () => void }) {
  const [prefix, setPrefix] = useState('')
  const entries = OBJECT_TREE[prefix] ?? []
  const crumbs = prefix.split('/').filter(Boolean)
  const download = (key: string) => {
    const url = URL.createObjectURL(new Blob([key]))
    const link = document.createElement('a')
    link.href = url
    link.download = key.split('/').pop() ?? key
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[600px] max-w-[90vw] gap-4 p-6 font-mono sm:max-w-[600px]"
      >
        <SheetHeader className="gap-1">
          <SheetTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">{bucket.name}</SheetTitle>
          <span className="text-[13px] text-muted-foreground">
            {bucket.objects.toLocaleString('en-US')} objects · {formatBytes(bucket.sizeBytes)} ·{' '}
            {bucket.public ? 'public read' : 'private'}
          </span>
        </SheetHeader>
        <nav className="mt-2 flex flex-wrap items-center gap-1 text-[13px]">
          <button
            type="button"
            onClick={() => setPrefix('')}
            className={cn('hover:text-foreground', crumbs.length ? 'text-muted-foreground' : 'text-foreground')}
          >
            {bucket.name}
          </button>
          {crumbs.map((crumb, i) => (
            <span key={crumb} className="flex items-center gap-1">
              <span className="text-border">/</span>
              <button
                type="button"
                onClick={() => setPrefix(`${crumbs.slice(0, i + 1).join('/')}/`)}
                className={cn(
                  'hover:text-foreground',
                  i === crumbs.length - 1 ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {crumb}
              </button>
            </span>
          ))}
        </nav>
        <div>
          {entries.map((entry) => {
            const key = `${prefix}${entry.name}`
            const folder = entry.name.endsWith('/')
            return (
              <div
                key={key}
                onClick={() => folder && setPrefix(key)}
                className={cn(
                  'group relative flex min-h-[44px] items-center gap-4 px-2 text-body transition-colors border-b border-border/60 hover:bg-card/50',
                  folder && 'cursor-pointer',
                )}
              >
                <span className={cn('min-w-0 flex-1 truncate', folder ? 'text-foreground' : 'text-muted-foreground')}>
                  {entry.name}
                </span>
                <span className="shrink-0 text-[12px] text-muted-foreground group-hover:hidden">
                  {folder
                    ? `${entry.objects} objects`
                    : `${formatBytes(entry.bytes ?? 0)} · ${relTime(minutesAgo(entry.at))}`}
                </span>
                {!folder && (
                  <HoverActions className="hidden group-hover:flex">
                    {bucket.public && bucket.publicUrlBase && (
                      <CopyIconButton
                        text={`${bucket.publicUrlBase}/${key}`}
                        title="Copy public URL"
                        className="px-2"
                      />
                    )}
                    <ToolButton onClick={() => download(key)}>Download</ToolButton>
                  </HoverActions>
                )}
                {folder && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
              </div>
            )
          })}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function VolumeList({ app }: { app: AppDetail }) {
  const { run, pending } = useAppAction(app.id)
  const [confirm, confirmElement] = useConfirm()
  const [browsing, setBrowsing] = useState<AppStorage | null>(null)
  const togglePublic = async (bucket: AppStorage) => {
    const next = !bucket.public
    if (next) {
      const ok = await confirm({
        title: `Make ${bucket.name} public?`,
        body: <>Anyone with an object&apos;s URL can read it. Listing and writing stay private.</>,
        confirmLabel: 'Make public',
      })
      if (!ok) return
    }
    void run(
      { type: 'setVolumePublic', bucket: bucket.name, public: next },
      `${bucket.name} is now ${next ? 'public read' : 'private'}`,
      {
        key: `public:${bucket.name}`,
      },
    )
  }
  if (app.storages.length === 0) {
    return (
      <EmptyNote
        title="No volume attached"
        action={
          <div className="w-full max-w-[640px] text-left">
            <PromptBlock
              text={`Attach a volume "uploads" to BoxLite app "${app.name}" (\`boxlite app add volume uploads\`) and use the injected STORAGE_UPLOADS_* credentials with any S3 SDK.`}
              compact
            />
          </div>
        }
      >
        The app reaches a volume with S3 keys; the workspace can also mount it as a folder.
      </EmptyNote>
    )
  }

  return (
    <div className="flex flex-col gap-10">
      {app.storages.map((bucket) => (
        // One bordered panel per volume, headed like the plan panel on Billing.
        <section key={bucket.name} className="border border-border bg-card">
          {/* What it holds and who can read it first; how to connect is one click away. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-[22px] py-4">
            <h3 className="font-mono text-em font-semibold text-foreground">{bucket.name}</h3>
            <span className="font-mono text-meta text-muted-foreground">
              {formatBytes(bucket.sizeBytes)} · {bucket.objects.toLocaleString('en-US')} objects ·{' '}
              {bucket.public ? 'public read' : 'private'}
            </span>
            <span className="ml-auto flex gap-[6px]">
              <ToolButton onClick={() => setBrowsing(bucket)}>Browse objects</ToolButton>
              <ToolButton loading={pending === `public:${bucket.name}`} onClick={() => void togglePublic(bucket)}>
                {bucket.public ? 'Make private' : 'Make public'}
              </ToolButton>
            </span>
          </div>

          <div className="grid gap-x-10 gap-y-5 px-[22px] pt-[18px] md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
                <span className="text-brand">▸</span> The app reaches it over S3
              </span>
              <span className="font-mono text-body text-foreground">{bucket.envPrefix}_* variables</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
                <span className="text-brand">▸</span> The workspace mounts it at
              </span>
              <span className="font-mono text-body text-foreground">{bucket.mountPath ?? 'Not mounted'}</span>
            </div>
          </div>

          <div className="px-[22px] pb-[18px] pt-5">
            <Disclosure label="Connection details">
              <div className="max-w-[640px]">
                <SpecRow label="Variables">{bucket.envPrefix}_ENDPOINT / _BUCKET / _KEY / _SECRET</SpecRow>
                {bucket.publicUrlBase && <SpecRow label="Public URL">{bucket.publicUrlBase}&lt;key&gt;</SpecRow>}
                {bucket.keys.length === 0 ? (
                  <SpecRow label="Access keys">None yet; the first deployment issues one</SpecRow>
                ) : (
                  bucket.keys.map((key) => (
                    <SpecRow key={key.id} label="Access key">
                      <span className="inline-flex flex-wrap items-center gap-x-3">
                        {key.id}
                        <span className="text-muted-foreground">last used {relTime(key.lastUsedAt)}</span>
                        <ToolButton
                          loading={pending === `rotate:${bucket.name}`}
                          onClick={() =>
                            void run(
                              { type: 'rotateVolumeKey', bucket: bucket.name },
                              `New key for ${bucket.name}; it reaches the app on the next restart`,
                              { key: `rotate:${bucket.name}` },
                            )
                          }
                        >
                          Rotate
                        </ToolButton>
                      </span>
                    </SpecRow>
                  ))
                )}
              </div>
            </Disclosure>
          </div>
        </section>
      ))}
      {browsing && <ObjectsSheet bucket={browsing} onClose={() => setBrowsing(null)} />}
      {confirmElement}
    </div>
  )
}
