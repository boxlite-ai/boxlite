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
import { useDeleteBoxMutation } from '@/hooks/mutations/useDeleteBoxMutation'
import { useRecoverBoxMutation } from '@/hooks/mutations/useRecoverBoxMutation'
import { useStartBoxMutation } from '@/hooks/mutations/useStartBoxMutation'
import { useStopBoxMutation } from '@/hooks/mutations/useStopBoxMutation'
import { useBoxQuery } from '@/hooks/queries/useBoxQuery'
import { useConfig } from '@/hooks/useConfig'
import { useBoxWsSync } from '@/hooks/useBoxWsSync'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getBoxDisplayName } from '@/lib/box-identity'
import { handleApiError } from '@/lib/error-handling'
import {
  mergeOnboardingProgress,
  ONBOARDING_PROGRESS_EVENT,
  readOnboardingProgress,
  type OnboardingProgress,
} from '@/lib/onboarding-progress'
import { isRecoverable, isStartable, isStoppable, isTransitioning } from '@/lib/utils/box'
import { OrganizationRolePermissionsEnum, OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { isAxiosError } from 'axios'
import {
  ArrowLeft,
  Check,
  Container,
  Copy,
  MoreVertical,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from '@/components/ui/icon'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { usePageTitle } from '@/hooks/usePageTitle'
import { copyToClipboard } from '@/lib/copy-text'
import { toast } from 'sonner'
import { BoxOverview } from './BoxOverview'
import { BoxTerminalSession } from './BoxTerminalSession'
import { cn } from '@/lib/utils'
import { BoxPageNavigation } from './BoxPageNavigation'
import { BoxSshTab } from './BoxSshTab'
import { BoxStatusIndicator } from './box-presentation'
import { BoxResourceIcon } from '@/components/ResourceStateIcon'

/** Keep one Box's header and SSH controls mounted across its two views. */
export default function BoxDetails({ page = 'overview' }: { page?: 'overview' | 'terminal' }) {
  const { boxId } = useParams<{ boxId: string }>()
  const { selectedOrganization } = useSelectedOrganization()
  return <BoxDetailsPage key={`${selectedOrganization?.id}:${boxId}`} page={page} />
}

function BoxDetailsPage({ page }: { page: 'overview' | 'terminal' }) {
  const { boxId } = useParams<{ boxId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const config = useConfig()
  const { user } = useAuth()
  const userId = user?.profile.sub
  const { authenticatedUserOrganizationMember, selectedOrganization, authenticatedUserHasPermission } =
    useSelectedOrganization()

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [onboardingProgress, setOnboardingProgress] = useState<OnboardingProgress>(() => readOnboardingProgress(userId))
  const [copiedName, setCopiedName] = useState(false)
  const [sshRefreshSignal, setSshRefreshSignal] = useState(0)
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
  usePageTitle(box ? `${getBoxDisplayName(box)}${page === 'terminal' ? ' · Terminal' : ''}` : 'Box')

  const isNotFound = isError && isAxiosError(error?.cause) && error.cause?.status === 404
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
    setSshRefreshSignal((signal) => signal + 1)
    const el = refreshRef.current
    if (el) {
      el.style.animation = 'none'
      void el.offsetWidth
      el.style.animation = 'spin .6s ease'
    }
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
    <div
      className={cn(
        'page-container flex max-w-[1232px] min-w-0 flex-col gap-3 pb-6 pt-4 font-sans text-body',
        page === 'terminal'
          ? 'h-[var(--app-content-height,calc(100svh_-_60px))] min-h-[640px]'
          : 'min-h-[var(--app-content-height,calc(100svh_-_60px))]',
      )}
    >
      <Link
        to={RoutePath.BOXES}
        className="inline-flex min-h-6 w-fit flex-none items-center gap-2 text-meta text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Boxes
      </Link>

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
          <div className="flex flex-none flex-col gap-4 lg:flex-row lg:items-center lg:gap-[18px]">
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:gap-[14px]">
              <div className="flex min-w-0 items-center gap-3">
                <BoxResourceIcon box={box} className="size-7 shrink-0" />
                <h1 className="min-w-0 break-all font-mono text-page font-semibold" title={getBoxDisplayName(box)}>
                  {getBoxDisplayName(box)}
                </h1>
                <button
                  type="button"
                  onClick={copyName}
                  title="Copy name"
                  aria-label="Copy name"
                  className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  {copiedName ? <Check className="size-[15px] text-success" /> : <Copy className="size-[15px]" />}
                </button>
              </div>
              <span className="shrink-0">
                <BoxStatusIndicator box={box} />
              </span>
            </div>

            <div className="flex flex-none flex-wrap items-center gap-2 sm:gap-[10px]">
              {/* SSH comes first in every state, then the state action, then the menu and refresh. */}
              <BoxSshTab box={box} refreshSignal={sshRefreshSignal} statusContainer={sshStatusContainer} />
              {writePermitted && isRecoverable(box) && (
                <Button variant="outline" type="button" onClick={handleRecover} disabled={actionsDisabled}>
                  <RotateCcw className="size-[14px]" /> Recover
                </Button>
              )}
              {writePermitted && isStartable(box) && (
                <Button variant="outline" type="button" onClick={handleStart} disabled={actionsDisabled}>
                  <Play className="size-[14px]" /> Start
                </Button>
              )}
              {writePermitted && isStoppable(box) && (
                <Button variant="outline" type="button" onClick={handleStop} disabled={actionsDisabled}>
                  <Square className="size-[12px]" /> Stop
                </Button>
              )}
              {writePermitted &&
                isTransitioning(box) &&
                !isRecoverable(box) &&
                !isStartable(box) &&
                !isStoppable(box) && (
                  <Button variant="outline" disabled>
                    <RefreshCw className="size-[14px] animate-spin" /> Working…
                  </Button>
                )}
              {deletePermitted && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="quiet" size="icon" aria-label="Open box actions">
                      <MoreVertical className="size-4" />
                    </Button>
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
              <Button
                variant="quiet"
                size="icon"
                type="button"
                onClick={handleRefresh}
                title="Refresh"
                aria-label="Refresh"
              >
                <span ref={refreshRef} className="inline-flex">
                  <RefreshCw className="size-4" />
                </span>
              </Button>
            </div>
          </div>

          <BoxPageNavigation boxId={boxId ?? box.id} current={page} />

          {page === 'terminal' ? (
            <div className="flex min-h-[360px] min-w-0 flex-1 flex-col overflow-hidden border border-border/60">
              <BoxTerminalSession box={box} />
            </div>
          ) : (
            <BoxOverview box={box} canManage={writePermitted} sshStatusRef={setSshStatusContainer} />
          )}
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
