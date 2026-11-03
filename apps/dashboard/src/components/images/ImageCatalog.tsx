/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, SegmentedBar } from '@/components/ascii'
import { CreateBoxDialog } from '@/components/Box/CreateBoxDialog'
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
import { useBoxesByImageQuery } from '@/hooks/queries/useBoxesByImageQuery'
import { useImageUsageQuery, useImagesQuery } from '@/hooks/queries/useImagesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { formatBytes, timeAgo } from '@/lib/format'
import { conflictBoxIds, imageRouteKey, imageStartRef } from '@/lib/image-ref'
import { BOX_TEMPLATES } from '@/lib/quickstart/box-templates'
import { TemplateIcon } from '@/components/first-run/TemplateIcon'
import { cn } from '@/lib/utils'
import { BoxliteError } from '@/api/errors'
import { Box, Image, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import React, { useEffect, useMemo, useState } from 'react'
import { generatePath, Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

// One definition for the header and every row, for the reason spelled out in
// Volumes: two grid containers solving independently drift apart column by
// column.
const ROW_GRID = 'grid grid-cols-[1.8fr_1.2fr_0.6fr_0.5fr_0.8fr_110px] items-center gap-3 px-2'

function BoxLinks({ boxes }: { boxes: Box[] }) {
  return (
    <span className="font-mono">
      {boxes.map((box, index) => (
        <React.Fragment key={box.id}>
          {index > 0 && ', '}
          <Link
            to={generatePath(RoutePath.BOX_DETAILS, { boxId: box.id })}
            className="text-foreground underline-offset-4 hover:underline"
          >
            {box.name}
          </Link>
        </React.Fragment>
      ))}
    </span>
  )
}

/** API catalog rows, enriched with matching Quickstart template metadata. */
export function ImageCatalog() {
  const navigate = useNavigate()
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()

  const { data: images = [], error: imagesError } = useImagesQuery()
  const { data: usage, error: usageError } = useImageUsageQuery()
  const { byImage, byId, truncated } = useBoxesByImageQuery()
  const deleteImage = useDeleteImageMutation()

  const canDelete = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_IMAGES)
  const canCreateBox = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)

  const [filter, setFilter] = useState('')
  const [pendingRemove, setPendingRemove] = useState<(Image & { templateId?: string }) | null>(null)
  const [newBoxImage, setNewBoxImage] = useState<string | null>(null)

  useEffect(() => {
    if (imagesError) handleApiError(imagesError, 'Failed to fetch images')
  }, [imagesError])

  useEffect(() => {
    if (usageError) handleApiError(usageError, 'Failed to fetch image usage')
  }, [usageError])

  const catalog = useMemo(
    () =>
      images.map((image) => ({
        ...image,
        templateId: BOX_TEMPLATES.find((template) =>
          image.curatedRef
            ? template.image === image.curatedRef
            : [imageStartRef(image), ...image.aliases.map((tag) => `${image.name}:${tag}`)].includes(template.image),
        )?.id,
      })),
    [images],
  )
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return catalog.filter((image) =>
      `${image.name} ${image.curatedRef ?? ''} ${image.aliases.join(' ')}`.toLowerCase().includes(needle),
    )
  }, [catalog, filter])
  const openTemplate = (id: string) =>
    navigate(`${RoutePath.QUICKSTART}?method=console&template=${encodeURIComponent(id)}`)

  const handleRemove = async (image: Image & { templateId?: string }) => {
    if (image.curated || !image.id) return
    const key = imageRouteKey(image)
    setPendingRemove(null)
    try {
      await deleteImage.mutateAsync({ idOrRef: key, organizationId: selectedOrganization?.id })
      toast.success(`Removed ${image.name}`, { description: 'Starting a box from it again adds it back.' })
    } catch (error) {
      // A 409 lists the boxes that still reference the image, by id. Those
      // are the useful part, as boxes the reader can open rather than ids.
      const holders =
        error instanceof BoxliteError && /cannot be removed/.test(error.message)
          ? conflictBoxIds(error.message).map((id) => byId.get(id) ?? null)
          : []
      if (holders.length > 0) {
        const known = holders.filter((box): box is Box => box !== null)
        toast.error(`${image.name} is still referenced`, {
          description: (
            <span>
              Destroy {known.length > 0 ? <BoxLinks boxes={known} /> : `${holders.length} box(es)`} first. Stopped boxes
              count too.
            </span>
          ),
        })
        return
      }
      handleApiError(error, `Failed to remove ${image.name}`)
    }
  }

  const atLimit = usage ? usage.count >= usage.limit : false
  const nearLimit = usage ? usage.count >= usage.limit * 0.8 : false

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* An image has no create of its own: it is added when a box first
          starts from it. The one step a reader may have to take first is a
          credential for a private registry, so that is where this points. */}
      <ol className="mb-[14px] flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-meta text-muted-foreground">
        <li>
          <span className="text-foreground">1</span> Private registry?{' '}
          <Link to={RoutePath.IMAGE_REGISTRIES} className="text-foreground underline underline-offset-4">
            Connect it
          </Link>
        </li>
        <li aria-hidden>→</li>
        <li>
          <span className="text-foreground">2</span> Start a box from any image
          {canCreateBox && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => setNewBoxImage('')}
                className="text-foreground underline underline-offset-4"
              >
                New box
              </button>
            </>
          )}
        </li>
        <li aria-hidden>→</li>
        <li>
          <span className="text-foreground">3</span> Used images count toward your image limit
        </li>
      </ol>

      {usage && (
        <Panel className={cn('mb-[14px] px-[14px] py-[12px]', atLimit && 'border-destructive')}>
          <div className="flex flex-wrap items-center gap-4">
            <SegmentedBar used={usage.count} limit={usage.limit} segments={usage.limit} />
            <span
              className={cn(
                'whitespace-nowrap font-mono text-meta tabular-nums',
                atLimit ? 'text-destructive' : nearLimit ? 'text-yellow-600 dark:text-yellow-400' : 'text-foreground',
              )}
            >
              {usage.count} of {usage.limit} images · {formatBytes(usage.knownBytes)}
            </span>
            {atLimit && (
              <span className="font-mono text-meta text-muted-foreground">
                At the limit. Remove an image, or contact us to raise it.
              </span>
            )}
          </div>
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
          className={cn(ROW_GRID, 'border-b border-border py-2 font-mono text-label uppercase text-muted-foreground')}
        >
          <span>Image</span>
          <span>Tags</span>
          <span>Size</span>
          <span title={truncated ? `Counted over the first ${byId.size} boxes` : undefined}>
            Boxes{truncated ? '*' : ''}
          </span>
          <span>Last started</span>
          <span className="text-right">Actions</span>
        </div>

        {rows.map((image) => {
          const key = image.id ?? image.curatedRef ?? image.name
          const boxes = byImage.get(image.name) ?? []
          return (
            <div key={key} className={cn(ROW_GRID, 'border-b border-border/60 py-[13px] text-body')}>
              <button
                type="button"
                onClick={() =>
                  image.templateId && !image.id
                    ? openTemplate(image.templateId)
                    : navigate(generatePath(RoutePath.IMAGE_DETAILS, { idOrRef: imageRouteKey(image) }))
                }
                className="flex min-w-0 items-center gap-3 text-left"
                title={image.curatedRef ?? image.name}
              >
                <TemplateIcon id={image.templateId ?? image.name} />
                <span className="block truncate font-mono font-medium text-foreground hover:underline">
                  {image.name}
                </span>
              </button>
              <span className="truncate font-mono text-meta text-muted-foreground" title={image.aliases.join(', ')}>
                {image.aliases.length === 0
                  ? '—'
                  : image.aliases.length === 1
                    ? image.aliases[0]
                    : `${image.aliases[0]} +${image.aliases.length - 1}`}
              </span>
              <span className="font-mono text-meta tabular-nums text-muted-foreground">
                {formatBytes(image.sizeBytes)}
              </span>
              <span className="font-mono text-meta tabular-nums text-muted-foreground">
                {boxes.length > 0 ? boxes.length : '—'}
              </span>
              <span className="font-mono text-meta text-muted-foreground">{timeAgo(image.lastUsedAt)}</span>
              <div className="flex items-center justify-end gap-1">
                {canCreateBox && (
                  <button
                    type="button"
                    onClick={() =>
                      image.templateId ? openTemplate(image.templateId) : setNewBoxImage(imageStartRef(image))
                    }
                    title={`New box from ${imageStartRef(image)}`}
                    className="px-2 py-[5px] font-mono text-label uppercase text-muted-foreground transition-colors hover:text-foreground"
                  >
                    New box
                  </button>
                )}
                {canDelete && !image.curated && image.id && (
                  <button
                    type="button"
                    onClick={() => setPendingRemove(image)}
                    // Radix unmounts the dialog on confirm, so this is the
                    // control still on screen while the delete is in flight —
                    // and re-opening from here is what would send a second DELETE.
                    disabled={deleteImage.isPending}
                    title={`Remove ${image.name}`}
                    className="p-[5px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
                  >
                    <Trash className="size-[15px]" />
                  </button>
                )}
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

      <CreateBoxDialog
        open={newBoxImage !== null}
        onOpenChange={(open) => !open && setNewBoxImage(null)}
        prefillImage={newBoxImage ?? undefined}
      />

      <AlertDialog open={!!pendingRemove} onOpenChange={(open) => !open && setPendingRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingRemove?.name}?</AlertDialogTitle>
            {/* What a reader would otherwise get wrong: that this frees
                storage, and that it is final. It is neither. */}
            <AlertDialogDescription asChild>
              <div className="space-y-2 font-mono text-meta">
                <p>This frees one of your {usage?.limit ?? ''} image slots. Nothing is deleted from any box.</p>
                <p>
                  It is refused while any box, running or stopped, still references the image. Starting a box from it
                  later pulls it again and adds it back.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingRemove && handleRemove(pendingRemove)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
