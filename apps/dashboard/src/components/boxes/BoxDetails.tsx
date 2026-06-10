/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationSuspendedError } from '@/api/errors'
import { OnboardingGuideDialog } from '@/components/OnboardingGuideDialog'
import { PageLayout } from '@/components/PageLayout'
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FeatureFlags } from '@/enums/FeatureFlags'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { RoutePath } from '@/enums/RoutePath'
import { useDeleteBoxMutation } from '@/hooks/mutations/useDeleteBoxMutation'
import { useRecoverBoxMutation } from '@/hooks/mutations/useRecoverBoxMutation'
import { useStartBoxMutation } from '@/hooks/mutations/useStartBoxMutation'
import { useStopBoxMutation } from '@/hooks/mutations/useStopBoxMutation'
import { useBoxQuery } from '@/hooks/queries/useBoxQuery'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { useMatchMedia } from '@/hooks/useMatchMedia'
import { useRegions } from '@/hooks/useRegions'
import { useBoxWsSync } from '@/hooks/useBoxWsSync'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { isDashboardVncEnabled, isBoxContentTabAvailable } from '@/lib/dashboard-features'
import { handleApiError } from '@/lib/error-handling'
import { setLocalStorageItem } from '@/lib/local-storage'
import {
  ONBOARDING_ENTRY_HIGHLIGHT_EVENT,
  ONBOARDING_OPEN_EVENT,
  getOnboardingCoreProgress,
  mergeOnboardingProgress,
  ONBOARDING_PROGRESS_EVENT,
  readOnboardingProgress,
  type OnboardingProgress,
} from '@/lib/onboarding-progress'
import { isStoppable, isTransitioning } from '@/lib/utils/box'
import { OrganizationRolePermissionsEnum, OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { isAxiosError } from 'axios'
import { Code2, Container, GripVertical, ListChecks, RefreshCw } from 'lucide-react'
import { useQueryState } from 'nuqs'
import { useFeatureFlagEnabled } from 'posthog-js/react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { CreateSshAccessDialog } from './CreateSshAccessDialog'
import { RevokeSshAccessDialog } from './RevokeSshAccessDialog'
import { BoxContentTabs } from './BoxContentTabs'
import { BoxHeader } from './BoxHeader'
import { InfoPanelSkeleton, BoxInfoPanel } from './BoxInfoPanel'
import { tabParser } from './SearchParams'

export default function BoxDetails() {
  const { boxId } = useParams<{ boxId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const config = useConfig()
  const { user } = useAuth()
  const userId = user?.profile.sub
  const { boxApi } = useApi()
  const { authenticatedUserOrganizationMember, selectedOrganization, authenticatedUserHasPermission } =
    useSelectedOrganization()
  const { getRegionName } = useRegions()

  const experimentsEnabled = useFeatureFlagEnabled(FeatureFlags.ORGANIZATION_EXPERIMENTS)
  const vncEnabled = isDashboardVncEnabled(useFeatureFlagEnabled(FeatureFlags.DASHBOARD_VNC))

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [createSshDialogOpen, setCreateSshDialogOpen] = useState(false)
  const [revokeSshDialogOpen, setRevokeSshDialogOpen] = useState(false)
  const [showOnboardingDialog, setShowOnboardingDialog] = useState(false)
  const [onboardingProgress, setOnboardingProgress] = useState<OnboardingProgress>(() => readOnboardingProgress(userId))
  const [tab, setTab] = useQueryState('tab', tabParser)
  const isDesktop = useMatchMedia('(min-width: 1024px)')

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
    if (!selectedOrganization || !user?.profile.sub) {
      return
    }

    if (searchParams.get('onboarding') === '1') {
      setShowOnboardingDialog(true)
    }
  }, [searchParams, selectedOrganization, user?.profile.sub])

  useEffect(() => {
    const handleOpenOnboarding = (event: Event) => {
      event.preventDefault()
      setShowOnboardingDialog(true)
    }

    window.addEventListener(ONBOARDING_OPEN_EVENT, handleOpenOnboarding)
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, handleOpenOnboarding)
  }, [])

  const clearOnboardingUrlParam = useCallback(() => {
    if (searchParams.get('onboarding') !== '1') {
      return
    }

    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('onboarding')
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  const closeOnboardingDialog = useCallback(() => {
    if (userId) {
      setLocalStorageItem(`${LocalStorageKey.SkipOnboardingPrefix}${userId}`, 'true')
    }
    setShowOnboardingDialog(false)
    window.setTimeout(() => {
      window.dispatchEvent(new Event(ONBOARDING_ENTRY_HIGHLIGHT_EVENT))
      clearOnboardingUrlParam()
    }, 220)
  }, [clearOnboardingUrlParam, userId])

  // On desktop (lg+), the overview tab is hidden in the sidebar, so switch to a content tab
  useEffect(() => {
    if (isDesktop && tab === 'overview') {
      setTab(experimentsEnabled ? 'logs' : 'terminal')
    }
  }, [isDesktop, tab, setTab, experimentsEnabled])

  // Coerce hidden tabs back to a supported default.
  useEffect(() => {
    if (!isBoxContentTabAvailable(tab, { experimentsEnabled, vncEnabled })) {
      setTab('terminal')
    }
  }, [experimentsEnabled, tab, setTab, vncEnabled])

  const { data: box, isLoading, isError, error, refetch, isFetching } = useBoxQuery(boxId ?? '')
  const isNotFound = isError && isAxiosError(error.cause) && error.cause?.status === 404
  const onboardingCoreProgress = getOnboardingCoreProgress(onboardingProgress)
  const showOnboardingNudge = Boolean(box && !onboardingCoreProgress.isComplete)

  useBoxWsSync({ boxId })

  useEffect(() => {
    if (box && !onboardingProgress.boxCreated) {
      updateOnboardingProgress({ boxCreated: true })
    }
  }, [onboardingProgress.boxCreated, box, updateOnboardingProgress])

  useEffect(() => {
    if (box && tab === 'terminal' && !onboardingProgress.terminalOpened) {
      updateOnboardingProgress({ boxCreated: true, terminalOpened: true })
    }
  }, [onboardingProgress.terminalOpened, box, tab, updateOnboardingProgress])

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
            <Button variant="secondary" onClick={() => navigate(RoutePath.BILLING_WALLET)}>
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

  const handleScreenRecordings = async () => {
    if (!box || !isStoppable(box)) {
      toast.error('Box must be started to access Screen Recordings')
      return
    }
    try {
      const response = await boxApi.getSignedPortPreviewUrl(box.id, 33333, selectedOrganization?.id)
      window.open(response.data.url, '_blank', 'noopener,noreferrer')
      toast.success('Opening Screen Recordings dashboard...')
    } catch (error) {
      handleApiError(error, 'Failed to open Screen Recordings')
    }
  }

  return (
    <PageLayout className="h-[var(--app-content-height,calc(100svh_-_3.5rem))] overflow-hidden">
      <OnboardingGuideDialog
        open={showOnboardingDialog}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            closeOnboardingDialog()
          } else {
            setShowOnboardingDialog(true)
          }
        }}
        onProgressChange={updateOnboardingProgress}
        progress={onboardingProgress}
      />
      <BoxHeader
        box={box}
        isLoading={isLoading}
        writePermitted={writePermitted}
        deletePermitted={deletePermitted}
        actionsDisabled={actionsDisabled}
        isFetching={isFetching}
        onStart={handleStart}
        onStop={handleStop}
        onRecover={handleRecover}
        onDelete={() => setDeleteDialogOpen(true)}
        onRefresh={() => refetch()}
        onBack={() => navigate(RoutePath.BOXES)}
        onCreateSshAccess={() => setCreateSshDialogOpen(true)}
        onRevokeSshAccess={() => setRevokeSshDialogOpen(true)}
        onScreenRecordings={handleScreenRecordings}
        mutations={{
          start: startMutation.isPending,
          stop: stopMutation.isPending,
          recover: recoverMutation.isPending,
        }}
      />

      {showOnboardingNudge && (
        <div className="shrink-0 border-b border-border bg-card px-4 py-3 sm:px-5">
          <div className="mx-auto flex max-w-[1440px] flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <ListChecks className="size-4" />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-semibold">Connect with the SDK</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Code2 className="size-3.5" />
                    Generate an API key and run the SDK example.
                  </span>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <Button type="button" size="sm" onClick={() => setShowOnboardingDialog(true)}>
                Open SDK guide
              </Button>
            </div>
          </div>
        </div>
      )}

      {isNotFound ? (
        <div className="flex flex-1 min-h-0 items-center justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Container className="size-4" />
              </EmptyMedia>
              <EmptyTitle>Box not found</EmptyTitle>
              <EmptyDescription>Are you sure you're in the right organization?</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" size="sm" onClick={() => navigate(RoutePath.BOXES)}>
              Back to Boxes
            </Button>
          </Empty>
        </div>
      ) : (
        <Group orientation="horizontal" className="flex flex-1 min-h-0 overflow-hidden">
          {isDesktop && (
            <>
              <Panel
                id="overview"
                minSize={250}
                maxSize={550}
                defaultSize={320}
                className="flex flex-col overflow-hidden bg-card"
              >
                <div className="flex items-center px-5 border-b border-border shrink-0 h-[41px]">
                  <span className="text-sm font-medium">Overview</span>
                </div>
                <ScrollArea fade="mask" className="flex-1 min-h-0">
                  {isLoading ? (
                    <InfoPanelSkeleton />
                  ) : isError || !box ? (
                    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
                      <p className="text-sm">Failed to load box details.</p>
                      <Button variant="outline" size="sm" onClick={() => refetch()}>
                        <RefreshCw className="size-4" />
                        Retry
                      </Button>
                    </div>
                  ) : (
                    <BoxInfoPanel box={box} getRegionName={getRegionName} />
                  )}
                </ScrollArea>
              </Panel>
              <ResizableSeparator />
            </>
          )}
          <Panel id="content" className="flex-1 min-w-0 flex flex-col overflow-hidden">
            <BoxContentTabs
              box={box}
              isLoading={isLoading}
              experimentsEnabled={experimentsEnabled}
              vncEnabled={vncEnabled}
              tab={tab}
              onTabChange={setTab}
            />
          </Panel>
        </Group>
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

      {boxId && (
        <>
          <CreateSshAccessDialog boxId={boxId} open={createSshDialogOpen} onOpenChange={setCreateSshDialogOpen} />
          <RevokeSshAccessDialog boxId={boxId} open={revokeSshDialogOpen} onOpenChange={setRevokeSshDialogOpen} />
        </>
      )}
    </PageLayout>
  )
}

function ResizableSeparator() {
  return (
    <Separator className="group relative flex w-px items-center justify-center bg-transparent text-muted-foreground focus-visible:outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border after:transition-colors data-[separator=hover]:text-primary data-[separator=hover]:after:bg-primary data-[separator=active]:text-primary data-[separator=active]:after:bg-primary focus-visible:text-primary">
      <div className="z-10 flex h-6 w-3.5 items-center justify-center rounded-sm border border-border bg-background transition-colors group-data-[separator=hover]:border-current group-data-[separator=active]:border-current group-focus-visible:border-current">
        <GripVertical className="size-3 text-current" />
      </div>
    </Separator>
  )
}
