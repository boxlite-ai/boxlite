/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Spinner } from '@/components/ui/spinner'
import { useUploadFile } from '@/hooks/mutations/useAppMutations'
import { useVolumeListing } from '@/hooks/queries/useAppsQuery'
import { downloadUrl, errorBody, errorText } from '@/lib/apps/client'
import { formatBytes, relTime } from '@/lib/apps/format'
import type { AppDetail, AppStorage, VolumeEntry } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useConfirm } from './confirm'
import { EmptyNote, GridHeader, GridRow, HoverActions } from './spec'
import { ToolButton } from './SubNav'

// The files of one volume, read through the environment's Box (the same route `boxlite-app app
// volume ls|cp` uses). Folders open in place, files download, and uploads land in the open folder.

const GRID = 'grid-cols-[minmax(0,1fr)_110px_160px_110px] gap-x-4'
const MAX_UPLOAD = 50 * 1024 * 1024

const join = (dir: string, name: string) => `${dir === '/' ? '' : dir}/${name}`

function Breadcrumb({ volume, path, onOpen }: { volume: string; path: string; onOpen: (path: string) => void }) {
  const parts = path.split('/').filter(Boolean)
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-[13px]">
      <button type="button" className="text-foreground hover:underline" onClick={() => onOpen('/')}>
        {volume}
      </button>
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-1">
          <span className="text-border">/</span>
          <button
            type="button"
            className="text-foreground hover:underline"
            onClick={() => onOpen(`/${parts.slice(0, i + 1).join('/')}`)}
          >
            {part}
          </button>
        </span>
      ))}
    </span>
  )
}

/** Why the files cannot be listed, in words that say what to do. */
function unavailable(error: unknown): { title: string; detail: string } {
  const code = errorBody(error)?.code
  if (code === 'not_supported_yet')
    return {
      title: 'File browsing needs a newer supervisor in this Box',
      detail:
        'Restart the services (⋮ › Restart services) or deploy again; the Box then fetches the current supervisor.',
    }
  if (code === 'not_found') return { title: 'Nothing to browse yet', detail: errorText(error) }
  return { title: 'The files could not be read', detail: errorText(error) }
}

export function VolumeFiles({ app, volume }: { app: AppDetail; volume: AppStorage }) {
  const [path, setPath] = useState('/')
  const listing = useVolumeListing(app.id, volume.name, path)
  const { isLoading, refetch, isFetching } = listing
  // The volume's own root is missing until something is written to it: that is an empty volume.
  const emptyRoot =
    path === '/' && errorBody(listing.error)?.code === 'not_found' && /does not exist/.test(errorText(listing.error))
  const error = emptyRoot ? null : listing.error
  const data = emptyRoot ? { volume: volume.name, path: '/', type: 'dir' as const, entries: [] } : listing.data
  const upload = useUploadFile()
  const [confirm, confirmElement] = useConfirm()
  const input = useRef<HTMLInputElement>(null)

  const send = async (file: File) => {
    if (file.size > MAX_UPLOAD) return toast.error(`${file.name} is ${formatBytes(file.size)}; the limit is 50 MB`)
    const target = join(path, file.name)
    const exists = data?.entries.some((e) => e.name === file.name)
    if (exists) {
      const ok = await confirm({
        title: `Replace ${file.name}?`,
        body: (
          <>
            {volume.name}:{target} already exists. The app sees the new file at once.
          </>
        ),
        confirmLabel: 'Replace',
        danger: true,
      })
      if (!ok) return
    }
    try {
      const out = await upload.mutateAsync({
        appId: app.id,
        volume: volume.name,
        path: target,
        file,
        overwrite: !!exists,
      })
      toast.success(`Uploaded ${file.name}`, { description: `${volume.name}:${out.path} · ${formatBytes(out.bytes)}` })
    } catch (err) {
      handleApiError(err, `Could not upload ${file.name}`)
    }
  }

  const fileUrl = (entry: VolumeEntry) =>
    downloadUrl(
      `/apps/${encodeURIComponent(app.id)}/volumes/${encodeURIComponent(volume.name)}/files?env=${encodeURIComponent(app.environment)}&path=${encodeURIComponent(join(path, entry.name))}`,
    )

  return (
    <div className="flex flex-col gap-2 px-[22px] pb-[18px]" data-testid={`volume-files-${volume.name}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Breadcrumb volume={volume.name} path={path} onOpen={setPath} />
        <span className="ml-auto flex gap-1">
          <ToolButton onClick={() => refetch()} loading={isFetching && !isLoading}>
            Refresh
          </ToolButton>
          <ToolButton primary loading={upload.isPending} disabled={!!error} onClick={() => input.current?.click()}>
            Upload file
          </ToolButton>
          <input
            ref={input}
            type="file"
            className="hidden"
            aria-label={`Upload a file to ${volume.name}`}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void send(file)
            }}
          />
        </span>
      </div>
      {error ? (
        <EmptyNote title={unavailable(error).title}>{unavailable(error).detail}</EmptyNote>
      ) : isLoading || !data ? (
        <div className="flex items-center gap-2 py-6 font-mono text-[13px] text-muted-foreground">
          <Spinner className="size-4" /> Reading {volume.name}:{path} (a sleeping Box wakes first)…
        </div>
      ) : data.entries.length === 0 ? (
        <EmptyNote title={path === '/' ? 'This volume is empty' : 'This folder is empty'}>
          Files the app writes under {volume.mountPath} show up here. Upload one, or `boxlite-app app volume cp ./file{' '}
          {volume.name}:/file`.
        </EmptyNote>
      ) : (
        <div>
          <GridHeader grid={GRID} columns={['Name', 'Size', 'Modified', '']} />
          {path !== '/' && (
            <GridRow
              grid={GRID}
              className="min-h-[40px]"
              onClick={() => setPath(path.split('/').slice(0, -1).join('/') || '/')}
            >
              <span className="text-muted-foreground">../</span>
              <span />
              <span />
              <span />
            </GridRow>
          )}
          {[...data.entries]
            .sort((a, b) =>
              (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
            )
            .map((entry) => (
              <GridRow
                key={entry.name}
                grid={GRID}
                className="min-h-[40px]"
                onClick={entry.type === 'dir' ? () => setPath(join(path, entry.name)) : undefined}
              >
                <span className="truncate text-foreground">{entry.type === 'dir' ? `${entry.name}/` : entry.name}</span>
                <span className="tabular-nums text-muted-foreground">
                  {entry.type === 'dir' ? '—' : formatBytes(entry.size)}
                </span>
                <span className="text-muted-foreground" title={entry.modified_at}>
                  {relTime(entry.modified_at)}
                </span>
                <HoverActions>
                  {entry.type === 'file' && (
                    <a
                      href={fileUrl(entry)}
                      download={entry.name}
                      className="inline-flex h-[28px] items-center border border-border px-[10px] font-mono text-[12px] text-muted-foreground transition-colors hover:border-brand hover:text-foreground"
                    >
                      Download
                    </a>
                  )}
                </HoverActions>
              </GridRow>
            ))}
        </div>
      )}
      {confirmElement}
    </div>
  )
}
