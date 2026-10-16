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

const VERSION_GRID = 'grid grid-cols-[1.4fr_0.6fr_1.4fr_0.7fr] items-center gap-3 px-2'

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
 * One image and the builds recorded for it.
 *
 * Each version answers the question the list cannot: which build a box booted
 * from, how big its manifest said it was, and which upstream reference the
 * caller actually typed to get it. The last one is provenance rather than an
 * address — the tag it names may have moved upstream since.
 */
const ImageDetails: React.FC = () => {
  const navigate = useNavigate()
  const { idOrRef } = useParams<{ idOrRef: string }>()
  const { data: image, isLoading, error } = useImageQuery(idOrRef)

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
                Tags: {image.tags.length > 0 ? image.tags.join(', ') : 'none recorded'}. A tag keeps the digest it first
                resolved to — removing the image and using it again is what re-resolves it.
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
              <span>Size</span>
              <span>Pulled from</span>
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
                  <span title={version.digest} className="truncate font-mono text-meta text-foreground">
                    {version.digest}
                  </span>
                  <span className="font-mono text-meta tabular-nums text-muted-foreground">
                    {formatBytes(version.sizeBytes)}
                  </span>
                  {/* What the caller typed, kept verbatim. Not where the bytes
                      live now: the tag it names may have moved upstream. */}
                  <span title={version.sourceRef} className="truncate font-mono text-meta text-muted-foreground">
                    {version.sourceRef}
                  </span>
                  <span className="font-mono text-meta text-muted-foreground">{timeAgo(version.createdAt)}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default ImageDetails
