/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, PanelNote, SegmentedBar } from '@/components/ascii'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Search, Trash } from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { useDeleteImageMutation } from '@/hooks/mutations/useDeleteImageMutation'
import { useImageUsageQuery, useImagesQuery } from '@/hooks/queries/useImagesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { formatBytes, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Image, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import React, { useEffect, useMemo, useState } from 'react'
import { generatePath, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

// One definition for the header and every row, for the reason spelled out in
// Volumes: two grid containers solving independently drift apart column by
// column.
const ROW_GRID = 'grid grid-cols-[1.8fr_1.1fr_0.6fr_0.7fr_0.8fr_60px] items-center gap-3 px-2'

/** Marks an operator-provided row. A span, not a chip: it sits inside the row's link button. */
function CuratedMark() {
  return (
    <span className="shrink-0 border border-border px-[6px] py-[1px] font-mono text-label uppercase text-muted-foreground">
      curated
    </span>
  )
}

/** The route segment for a row: its catalog id, or — for curated rows, which have none — its name. */
export function imageRouteKey(image: Pick<Image, 'id' | 'name'>): string {
  return image.id ?? image.name
}

/**
 * The organization's image catalog.
 *
 * There is no "add image" here, and its absence is the design: an image enters
 * the catalog by being used, so the way to add one is to create a box from it.
 * A create button would imply a registration step that does not exist.
 */
const Images: React.FC = () => {
  const navigate = useNavigate()
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()

  const { data: images = [], error: imagesError } = useImagesQuery()
  const { data: usage, error: usageError } = useImageUsageQuery()
  const deleteImage = useDeleteImageMutation()

  const canDelete = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_IMAGES)

  const [filter, setFilter] = useState('')
  const [pendingDelete, setPendingDelete] = useState<Image | null>(null)

  useEffect(() => {
    if (imagesError) handleApiError(imagesError, 'Failed to fetch images')
  }, [imagesError])

  useEffect(() => {
    if (usageError) handleApiError(usageError, 'Failed to fetch image usage')
  }, [usageError])

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return images
    return images.filter((image) => image.name.toLowerCase().includes(needle))
  }, [images, filter])

  const handleDelete = async (image: Image) => {
    const key = imageRouteKey(image)
    try {
      await deleteImage.mutateAsync({ idOrRef: key, organizationId: selectedOrganization?.id })
      setPendingDelete(null)
      toast.success(`Removed ${image.name} from the catalog`)
    } catch (error) {
      // A 409 names the boxes that still hold it, and that message is the
      // useful part — no local pre-check could produce it, and a second
      // opinion here would only ever be the less accurate one.
      handleApiError(error, `Failed to remove ${image.name}`)
      setPendingDelete(null)
    }
  }

  return (
    <div className="flex h-[calc(100svh-60px)] min-h-0 flex-col px-4 pt-5 sm:px-6 lg:px-[40px] lg:pt-[26px]">
      <div className="mb-[18px] flex items-end justify-between lg:mb-[22px]">
        <h1 className="font-display text-page font-semibold text-foreground">Images</h1>
      </div>

      {usage && (
        <Panel className="mb-[14px] px-[14px] py-[12px]">
          <div className="flex items-center gap-4">
            <span className="whitespace-nowrap font-mono text-label uppercase text-muted-foreground">Catalog</span>
            <SegmentedBar used={usage.count} limit={usage.limit} />
            <span className="whitespace-nowrap font-mono text-meta tabular-nums text-foreground">
              {usage.count} / {usage.limit}
            </span>
          </div>
          <PanelNote>
            The limit counts images, not bytes. Your versions declare {formatBytes(usage.knownBytes)} in total; curated
            images belong to the operator and count against nothing.
          </PanelNote>
        </Panel>
      )}

      <div className="flex h-11 w-full min-w-0 items-center gap-[11px] border border-dashed border-border bg-card px-[14px] sm:h-9 sm:max-w-[380px]">
        <Search className="size-[15px] shrink-0" style={{ color: 'hsl(var(--brand))' }} strokeWidth={2} />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter images…"
          className="w-full border-0 bg-transparent p-0 text-body text-foreground outline-none placeholder:text-muted-foreground"
        />
        <span className="whitespace-nowrap font-mono text-label uppercase text-muted-foreground">{rows.length}</span>
      </div>

      <div className="mt-[14px] flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div
          className={cn(ROW_GRID, 'border-b border-border pb-2 font-mono text-label uppercase text-muted-foreground')}
        >
          <span>Name</span>
          <span>Tags</span>
          <span>Versions</span>
          <span>Size</span>
          <span>Last used</span>
          <span className="text-right">Actions</span>
        </div>

        {rows.map((image) => {
          const key = imageRouteKey(image)
          return (
            <div key={key} className="border-b border-border/60">
              <div className={cn(ROW_GRID, 'py-[13px] text-body')}>
                <button
                  type="button"
                  onClick={() => navigate(generatePath(RoutePath.IMAGE_DETAILS, { idOrRef: key }))}
                  className="flex min-w-0 items-center gap-2 text-left"
                >
                  <span className="truncate font-mono font-medium text-foreground hover:underline">{image.name}</span>
                  {image.curated && <CuratedMark />}
                </button>
                <span className="truncate font-mono text-meta text-muted-foreground">
                  {image.tags.length > 0 ? image.tags.join(', ') : '—'}
                </span>
                <span className="font-mono text-meta tabular-nums text-muted-foreground">
                  {image.curated ? '—' : image.versionCount}
                </span>
                <span className="font-mono text-meta tabular-nums text-muted-foreground">
                  {formatBytes(image.sizeBytes)}
                </span>
                <span className="font-mono text-meta text-muted-foreground">{timeAgo(image.lastUsedAt)}</span>
                <div className="flex items-center justify-end">
                  {canDelete && !image.curated && (
                    <button
                      type="button"
                      onClick={() => setPendingDelete(image)}
                      // Radix unmounts the dialog on confirm, so this is
                      // the control still on screen while the delete is in
                      // flight — and re-opening from here is what would
                      // send a second DELETE.
                      disabled={deleteImage.isPending}
                      title={`Remove ${image.name} from the catalog`}
                      className="p-[5px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
                    >
                      <Trash className="size-[15px]" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}

        {rows.length === 0 && filter.trim() && (
          <div className="flex flex-col items-center gap-3 py-10 text-center font-mono text-meta text-muted-foreground">
            <span>No image matches “{filter.trim()}”</span>
            <button
              type="button"
              onClick={() => setFilter('')}
              className="border border-border px-[13px] py-[6px] text-label transition-colors hover:border-brand"
            >
              Clear filter
            </button>
          </div>
        )}
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingDelete?.name} from the catalog?</AlertDialogTitle>
            {/* Two things a reader would otherwise get wrong: that this frees
                storage, and that it is irreversible. It is neither. */}
            <AlertDialogDescription asChild>
              <div className="space-y-2 font-mono text-meta">
                <p>
                  This removes the catalog entry, not the bytes. Runners keep whatever they cached, and using the same
                  reference again brings it back as a new entry.
                </p>
                <p>
                  That is also how to pick up a tag that has moved upstream: a recorded tag keeps the digest it first
                  resolved to, so removing the image and using it again is what re-resolves it.
                </p>
                <p>Boxes that have not been destroyed still hold this image, and the removal will be refused.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingDelete && handleDelete(pendingDelete)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default Images
