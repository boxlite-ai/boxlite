/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, PanelNote } from '@/components/ascii'
import { ArrowLeft } from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { useImageQuery } from '@/hooks/queries/useImagesQuery'
import { handleApiError } from '@/lib/error-handling'
import { formatBytes, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import React, { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

const VERSION_GRID = 'grid grid-cols-[1.3fr_0.8fr_0.5fr_1.2fr_0.6fr_0.6fr] items-center gap-3 px-2'
const HISTORY_GRID = 'grid grid-cols-[0.7fr_1.4fr_0.9fr_0.6fr] items-center gap-3 px-2'
// The most tag events an image's detail carries, newest first: the API's
// IMAGE_HISTORY_LIMIT. A full page means older events exist and are not shown.
const HISTORY_LIMIT = 100

/** A version as the history names it: its short digest, or its id when the detail no longer lists it. */
function versionLabel(versionId: string | null, digests: Map<string, string>): string {
  if (versionId === null) {
    return 'new'
  }
  const digest = digests.get(versionId)
  return digest ? `${digest.slice(0, 19)}…` : versionId
}

function Field({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-label uppercase text-muted-foreground">{label}</span>
      <span title={title} className="truncate font-mono text-body text-foreground">
        {value}
      </span>
    </div>
  )
}

/**
 * One image, the builds recorded for it, and where its tags have pointed.
 *
 * Each version answers the question the list cannot: which build a box boots
 * from, which tags point at it now, when a box last used it, and whether its
 * registry was found not to have it any more. The reference the caller typed
 * is provenance rather than an address — the tag it names may have moved
 * upstream since. The history below is the latest moves of its tags, newest
 * first.
 */
const ImageDetails: React.FC = () => {
  const navigate = useNavigate()
  const { idOrRef } = useParams<{ idOrRef: string }>()
  const { data: image, isLoading, error } = useImageQuery(idOrRef)
  const digests = new Map((image?.versions ?? []).map((version) => [version.id, version.digest]))

  useEffect(() => {
    if (error) handleApiError(error, 'Failed to fetch image')
  }, [error])

  return (
    <div className="flex h-[calc(100svh-60px)] min-h-0 flex-col px-4 pt-5 sm:px-6 lg:px-[40px] lg:pt-[26px]">
      <button
        type="button"
        onClick={() => navigate(RoutePath.IMAGES)}
        className="mb-[14px] inline-flex w-fit items-center gap-2 font-mono text-meta text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Images
      </button>

      {isLoading && <p className="font-mono text-body text-muted-foreground">Loading…</p>}

      {image && (
        <>
          <div className="mb-[18px] flex items-end justify-between">
            <h1 className="truncate font-display text-page font-semibold text-foreground">{image.name}</h1>
          </div>

          <Panel className="px-[18px] py-[16px]">
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
              <Field
                label="Source"
                value={image.curated ? 'Operator (curated)' : 'This organization'}
                title={image.curatedRef ?? undefined}
              />
              <Field label="Versions" value={image.curated ? '—' : image.versionCount} />
              <Field label="Size" value={formatBytes(image.sizeBytes)} />
              <Field label="Last used" value={timeAgo(image.lastUsedAt)} />
            </div>
            {image.curated ? (
              <PanelNote>
                Provided by the operator and shared by every organization, pinned to{' '}
                <span className="text-foreground">{image.curatedRef}</span>. It is not in this organization&rsquo;s
                catalog, so it cannot be removed and does not count against the limit.
              </PanelNote>
            ) : (
              <PanelNote>
                Tags: {image.tags.length > 0 ? image.tags.join(', ') : 'none recorded'}. A pull never moves a tag:
                moving one to another version rolls boxes created afterwards onto it, and boxes already created keep
                theirs.
              </PanelNote>
            )}
          </Panel>

          <div className="mt-[18px] flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div
              className={cn(
                VERSION_GRID,
                'border-b border-border pb-2 font-mono text-label uppercase text-muted-foreground',
              )}
            >
              <span>Digest</span>
              <span>Tags</span>
              <span>Size</span>
              <span>Pulled from</span>
              <span>Last used</span>
              <span>Recorded</span>
            </div>

            {image.versions.length === 0 ? (
              <p className="px-2 py-[16px] font-mono text-meta text-muted-foreground">
                {image.curated
                  ? 'Curated images are operator configuration, so no versions are recorded for them.'
                  : 'No versions recorded yet.'}
              </p>
            ) : (
              image.versions.map((version) => (
                <div key={version.id} className={cn(VERSION_GRID, 'border-b border-border/60 py-[13px] text-body')}>
                  <span className="flex min-w-0 flex-col">
                    <span title={version.digest} className="truncate font-mono text-meta text-foreground">
                      {version.digest}
                    </span>
                    {/* A pull found the registry no longer has it. Runners that
                        cached it still start it; elsewhere it cannot be pulled. */}
                    {version.upstreamMissingAt && (
                      <span
                        title={`A pull found it gone from its registry ${timeAgo(version.upstreamMissingAt)}`}
                        className="font-mono text-label uppercase text-destructive"
                      >
                        Needs a new pull
                      </span>
                    )}
                  </span>
                  <span className="truncate font-mono text-meta text-muted-foreground">
                    {version.tags.length > 0 ? version.tags.join(', ') : '—'}
                  </span>
                  <span className="font-mono text-meta tabular-nums text-muted-foreground">
                    {formatBytes(version.sizeBytes)}
                  </span>
                  {/* What the caller typed, kept verbatim. Not where the bytes
                      live now: the tag it names may have moved upstream. */}
                  <span title={version.sourceRef} className="truncate font-mono text-meta text-muted-foreground">
                    {version.sourceRef}
                  </span>
                  {/* Null is a version recorded before last use was tracked:
                      unknown, which "never" would misstate. */}
                  <span className="font-mono text-meta text-muted-foreground">
                    {version.lastUsedAt ? timeAgo(version.lastUsedAt) : '—'}
                  </span>
                  <span className="font-mono text-meta text-muted-foreground">{timeAgo(version.createdAt)}</span>
                </div>
              ))
            )}

            <h2 className="mt-[26px] mb-2 px-2 font-mono text-label uppercase text-muted-foreground">History</h2>
            <div
              className={cn(
                HISTORY_GRID,
                'border-b border-border pb-2 font-mono text-label uppercase text-muted-foreground',
              )}
            >
              <span>Tag</span>
              <span>Moved</span>
              <span>By</span>
              <span>When</span>
            </div>
            {image.history.length === 0 ? (
              <p className="px-2 py-[16px] font-mono text-meta text-muted-foreground">
                {/* A pull writes a tag's first event, so tags with no history
                    were recorded before history was kept; no event is backfilled. */}
                {image.curated
                  ? 'Curated images have no tags to move; the operator pins their reference.'
                  : image.tags.length > 0
                    ? 'No history yet: these tags were recorded before tag moves were kept.'
                    : 'No tag has been recorded yet.'}
              </p>
            ) : (
              image.history.map((event) => (
                <div
                  key={`${event.tagName}-${event.createdAt}-${event.toVersionId}`}
                  className={cn(HISTORY_GRID, 'border-b border-border/60 py-[13px] text-body')}
                >
                  <span className="truncate font-mono text-meta text-foreground">{event.tagName}</span>
                  <span className="truncate font-mono text-meta text-muted-foreground">
                    {versionLabel(event.fromVersionId, digests)} → {versionLabel(event.toVersionId, digests)}
                  </span>
                  {/* No actor: a box pulling the image recorded the tag. */}
                  <span
                    title={event.actorId ?? undefined}
                    className="truncate font-mono text-meta text-muted-foreground"
                  >
                    {event.actorId ?? 'a pull'}
                  </span>
                  <span className="font-mono text-meta text-muted-foreground">{timeAgo(event.createdAt)}</span>
                </div>
              ))
            )}
            {image.history.length >= HISTORY_LIMIT && (
              <p className="px-2 py-[12px] font-mono text-meta text-muted-foreground">
                Showing the latest {HISTORY_LIMIT} events; older ones are not listed.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default ImageDetails
