/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationSuspendedError } from '@/api/errors'
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
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { RoutePath } from '@/enums/RoutePath'
import { useImagesQuery } from '@/hooks/queries/useImagesQuery'
import { useVolumesQuery } from '@/hooks/queries/useVolumesQuery'
import { useDeleteBoxMutation } from '@/hooks/mutations/useDeleteBoxMutation'
import { useRecoverBoxMutation } from '@/hooks/mutations/useRecoverBoxMutation'
import { useStartBoxMutation } from '@/hooks/mutations/useStartBoxMutation'
import { useStopBoxMutation } from '@/hooks/mutations/useStopBoxMutation'
import { useBoxQuery } from '@/hooks/queries/useBoxQuery'
import { useConfig } from '@/hooks/useConfig'
import { useRegions } from '@/hooks/useRegions'
import { useBoxWsSync } from '@/hooks/useBoxWsSync'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getBoxDisplayName, getBoxPublicId, getBoxPublicIdLabel } from '@/lib/box-identity'
import { handleApiError } from '@/lib/error-handling'
import {
  mergeOnboardingProgress,
  ONBOARDING_PROGRESS_EVENT,
  readOnboardingProgress,
  type OnboardingProgress,
} from '@/lib/onboarding-progress'
import { catalogNameOf, registryHostOf } from '@/lib/image-ref'
import { getRelativeTimeString } from '@/lib/utils'
import { isRecoverable, isStartable, isStoppable, isTransitioning } from '@/lib/utils/box'
import { Box, BoxState, OrganizationRolePermissionsEnum, OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { isAxiosError } from 'axios'
import { Check, Container, Copy, MoreVertical, Play, RefreshCw, RotateCcw, Square, Trash2 } from '@/components/ui/icon'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from 'react-oidc-context'
import { generatePath, Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { usePageTitle } from '@/hooks/usePageTitle'
import { copyToClipboard } from '@/lib/copy-text'
import { toast } from 'sonner'
import { BoxNetworkSection } from './BoxNetworkSection'
import { BoxTerminalTab } from './BoxTerminalTab'
import { BoxSshTab } from './BoxSshTab'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const STATUS = { running: '#5ad67d', idle: '#e0b341', stopped: '#8C919C', error: '#e0564a', dim: '#5b616e' } as const

function statusOf(box: Box): { label: string; color: string } {
  switch (box.state) {
    case BoxState.STARTED:
      return { label: 'Running', color: STATUS.running }
    case BoxState.STOPPED:
      return { label: 'Stopped', color: STATUS.dim }
    case BoxState.ERROR:
      return { label: 'Error', color: STATUS.error }
    case BoxState.CREATING:
    case BoxState.STARTING:
    case BoxState.RESTORING:
      return { label: 'Starting', color: STATUS.idle }
    case BoxState.STOPPING:
      return { label: 'Stopping', color: STATUS.idle }
    case BoxState.DESTROYING:
      return { label: 'Deleting', color: STATUS.idle }
    default:
      return { label: (box.state ?? 'Unknown').replace(/^\w/, (c) => c.toUpperCase()), color: STATUS.dim }
  }
}

function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="mb-[10px] mt-[34px] flex items-center gap-[9px] first:mt-0">
      <span className="text-label leading-none text-brand">▸</span>
      <span className="text-meta uppercase tracking-[2px]">{title}</span>
      <span className="flex-1" />
      {right}
    </div>
  )
}

function SpecRow({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="mb-[6px] flex items-baseline gap-2">
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <span className="flex-1" />
      {title ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 max-w-[66%] cursor-default truncate text-right">{children}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[min(90vw,480px)] break-all font-mono">{title}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="min-w-0 max-w-[66%] truncate text-right">{children}</span>
      )}
    </div>
  )
}

/** Composes box metadata, connection controls and tab content within the shared application height. */
export default function BoxDetails() {
  const { boxId } = useParams<{ boxId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const config = useConfig()
  const { user } = useAuth()
  const userId = user?.profile.sub
  const { authenticatedUserOrganizationMember, selectedOrganization, authenticatedUserHasPermission } =
    useSelectedOrganization()
  const { getRegionName } = useRegions()

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [onboardingProgress, setOnboardingProgress] = useState<OnboardingProgress>(() => readOnboardingProgress(userId))
  const [copied, setCopied] = useState(false)
  const [copiedName, setCopiedName] = useState(false)
  const [terminalRefreshSignal, setTerminalRefreshSignal] = useState(0)
  const [sshStatusContainer, setSshStatusContainer] = useState<HTMLDivElement | null>(null)
  const refreshRef = useRef<HTMLSpanElement>(null)

  const updateOnboardingProgress = useCallback(
    (progress: OnboardingProgress) => {
      setOnboardingProgress(mergeOnboardingProgress(userId, progress))
    },
    [userId],
  )

  useEffect(() => {
    setOnboardingProgress(readOnboardingProgress(userId))
  }, [userId])

  useEffect(() => {
    const handleOnboardingProgress = (event: Event) => {
      const progress = (event as CustomEvent<OnboardingProgress>).detail
      setOnboardingProgress(progress ?? readOnboardingProgress(userId))
    }
    window.addEventListener(ONBOARDING_PROGRESS_EVENT, handleOnboardingProgress)
    return () => window.removeEventListener(ONBOARDING_PROGRESS_EVENT, handleOnboardingProgress)
  }, [userId])

  useEffect(() => {
    if (!selectedOrganization || !user?.profile.sub) return
    if (searchParams.get('onboarding') === '1') navigate(RoutePath.QUICKSTART, { replace: true })
  }, [navigate, searchParams, selectedOrganization, user?.profile.sub])

  const { data: box, isLoading, isError, error, refetch } = useBoxQuery(boxId ?? '')
  usePageTitle(box ? getBoxDisplayName(box) : 'Box')

  // Volumes this box mounts, with the stored handle resolved back to a name.
  const { data: allVolumes = [] } = useVolumesQuery()
  // The image the box names is linked once it is in the catalog, which a
  // first start puts it in; a built-in one is matched on its full reference.
  const { data: images = [] } = useImagesQuery()
  const catalogImage = box?.image
    ? images.find((image) =>
        image.curated ? image.curatedRef === box.image : image.name === catalogNameOf(box.image ?? ''),
      )
    : undefined
  const mountedVolumes = useMemo(() => {
    const mounts = (box?.volumes ?? []) as { volumeId: string; mountPath: string; subpath?: string }[]
    return mounts.map((mount) => {
      const match = allVolumes.find((v) => v.id === mount.volumeId || v.name === mount.volumeId)
      return { ...mount, displayName: match?.name ?? mount.volumeId }
    })
  }, [box?.volumes, allVolumes])

  const isNotFound = isError && isAxiosError(error.cause) && error.cause?.status === 404
  useBoxWsSync({ boxId })

  useEffect(() => {
    if (box && !onboardingProgress.boxCreated) {
      updateOnboardingProgress({ boxCreated: true })
    }
  }, [onboardingProgress.boxCreated, box, updateOnboardingProgress])

  const startMutation = useStartBoxMutation()
  const stopMutation = useStopBoxMutation()
  const recoverMutation = useRecoverBoxMutation()
  const deleteMutation = useDeleteBoxMutation()

  const writePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const deletePermitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_BOXES)
  const transitioning = box ? isTransitioning(box) : false
  const anyMutating =
    startMutation.isPending || stopMutation.isPending || recoverMutation.isPending || deleteMutation.isPending
  const actionsDisabled = anyMutating || transitioning

  const handleStart = async () => {
    if (!box) return
    try {
      await startMutation.mutateAsync({ boxId: box.id, detailRef: boxId })
      toast.success('Box started')
    } catch (error) {
      handleApiError(error, 'Failed to start box', {
        action:
          error instanceof OrganizationSuspendedError &&
          config.billingApiUrl &&
          authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER ? (
            <Button variant="secondary" onClick={() => navigate(RoutePath.BILLING)}>
              Go to billing
            </Button>
          ) : undefined,
      })
    }
  }

  const handleStop = async () => {
    if (!box) return
    try {
      await stopMutation.mutateAsync({ boxId: box.id, detailRef: boxId })
      toast.success('Box stopped')
    } catch (error) {
      handleApiError(error, 'Failed to stop box')
    }
  }

  const handleRecover = async () => {
    if (!box) return
    try {
      await recoverMutation.mutateAsync({ boxId: box.id, detailRef: boxId })
      toast.success('Box recovery started')
    } catch (error) {
      handleApiError(error, 'Failed to recover box')
    }
  }

  const handleDelete = async () => {
    if (!box) return
    try {
      await deleteMutation.mutateAsync({ boxId: box.id, detailRef: boxId })
      toast.success('Box deleted')
      setDeleteDialogOpen(false)
      navigate(RoutePath.BOXES)
    } catch (error) {
      handleApiError(error, 'Failed to delete box')
    }
  }

  const handleRefresh = () => {
    refetch()
    setTerminalRefreshSignal((signal) => signal + 1)
    const el = refreshRef.current
    if (el) {
      el.style.animation = 'none'
      void el.offsetWidth
      el.style.animation = 'spin .6s ease'
    }
  }

  const copyId = async () => {
    const id = box ? getBoxPublicId(box) : null
    if (!id) return
    if (!(await copyToClipboard(id))) {
      toast.error('Could not copy to clipboard')
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1300)
  }

  const copyName = async () => {
    if (!box) return
    if (!(await copyToClipboard(getBoxDisplayName(box)))) {
      toast.error('Could not copy to clipboard')
      return
    }
    setCopiedName(true)
    setTimeout(() => setCopiedName(false), 1300)
  }

  return (
    <div className="page-container flex h-[var(--app-content-height,calc(100svh_-_60px))] min-h-0 flex-col gap-[14px] pb-[22px] pt-4 font-mono text-body">
      {/* breadcrumb */}
      <div className="flex flex-none items-center gap-[9px] text-meta text-muted-foreground">
        <button
          type="button"
          onClick={() => navigate(RoutePath.BOXES)}
          className="inline-flex min-h-6 items-center hover:text-foreground"
        >
          Boxes
        </button>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span className="text-foreground">{box ? getBoxDisplayName(box) : boxId?.toLowerCase()}</span>
      </div>

      {isNotFound ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <Container className="size-8" strokeWidth={1.3} />
          <div className="text-foreground">Box not found</div>
          <div className="text-meta">Are you sure you&apos;re in the right organization?</div>
          <button
            type="button"
            onClick={() => navigate(RoutePath.BOXES)}
            className="mt-2 border border-border px-4 py-2 text-body transition-colors hover:bg-card"
          >
            Back to Boxes
          </button>
        </div>
      ) : isLoading || !box ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
          {isError ? (
            <button
              type="button"
              onClick={() => refetch()}
              className="inline-flex items-center gap-2 border border-border px-4 py-2 transition-colors hover:bg-card"
            >
              <RefreshCw className="size-4" /> Retry
            </button>
          ) : (
            <>
              <RefreshCw className="size-4 animate-spin" /> Loading box…
            </>
          )}
        </div>
      ) : (
        <>
          {/* identity strip */}
          <div className="flex flex-none flex-col gap-4 border-b border-border pb-[14px] lg:flex-row lg:items-center lg:gap-[18px]">
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:gap-[14px]">
              <span className="flex min-w-0 items-center gap-[12px]">
                <Container className="size-6 shrink-0 text-muted-foreground" />
                <span
                  className="max-w-full truncate font-display text-section font-semibold sm:max-w-[360px]"
                  title={getBoxDisplayName(box)}
                >
                  {getBoxDisplayName(box)}
                </span>
                <button
                  type="button"
                  onClick={copyName}
                  title="Copy name"
                  aria-label="Copy name"
                  className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  {copiedName ? (
                    <Check className="size-[15px]" style={{ color: STATUS.running }} />
                  ) : (
                    <Copy className="size-[15px]" />
                  )}
                </button>
              </span>
              <span className="flex flex-none items-center gap-2 text-body">
                <span
                  className="size-[8px] rounded-[2px]"
                  style={{ background: statusOf(box).color, boxShadow: `0 0 6px ${statusOf(box).color}` }}
                />
                <span className="font-medium">{statusOf(box).label}</span>
              </span>
            </div>

            <div className="flex flex-none flex-wrap items-center gap-2 sm:gap-[10px]">
              {/* SSH comes first in every state, then the state action, then the menu and refresh. */}
              <BoxSshTab box={box} refreshSignal={terminalRefreshSignal} statusContainer={sshStatusContainer} />
              {writePermitted && isRecoverable(box) && (
                <button
                  type="button"
                  onClick={handleRecover}
                  disabled={actionsDisabled}
                  className="flex h-9 items-center gap-2 border border-border px-[15px] text-body font-medium transition-colors hover:bg-background focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:opacity-50"
                >
                  <RotateCcw className="size-[14px]" /> Recover
                </button>
              )}
              {writePermitted && isStartable(box) && (
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={actionsDisabled}
                  className="flex h-9 items-center gap-2 border border-border px-[15px] text-body font-medium transition-colors hover:bg-background focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:opacity-50"
                >
                  <Play className="size-[14px]" fill="currentColor" /> Start
                </button>
              )}
              {writePermitted && isStoppable(box) && (
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={actionsDisabled}
                  className="flex h-9 items-center gap-2 border border-border px-[15px] text-body font-medium transition-colors hover:bg-background focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:opacity-50"
                >
                  <Square className="size-[12px]" fill="currentColor" /> Stop
                </button>
              )}
              {writePermitted &&
                isTransitioning(box) &&
                !isRecoverable(box) &&
                !isStartable(box) &&
                !isStoppable(box) && (
                  <button
                    type="button"
                    disabled
                    className="flex h-9 items-center gap-2 border border-border px-[15px] text-body font-medium text-muted-foreground"
                  >
                    <RefreshCw className="size-[14px] animate-spin" /> Working…
                  </button>
                )}
              {deletePermitted && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label="Open box actions"
                    className="flex size-9 items-center justify-center border border-border outline-none transition-colors hover:bg-background focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/35 data-[state=open]:bg-background sm:size-[34px]"
                  >
                    <MoreVertical className="size-[18px]" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[12rem]">
                    <DropdownMenuItem
                      className="cursor-pointer text-destructive focus:text-destructive"
                      onClick={() => setDeleteDialogOpen(true)}
                    >
                      <Trash2 className="size-4" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <button
                type="button"
                onClick={handleRefresh}
                title="Refresh"
                aria-label="Refresh"
                className="flex size-9 items-center justify-center border border-border transition-colors hover:bg-background focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 sm:size-[34px]"
              >
                <span ref={refreshRef} className="inline-flex">
                  <RefreshCw className="size-4" />
                </span>
              </button>
            </div>
          </div>

          {/* body */}
          <div className="flex min-h-0 flex-1 flex-col gap-[14px] overflow-y-auto pb-2 lg:flex-row lg:overflow-hidden lg:pb-0">
            {/* spec readout */}
            <div className="w-full min-w-0 lg:w-[340px] lg:flex-none lg:overflow-y-auto lg:pr-6">
              <SectionHeader title="general" />
              <SpecRow label="box id">
                <span className="flex items-center gap-[7px]">
                  {getBoxPublicIdLabel(box)}
                  <button
                    type="button"
                    onClick={copyId}
                    title="Copy Box ID"
                    aria-label="Copy Box ID"
                    className="inline-flex size-6 items-center justify-center text-muted-foreground hover:text-foreground"
                  >
                    {copied ? (
                      <Check className="size-[14px]" style={{ color: STATUS.running }} />
                    ) : (
                      <Copy className="size-[14px]" />
                    )}
                  </button>
                </span>
              </SpecRow>
              <SpecRow label="image" title={box.image ?? undefined}>
                {box.image ? (
                  catalogImage ? (
                    <Link
                      to={generatePath(RoutePath.IMAGE_DETAILS, { idOrRef: catalogImage.id ?? catalogImage.name })}
                      className="underline-offset-4 hover:underline"
                    >
                      {box.image}
                    </Link>
                  ) : (
                    box.image
                  )
                ) : (
                  '—'
                )}
              </SpecRow>
              <SpecRow label="region">{(getRegionName(box.target) ?? box.target ?? '—').toUpperCase()}</SpecRow>

              <SpecRow label="cpu">{box.cpu} vCPU</SpecRow>
              <SpecRow label="memory">{box.memory} GiB</SpecRow>
              <SpecRow label="disk">{box.disk} GiB</SpecRow>

              {/* Read-only by construction: mounts are fixed when the box is
                  created and there is no attach/detach endpoint, so this
                  answers "where is my data" and nothing more. Stored volumeId
                  may be a name or an id — the API accepts either — so resolve
                  it back to the readable name when we know it. */}
              {mountedVolumes.length > 0 && (
                <>
                  <SectionHeader title="volumes" />
                  {mountedVolumes.map((mount) => (
                    <SpecRow key={`${mount.volumeId}:${mount.mountPath}`} label={mount.displayName}>
                      <button
                        type="button"
                        onClick={() => navigate(RoutePath.VOLUMES)}
                        className="transition-colors hover:text-brand"
                        title="Go to volumes"
                      >
                        {mount.mountPath}
                        {mount.subpath ? ` (${mount.subpath})` : ''}
                      </button>
                    </SpecRow>
                  ))}
                </>
              )}

              <BoxNetworkSection box={box} canManage={writePermitted} />
              <div ref={setSshStatusContainer} />

              {/* `activity` names the subject, not the value type — and it is
                  the platform's own term for it (POST /:boxId/last-activity),
                  which is also what auto-stop is measured against. */}
              <SectionHeader title="activity" />
              <SpecRow label="created">{getRelativeTimeString(box.createdAt).relativeTimeString}</SpecRow>
              <SpecRow label="last event">{getRelativeTimeString(box.updatedAt).relativeTimeString}</SpecRow>

              {box.errorReason && (
                <>
                  <SectionHeader title="error" />
                  <p className="text-meta leading-relaxed text-destructive-foreground">{box.errorReason}</p>
                  {/* The API's wording for a private pull with no credential.
                      The fix is on the registries page, so the error carries the way there. */}
                  {box.image && /no registry login/.test(box.errorReason) && (
                    <Link
                      to={`${RoutePath.IMAGE_REGISTRIES}?connect=${encodeURIComponent(registryHostOf(box.image))}`}
                      className="mt-2 inline-block border border-border px-3 py-[6px] text-label uppercase text-foreground transition-colors hover:border-brand"
                    >
                      Connect a registry for {registryHostOf(box.image)} →
                    </Link>
                  )}
                </>
              )}
            </div>

            {/* shell / terminal */}
            <div className="flex h-[60vh] flex-none flex-col border border-border bg-[hsl(var(--code-background))] lg:h-auto lg:min-h-0 lg:flex-1">
              <BoxTerminalTab box={box} refreshSignal={terminalRefreshSignal} />
            </div>
          </div>
        </>
      )}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Box</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this box? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
