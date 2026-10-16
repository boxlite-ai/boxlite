/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AsciiButton, Panel, PanelNote, SectionTitle } from '@/components/ascii'
import { CreateBoxDialog } from '@/components/Box/CreateBoxDialog'
import { UseImageSheet } from '@/components/images/UseImageSheet'
import { BoxState } from '@/components/BoxTable/BoxState'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ArrowLeft } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RoutePath } from '@/enums/RoutePath'
import { usePinImageTagMutation, useUnpinImageTagMutation } from '@/hooks/mutations/useImageAliasMutations'
import { useBoxesByImageQuery } from '@/hooks/queries/useBoxesByImageQuery'
import { useImageQuery } from '@/hooks/queries/useImagesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { formatBytes, timeAgo } from '@/lib/format'
import { imageStartRef, shortDigest, TAG_PATTERN } from '@/lib/image-ref'
import { cn } from '@/lib/utils'
import { ImageDetail, ImageVersion, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import React, { useEffect, useMemo, useState } from 'react'
import { generatePath, Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

const TAG_GRID = 'grid grid-cols-[0.8fr_1.6fr_1fr_80px] items-center gap-3 px-2'
const VERSION_GRID = 'grid grid-cols-[1.3fr_0.8fr_0.5fr_1.2fr_0.6fr_0.6fr_90px] items-center gap-3 px-2'
const BOX_GRID = 'grid grid-cols-[1fr_1fr_1fr] items-center gap-3 px-2'
const HISTORY_GRID = 'grid grid-cols-[0.7fr_1.4fr_0.9fr_0.6fr] items-center gap-3 px-2'
// The most alias events an image's detail carries, newest first: the API's
// IMAGE_HISTORY_LIMIT. A full page means older events exist and are not shown.
const HISTORY_LIMIT = 100

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

function HeaderRow({ grid, children }: { grid: string; children: React.ReactNode }) {
  return (
    <div className={cn(grid, 'border-b border-border pb-2 font-mono text-label uppercase text-muted-foreground')}>
      {children}
    </div>
  )
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-[16px] font-mono text-meta text-muted-foreground">{children}</p>
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
  const { byImage, truncated } = useBoxesByImageQuery()
  const pinTag = usePinImageTagMutation()
  const unpinTag = useUnpinImageTagMutation()

  const canWrite = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_IMAGES)
  const canCreateBox = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const [newBoxImage, setNewBoxImage] = useState<string | null>(null)
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
          <div className="mb-[18px] flex flex-wrap items-end justify-between gap-3">
            <h1 className="truncate font-display text-page font-semibold text-foreground">{image.name}</h1>
            <div className="flex items-center gap-2">
              <AsciiButton onClick={() => setCodeRef(imageStartRef(image))} title="The create call in your SDK">
                Code
              </AsciiButton>
              {canCreateBox && (
                <AsciiButton variant="primary" onClick={() => setNewBoxImage(imageStartRef(image))}>
                  New box
                </AsciiButton>
              )}
            </div>
          </div>

          <Panel className="px-[18px] py-[16px]">
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
              <Field label="Source" value={image.curated ? 'Built-in' : 'Pulled by your boxes'} />
              <Field label="Versions" value={image.curated ? '—' : image.versionCount} />
              <Field label="Size" value={image.curated ? '—' : formatBytes(image.sizeBytes)} />
              <Field label="Last started" value={image.curated ? '—' : timeAgo(image.lastUsedAt)} />
            </div>
            {image.curated && (
              <PanelNote>
                Maintained by BoxLite as <span className="text-foreground">{image.curatedRef}</span>. Free, always
                available, and not counted against your limit. Its tag is managed for you.
              </PanelNote>
            )}
          </Panel>

          <div className="mt-[18px] flex min-h-0 flex-1 flex-col overflow-y-auto">
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

            <SectionTitle title="Versions" />
            <HeaderRow grid={VERSION_GRID}>
              <span>Digest</span>
              <span>Tags</span>
              <span>Size</span>
              <span>Pulled from</span>
              <span>Last started</span>
              <span>First seen</span>
              <span />
            </HeaderRow>
            {image.versions.length === 0 ? (
              <EmptyRow>
                {image.curated
                  ? 'Built-in images are operator configuration; no versions are recorded for them.'
                  : 'No versions recorded yet.'}
              </EmptyRow>
            ) : (
              image.versions.map((version) => (
                <VersionRow
                  key={version.id}
                  image={image}
                  version={version}
                  onUse={canCreateBox ? () => setNewBoxImage(`${image.name}@${version.digest}`) : undefined}
                />
              ))
            )}

            {!image.curated && (
              <>
                <div className="mt-[26px]">
                  <SectionTitle
                    title="Boxes referencing this image"
                    count={
                      boxes.length === 0
                        ? 'none'
                        : `${boxes.length}${truncated ? '+' : ''} · all must be destroyed before removal`
                    }
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
                      <div key={box.id} className={cn(BOX_GRID, 'border-b border-border/60 py-[11px] text-body')}>
                        <Link
                          to={generatePath(RoutePath.BOX_DETAILS, { boxId: box.id })}
                          className="truncate font-mono text-meta font-medium text-foreground hover:underline"
                        >
                          {box.name}
                        </Link>
                        <BoxState state={box.state} errorReason={box.errorReason} className="text-meta" />
                        <span className="font-mono text-meta text-muted-foreground">{timeAgo(box.createdAt)}</span>
                      </div>
                    ))}
                  </>
                )}

                <div className="mt-[26px]">
                  <SectionTitle title="Pin history" count="unpins are not recorded" />
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
                      className={cn(HISTORY_GRID, 'border-b border-border/60 py-[11px] text-body')}
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
                  <p className="px-2 py-[12px] font-mono text-meta text-muted-foreground">
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
                    Boxes that start from <span className="font-mono text-foreground">{image.name}:tag</span> get this
                    version until the tag is unpinned.
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
                            {formatBytes(version.sizeBytes)}
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

      <CreateBoxDialog
        open={newBoxImage !== null}
        onOpenChange={(open) => !open && setNewBoxImage(null)}
        prefillImage={newBoxImage ?? undefined}
      />
      <UseImageSheet imageRef={codeRef} onClose={() => setCodeRef(null)} />
    </div>
  )
}

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
      <SectionTitle
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
            <div key={alias} className={cn(TAG_GRID, 'border-b border-border/60 py-[11px] text-body')}>
              <span className="truncate font-mono text-meta font-medium text-foreground">{alias}</span>
              <span className="truncate font-mono text-meta text-muted-foreground" title={version?.digest}>
                {version ? shortDigest(version.digest) : '—'}
              </span>
              <span className="font-mono text-meta text-muted-foreground">
                {event ? `${timeAgo(event.createdAt)}${event.actorId ? '' : ' on first pull'}` : '—'}
              </span>
              <div className="flex justify-end">
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => onUnpin(alias)}
                    disabled={busy}
                    className="px-2 py-[3px] font-mono text-label uppercase text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
                  >
                    Unpin
                  </button>
                )}
              </div>
            </div>
          )
        })
      )}
      <PanelNote>
        A tag stays pinned to the digest it first resolved to; a new push upstream does not move it. To repoint one,
        unpin it and pin it again. Boxes already running are unaffected either way.
      </PanelNote>
    </div>
  )
}

function VersionRow({ image, version, onUse }: { image: ImageDetail; version: ImageVersion; onUse?: () => void }) {
  return (
    <div className={cn(VERSION_GRID, 'border-b border-border/60 py-[13px] text-body')}>
      <span className="flex min-w-0 flex-col">
        <span title={version.digest} className="truncate font-mono text-meta text-foreground">
          {version.digest}
        </span>
        {/* Recorded once, when a pull found the registry without this digest;
            nothing clears it, so it is past tense: the copy here still starts. */}
        {version.upstreamMissingAt && (
          <span
            title={`A pull ${timeAgo(version.upstreamMissingAt)} found this digest gone from ${image.name.split('/')[0]}. BoxLite's copy still starts boxes.`}
            className="font-mono text-label uppercase text-yellow-600 dark:text-yellow-400"
          >
            Gone upstream {timeAgo(version.upstreamMissingAt)}
          </span>
        )}
      </span>
      <span className="truncate font-mono text-meta text-muted-foreground">
        {version.aliases.length > 0 ? version.aliases.join(', ') : '—'}
      </span>
      <span className="font-mono text-meta tabular-nums text-muted-foreground">{formatBytes(version.sizeBytes)}</span>
      {/* What the caller typed, kept verbatim. Not where the bytes live now:
          the tag it names may have moved upstream. */}
      <span title={version.sourceRef} className="truncate font-mono text-meta text-muted-foreground">
        {version.sourceRef}
      </span>
      {/* Null is a version recorded before last start was tracked: unknown,
          which "never" would misstate. */}
      <span className="font-mono text-meta text-muted-foreground">
        {version.lastUsedAt ? timeAgo(version.lastUsedAt) : '—'}
      </span>
      <span className="font-mono text-meta text-muted-foreground">{timeAgo(version.createdAt)}</span>
      <div className="flex justify-end">
        {onUse && (
          <button
            type="button"
            onClick={onUse}
            title="New box pinned to this digest"
            className="px-2 py-[3px] font-mono text-label uppercase text-muted-foreground transition-colors hover:text-foreground"
          >
            New box
          </button>
        )}
      </div>
    </div>
  )
}

export default ImageDetails
