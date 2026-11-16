/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { TechnicalText, FormattedBytes } from '@/components/TechnicalText'
import { AsciiButton, PanelNote } from '@/components/ascii'
import { UseImageSheet } from '@/components/images/UseImageSheet'
import { BoxStatusIndicator } from '@/components/boxes/box-presentation'
import { CopyButton } from '@/components/CopyButton'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { ArrowLeft } from '@/components/ui/icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RoutePath } from '@/enums/RoutePath'
import { usePinImageTagMutation, useUnpinImageTagMutation } from '@/hooks/mutations/useImageAliasMutations'
import { useBoxesByImageQuery } from '@/hooks/queries/useBoxesByImageQuery'
import { useImageQuery } from '@/hooks/queries/useImagesQuery'
import { usePageTitle } from '@/hooks/usePageTitle'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { timeAgo } from '@/lib/format'
import { imageStartRef, shortDigest, TAG_PATTERN } from '@/lib/image-ref'
import { cn } from '@/lib/utils'
import { ImageDetail, ImageVersion, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import React, { useEffect, useMemo, useState } from 'react'
import { generatePath, Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

const TAG_GRID = 'grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)_minmax(0,1fr)_80px] items-center gap-6'
const VERSION_GRID =
  'grid min-w-[700px] grid-cols-[minmax(300px,1.8fr)_minmax(100px,0.8fr)_90px_110px] items-center gap-4'
const BOX_GRID = 'grid grid-cols-3 items-center gap-6'
const HISTORY_GRID =
  'grid grid-cols-[minmax(0,0.7fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.6fr)] items-center gap-6'
// The most alias events an image's detail carries, newest first: the API's
// IMAGE_HISTORY_LIMIT. A full page means older events exist and are not shown.
const HISTORY_LIMIT = 100

function Field({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <span className="shrink-0 font-sans text-meta text-muted-foreground">{label}</span>
      <span title={title} className="truncate font-mono text-meta text-foreground">
        {value}
      </span>
    </div>
  )
}

/** Quiet section hierarchy shared by all groups on this detail page. */
function DetailSection({ title, count, right }: { title: string; count?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex min-h-9 items-center justify-between gap-3 border-b border-border">
      <div className="flex items-baseline gap-3">
        <h2 className="text-body font-semibold">{title}</h2>
        {count && <span className="text-meta text-muted-foreground">{count}</span>}
      </div>
      {right}
    </div>
  )
}

function HeaderRow({ grid, children }: { grid: string; children: React.ReactNode }) {
  return <div className={cn(grid, 'resource-list-head')}>{children}</div>
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-[16px] font-sans text-meta text-muted-foreground">{children}</p>
}

/**
 * One image: its pinned tags, the versions behind them, the boxes that still
 * reference it, and when each tag was pinned.
 *
 * A tag here is pinned: it keeps the digest it first resolved to, whatever
 * the registry's tag does later. Pinning and unpinning are the two writes the
 * API offers; there is no move, so repointing is an unpin and a pin.
 */
const ImageDetails: React.FC = () => {
  const navigate = useNavigate()
  const { idOrRef } = useParams<{ idOrRef: string }>()
  const { selectedOrganization, organizationMembers, authenticatedUserHasPermission } = useSelectedOrganization()
  const { data: image, isLoading, error } = useImageQuery(idOrRef)
  usePageTitle(image?.name ?? 'Image')
  const { byImage, truncated } = useBoxesByImageQuery()
  const pinTag = usePinImageTagMutation()
  const unpinTag = useUnpinImageTagMutation()

  const canWrite = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_IMAGES)
  const [codeRef, setCodeRef] = useState<string | null>(null)
  const [pinning, setPinning] = useState(false)
  const [pinForm, setPinForm] = useState({ alias: '', versionId: '' })

  useEffect(() => {
    if (error) handleApiError(error, 'Failed to fetch image')
  }, [error])

  const versionsById = useMemo(
    () => new Map((image?.versions ?? []).map((version) => [version.id, version])),
    [image?.versions],
  )
  const membersById = useMemo(
    () => new Map(organizationMembers.map((member) => [member.userId, member.name || member.email])),
    [organizationMembers],
  )
  const boxes = image ? (byImage.get(image.name) ?? []) : []
  const readyVersions = image?.versions ?? []

  const openPin = () => {
    setPinForm({ alias: '', versionId: readyVersions[0]?.id ?? '' })
    setPinning(true)
  }

  const handlePin = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!image || !idOrRef) return
    try {
      await pinTag.mutateAsync({ idOrRef, ...pinForm, organizationId: selectedOrganization?.id })
      const version = versionsById.get(pinForm.versionId)
      toast.success(`Pinned ${pinForm.alias}`, {
        description: version ? `${image.name}:${pinForm.alias} now starts ${shortDigest(version.digest)}` : undefined,
      })
      setPinning(false)
    } catch (err) {
      handleApiError(err, `Could not pin ${pinForm.alias}`)
    }
  }

  const handleUnpin = async (alias: string) => {
    if (!image || !idOrRef) return
    try {
      await unpinTag.mutateAsync({ idOrRef, alias, organizationId: selectedOrganization?.id })
      toast.success(`Unpinned ${alias}`, {
        description: `Boxes already running keep their version. ${image.name}:${alias} is free to pin again.`,
      })
    } catch (err) {
      handleApiError(err, `Could not unpin ${alias}`)
    }
  }

  const tagIsValid = TAG_PATTERN.test(pinForm.alias)
  const tagTaken = image?.aliases.includes(pinForm.alias) ?? false

  return (
    <div className="page-container flex min-w-0 flex-col pb-8 pt-5 lg:pt-[26px]">
      <button
        type="button"
        onClick={() => navigate(RoutePath.IMAGES)}
        className="mb-[14px] inline-flex w-fit items-center gap-2 font-sans text-meta text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Images
      </button>

      {isLoading && <p className="font-sans text-body text-muted-foreground">Loading…</p>}

      {image && (
        <>
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <h1
              className="min-w-0 flex-1 truncate font-mono text-page font-semibold text-foreground"
              title={image.name}
            >
              <TechnicalText value={image.name} />
            </h1>
            <div className="flex items-center gap-2">
              <AsciiButton onClick={() => setCodeRef(imageStartRef(image))}>View SDK example</AsciiButton>
            </div>
          </div>

          <div className="pb-5">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <Field
                label="Source"
                value={<span className="font-sans">{image.curated ? 'Built-in' : 'Pulled by your boxes'}</span>}
              />
              <Field label="Versions" value={image.curated ? '—' : image.versionCount} />
              <Field label="Size" value={image.curated ? '—' : <FormattedBytes bytes={image.sizeBytes} />} />
              <Field label="Last started" value={image.curated ? '—' : timeAgo(image.lastUsedAt)} />
            </div>
            {image.curated && (
              <PanelNote>
                Maintained by BoxLite as <TechnicalText value={image.curatedRef ?? image.name} />. Free, always
                available, and not counted against your limit. Its tag is managed for you.
              </PanelNote>
            )}
          </div>

          <div className="mt-2 flex min-w-0 flex-col">
            {!image.curated && (
              <TagsSection
                image={image}
                versionsById={versionsById}
                canWrite={canWrite}
                busy={pinTag.isPending || unpinTag.isPending}
                onPin={openPin}
                onUnpin={handleUnpin}
              />
            )}

            <DetailSection title="Versions" />
            <div className="min-w-0 overflow-x-auto">
              <HeaderRow grid={VERSION_GRID}>
                <span>Digest</span>
                <span>Tags</span>
                <span>Size</span>
                <span>Last started</span>
              </HeaderRow>
              {image.versions.length === 0 ? (
                <EmptyRow>
                  {image.curated
                    ? 'Built-in images are operator configuration; no versions are recorded for them.'
                    : 'No versions recorded yet.'}
                </EmptyRow>
              ) : (
                image.versions.map((version) => <VersionRow key={version.id} image={image} version={version} />)
              )}
            </div>

            {!image.curated && (
              <>
                <div className="mt-[26px]">
                  <DetailSection
                    title="Boxes referencing this image"
                    count={boxes.length === 0 ? 'none' : `${boxes.length}${truncated ? '+' : ''}`}
                  />
                </div>
                {boxes.length === 0 ? (
                  <EmptyRow>No box references it, so it can be removed.</EmptyRow>
                ) : (
                  <>
                    <HeaderRow grid={BOX_GRID}>
                      <span>Box</span>
                      <span>State</span>
                      <span>Created</span>
                    </HeaderRow>
                    {boxes.map((box) => (
                      <div key={box.id} className={cn(BOX_GRID, 'resource-list-row')}>
                        <Link
                          to={generatePath(RoutePath.BOX_DETAILS, { boxId: box.id })}
                          className="truncate font-mono text-meta font-medium text-foreground hover:underline"
                        >
                          {box.name}
                        </Link>
                        <span title={box.errorReason}>
                          <BoxStatusIndicator box={box} />
                        </span>
                        <span className="font-mono text-meta text-muted-foreground">{timeAgo(box.createdAt)}</span>
                      </div>
                    ))}
                  </>
                )}

                <div className="mt-[26px]">
                  <DetailSection title="Pin history" count="unpins are not recorded" />
                </div>
                <HeaderRow grid={HISTORY_GRID}>
                  <span>Tag</span>
                  <span>Pinned to</span>
                  <span>By</span>
                  <span>When</span>
                </HeaderRow>
                {image.history.length === 0 ? (
                  <EmptyRow>
                    {image.aliases.length > 0
                      ? 'No history: these tags were pinned before history was kept.'
                      : 'No tag has been pinned yet.'}
                  </EmptyRow>
                ) : (
                  image.history.map((event) => (
                    <div
                      key={`${event.aliasName}-${event.createdAt}-${event.toVersionId}`}
                      className={cn(HISTORY_GRID, 'resource-list-row')}
                    >
                      <span className="truncate font-mono text-meta text-foreground">{event.aliasName}</span>
                      <span className="truncate font-mono text-meta text-muted-foreground" title={event.toDigest}>
                        {shortDigest(event.toDigest)}
                      </span>
                      {/* No actor: the first pull of that tag pinned it. */}
                      <span
                        title={event.actorId ?? undefined}
                        className="truncate font-mono text-meta text-muted-foreground"
                      >
                        {event.actorId ? (membersById.get(event.actorId) ?? 'a member') : 'first pull'}
                      </span>
                      <span className="font-mono text-meta text-muted-foreground">{timeAgo(event.createdAt)}</span>
                    </div>
                  ))
                )}
                {image.history.length >= HISTORY_LIMIT && (
                  <p className="px-2 py-[12px] font-sans text-meta text-muted-foreground">
                    Showing the latest {HISTORY_LIMIT} events; older ones are not listed.
                  </p>
                )}
              </>
            )}
          </div>

          <Dialog open={pinning} onOpenChange={(open) => !open && setPinning(false)}>
            <DialogContent>
              <form onSubmit={handlePin}>
                <DialogHeader>
                  <DialogTitle>Pin a tag</DialogTitle>
                  <DialogDescription>
                    A tag stays pinned to its digest even if the upstream tag moves. To change its version, unpin it and
                    pin it again. Boxes already running are unaffected.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 py-4">
                  <div className="space-y-1">
                    <Label htmlFor="pin-tag">Tag</Label>
                    <Input
                      id="pin-tag"
                      value={pinForm.alias}
                      onChange={(event) => setPinForm({ ...pinForm, alias: event.target.value })}
                      placeholder="stable"
                      spellCheck={false}
                      className="font-mono"
                      autoFocus
                      required
                    />
                    {pinForm.alias && !tagIsValid && (
                      <PanelNote>
                        Letters, digits, `_`, `.` and `-`; up to 128 characters, not starting with `.` or `-`.
                      </PanelNote>
                    )}
                    {tagTaken && <PanelNote>{pinForm.alias} is already pinned. Unpin it first.</PanelNote>}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="pin-version">Version</Label>
                    <Select
                      value={pinForm.versionId}
                      onValueChange={(value) => setPinForm({ ...pinForm, versionId: value })}
                    >
                      <SelectTrigger id="pin-version" className="h-9 w-full font-mono">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {readyVersions.map((version) => (
                          <SelectItem key={version.id} value={version.id} className="font-mono">
                            {shortDigest(version.digest)} · {version.aliases.join(', ') || 'no tag'} ·{' '}
                            <FormattedBytes bytes={version.sizeBytes} />
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setPinning(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!tagIsValid || tagTaken || !pinForm.versionId || pinTag.isPending}>
                    Pin
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </>
      )}

      <UseImageSheet imageRef={codeRef} onClose={() => setCodeRef(null)} />
    </div>
  )
}

/**
 * Shows each pinned alias with its resolved digest and recorded pin time.
 * Write permission gates pin/unpin actions, which stay disabled during mutations.
 */
function TagsSection({
  image,
  versionsById,
  canWrite,
  busy,
  onPin,
  onUnpin,
}: {
  image: ImageDetail
  versionsById: Map<string, ImageVersion>
  canWrite: boolean
  busy: boolean
  onPin: () => void
  onUnpin: (alias: string) => void
}) {
  // Each tag's version is the one listing it; the detail keeps that on the version.
  const versionOf = (alias: string) => [...versionsById.values()].find((version) => version.aliases.includes(alias))
  const pinnedAt = (alias: string) => image.history.find((event) => event.aliasName === alias)

  return (
    <div className="mb-[26px]">
      <DetailSection
        title="Tags"
        count={`${image.aliases.length} pinned`}
        right={
          canWrite && (
            <AsciiButton onClick={onPin} disabled={busy || image.versions.length === 0}>
              Pin a tag
            </AsciiButton>
          )
        }
      />
      <HeaderRow grid={TAG_GRID}>
        <span>Tag</span>
        <span>Pinned to</span>
        <span>Since</span>
        <span />
      </HeaderRow>
      {image.aliases.length === 0 ? (
        <EmptyRow>No tag is pinned. Boxes can still start from a digest.</EmptyRow>
      ) : (
        image.aliases.map((alias) => {
          const version = versionOf(alias)
          const event = pinnedAt(alias)
          return (
            <div key={alias} className={cn(TAG_GRID, 'resource-list-row')}>
              <span className="truncate font-mono text-meta font-medium text-foreground">{alias}</span>
              <span className="truncate font-mono text-meta text-muted-foreground" title={version?.digest}>
                {version ? shortDigest(version.digest) : '—'}
              </span>
              <span className="font-mono text-meta text-muted-foreground">
                {event ? `${timeAgo(event.createdAt)}${event.actorId ? '' : ' on first pull'}` : '—'}
              </span>
              <div className="flex justify-end">
                {canWrite && (
                  <AsciiButton
                    variant="quiet-danger"
                    size="sm"
                    type="button"
                    onClick={() => onUnpin(alias)}
                    title="Release this tag; running Boxes keep their version"
                    disabled={busy}
                  >
                    Unpin
                  </AsciiButton>
                )}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

/** The digest opens complete provenance details without a competing creation flow. */
function VersionRow({ image, version }: { image: ImageDetail; version: ImageVersion }) {
  const upstreamNote = version.upstreamMissingAt
    ? `A pull ${timeAgo(version.upstreamMissingAt)} found this digest gone from ${image.name.split('/')[0]}. Runners that cached this version can still start it. Elsewhere, pin an available version under a new alias.`
    : null

  return (
    <div className={cn(VERSION_GRID, 'resource-list-row')}>
      <div className="flex min-w-0 items-center gap-3">
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              aria-label={`View version ${version.digest}`}
              title={version.digest}
              className="min-w-0 truncate text-left font-mono text-meta text-foreground underline-offset-4 hover:underline"
            >
              {shortDigest(version.digest)}
            </button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader className="shrink-0">
              <DialogTitle>Version details</DialogTitle>
              <DialogDescription>Recorded provenance for this image version.</DialogDescription>
            </DialogHeader>
            <dl className="min-h-0 space-y-4 overflow-y-auto py-4 text-meta">
              <div>
                <dt className="mb-1 text-muted-foreground">Digest</dt>
                <dd className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 break-all">{version.digest}</code>
                  <CopyButton value={version.digest} tooltipText="Copy digest" size="icon-xs" />
                </dd>
              </div>
              <div>
                <dt className="mb-1 text-muted-foreground">Pulled from</dt>
                <dd className="break-all font-mono">{version.sourceRef || '—'}</dd>
              </div>
              <div>
                <dt className="mb-1 text-muted-foreground">First seen</dt>
                <dd title={version.createdAt}>{timeAgo(version.createdAt)}</dd>
              </div>
              <div>
                <dt className="mb-1 text-muted-foreground">Upstream</dt>
                <dd>{upstreamNote ?? 'No missing digest reported.'}</dd>
              </div>
            </dl>
          </DialogContent>
        </Dialog>
        {upstreamNote && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                title={upstreamNote}
                className="shrink-0 whitespace-nowrap text-meta text-warning focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground"
              >
                Gone upstream
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">{upstreamNote}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <span className="truncate font-mono text-meta text-muted-foreground" title={version.aliases.join(', ')}>
        {version.aliases.length > 0 ? version.aliases.join(', ') : '—'}
      </span>
      <span className="font-mono text-meta tabular-nums text-muted-foreground">
        <FormattedBytes bytes={version.sizeBytes} />
      </span>
      {/* Older records have unknown last-start times, not a confirmed "never". */}
      <span className="font-mono text-meta text-muted-foreground">
        {version.lastUsedAt ? timeAgo(version.lastUsedAt) : '—'}
      </span>
    </div>
  )
}

export default ImageDetails
