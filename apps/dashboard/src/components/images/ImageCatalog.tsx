import { QuotaTicks } from '@/components/QuotaTicks'
import { TechnicalText, FormattedBytes } from '@/components/TechnicalText'
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ResourceEmptyState, ResourceFilter, ResourceIdentity } from '@/components/ResourceLayout'
import { AsciiButton } from '@/components/ascii'
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
import { Layers, Trash } from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { useDeleteImageMutation } from '@/hooks/mutations/useDeleteImageMutation'
import { useBoxesByImageQuery } from '@/hooks/queries/useBoxesByImageQuery'
import { useImageUsageQuery, useImagesQuery } from '@/hooks/queries/useImagesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { timeAgo } from '@/lib/format'
import { conflictBoxIds, imageRouteKey, imageStartRef } from '@/lib/image-ref'
import { BOX_TEMPLATES } from '@/lib/quickstart/box-templates'
import { cn } from '@/lib/utils'
import { BoxliteError } from '@/api/errors'
import { Box, Image, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import React, { useEffect, useMemo, useState } from 'react'
import { generatePath, Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

// One definition for the header and every row, for the reason spelled out in
// Volumes: two grid containers solving independently drift apart column by
// column.
// `min-w` keeps every column readable on a phone: the list scrolls sideways inside its own box.
const ROW_GRID =
  'grid min-w-[760px] grid-cols-[minmax(0,2.6fr)_minmax(0,1.2fr)_72px_48px_100px_110px] items-center gap-4'

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

  const { data: images = [], error: imagesError, isLoading } = useImagesQuery()
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
      <div className="resource-toolbar">
        <ResourceFilter
          label="Filter images"
          value={filter}
          onChange={(value) => setFilter(value)}
          count={rows.length}
        />
        {usage && (
          <div>
            <div className="flex flex-wrap items-center gap-4">
              <span
                className={cn(
                  'inline-flex items-center gap-2 whitespace-nowrap font-mono text-meta tabular-nums',
                  atLimit
                    ? 'text-destructive'
                    : nearLimit
                      ? 'text-yellow-600 dark:text-yellow-400'
                      : 'text-muted-foreground',
                )}
              >
                Custom images {usage.count} / {usage.limit}
                <QuotaTicks used={usage.count} limit={usage.limit} />
              </span>
              <span aria-hidden="true" className="text-meta text-muted-foreground">
                ·
              </span>
              <span className="whitespace-nowrap font-mono text-meta tabular-nums text-muted-foreground">
                Total image size <FormattedBytes bytes={usage.knownBytes} />
              </span>
              {atLimit && (
                <span className="font-sans text-meta text-muted-foreground">
                  At the limit. Remove an image, or contact us to raise it.
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mt-[14px] flex min-h-0 flex-1 flex-col overflow-auto">
        <div className={cn(ROW_GRID, 'resource-list-head')}>
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
            <div key={key} className={cn(ROW_GRID, 'resource-list-row')}>
              <button
                type="button"
                onClick={() =>
                  image.templateId && !image.id
                    ? openTemplate(image.templateId)
                    : navigate(generatePath(RoutePath.IMAGE_DETAILS, { idOrRef: imageRouteKey(image) }))
                }
                className="min-w-0 text-left outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                title={image.curatedRef ?? image.name}
                aria-label={image.name}
              >
                <ResourceIdentity icon={<Layers />}>
                  <TechnicalText value={image.curatedRef ?? image.name} className="resource-name hover:underline" />
                </ResourceIdentity>
              </button>
              <span className="truncate font-mono text-meta text-muted-foreground" title={image.aliases.join(', ')}>
                {image.aliases.length === 0
                  ? '—'
                  : image.aliases.length === 1
                    ? image.aliases[0]
                    : `${image.aliases[0]} +${image.aliases.length - 1}`}
              </span>
              <span className="font-mono text-meta tabular-nums text-muted-foreground">
                <FormattedBytes bytes={image.sizeBytes} />
              </span>
              <span className="font-mono text-meta tabular-nums text-muted-foreground">
                {boxes.length > 0 ? boxes.length : '—'}
              </span>
              <span className="font-mono text-meta text-muted-foreground">{timeAgo(image.lastUsedAt)}</span>
              <div className="flex items-center justify-end gap-1">
                {canCreateBox && (
                  <AsciiButton
                    variant="quiet"
                    size="sm"
                    type="button"
                    onClick={() =>
                      image.templateId ? openTemplate(image.templateId) : setNewBoxImage(imageStartRef(image))
                    }
                    title={`New Box from ${imageStartRef(image)}`}
                  >
                    New Box
                  </AsciiButton>
                )}
                {canDelete && !image.curated && image.id && (
                  <AsciiButton
                    variant="quiet-danger"
                    size="icon"
                    aria-label={`Remove ${image.name}`}
                    type="button"
                    onClick={() => setPendingRemove(image)}
                    // Radix unmounts the dialog on confirm, so this is the
                    // control still on screen while the delete is in flight —
                    // and re-opening from here is what would send a second DELETE.
                    disabled={deleteImage.isPending}
                    title={`Remove ${image.name}`}
                  >
                    <Trash className="size-[15px]" />
                  </AsciiButton>
                )}
              </div>
            </div>
          )
        })}

        {isLoading ? (
          <p role="status" className="px-4 py-12 text-body text-muted-foreground">
            Loading images…
          </p>
        ) : imagesError ? (
          <p role="alert" className="px-4 py-12 text-body text-muted-foreground">
            {images.length > 0
              ? 'Could not refresh images. Showing previously loaded data.'
              : 'Images are unavailable. Reload to try again.'}
          </p>
        ) : rows.length === 0 && !filter.trim() ? (
          <ResourceEmptyState
            title="No images yet"
            description="Create a Box from the Boxes page to add an image. Images appear here after a Box starts successfully."
          />
        ) : null}
        {!isLoading && !imagesError && rows.length === 0 && filter.trim() && (
          <div className="flex flex-col items-center gap-3 py-10 text-center font-mono text-meta text-muted-foreground">
            <span>No image matches “{filter.trim()}”</span>
            <AsciiButton size="sm" type="button" onClick={() => setFilter('')}>
              Clear filter
            </AsciiButton>
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
              <div className="space-y-2 font-sans text-meta">
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
