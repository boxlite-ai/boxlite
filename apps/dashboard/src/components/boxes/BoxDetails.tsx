/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationSuspendedError } from '@/api/errors'
import { OnboardingGuideDialog } from '@/components/OnboardingGuideDialog'
import { calculateBoxHourlyCost, formatUsdFromCents } from '@/components/billing/cost'
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
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { RoutePath } from '@/enums/RoutePath'
import { useDeleteBoxMutation } from '@/hooks/mutations/useDeleteBoxMutation'
import { useRecoverBoxMutation } from '@/hooks/mutations/useRecoverBoxMutation'
import { useStartBoxMutation } from '@/hooks/mutations/useStartBoxMutation'
import { useStopBoxMutation } from '@/hooks/mutations/useStopBoxMutation'
import { useBillingPricingQuery } from '@/hooks/queries/useBillingPricingQuery'
import { useBoxQuery } from '@/hooks/queries/useBoxQuery'
import { useBoxBillingUsageQuery } from '@/hooks/queries/useBoxBillingUsageQuery'
import { useConfig } from '@/hooks/useConfig'
import { useRegions } from '@/hooks/useRegions'
import { useBoxWsSync } from '@/hooks/useBoxWsSync'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getBoxPublicId, getBoxPublicIdLabel } from '@/lib/box-identity'
import { handleApiError } from '@/lib/error-handling'
import { setLocalStorageItem } from '@/lib/local-storage'
import {
  ONBOARDING_ENTRY_HIGHLIGHT_EVENT,
  mergeOnboardingProgress,
  ONBOARDING_PROGRESS_EVENT,
  readOnboardingProgress,
  type OnboardingProgress,
} from '@/lib/onboarding-progress'
import { getRelativeTimeString } from '@/lib/utils'
import { isRecoverable, isStartable, isStoppable, isTransitioning } from '@/lib/utils/box'
import { Box, BoxState, OrganizationRolePermissionsEnum, OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { isAxiosError } from 'axios'
import { Check, Container, Copy, MoreVertical, Pause, Play, RefreshCw, RotateCcw, Trash2 } from '@/components/ui/icon'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from 'react-oidc-context'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { BoxTerminalTab } from './BoxTerminalTab'
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
      <span className="size-[6px] flex-none bg-brand" />
      <span className="text-[11px] uppercase tracking-[2px]">{title}</span>
      <span className="flex-1 border-t border-dashed border-border" />
      {right}
    </div>
  )
}

function SpecRow({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="mb-[6px] flex items-baseline gap-2">
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <span className="-translate-y-1 flex-1 border-b border-dotted border-border" />
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

export default function BoxDetails() {
  const { boxId } = useParams<{ boxId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const config = useConfig()
  const { user } = useAuth()
  const userId = user?.profile.sub
  const { authenticatedUserOrganizationMember, selectedOrganization, authenticatedUserHasPermission } =
    useSelectedOrganization()
  const { getRegionName } = useRegions()

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [showOnboardingDialog, setShowOnboardingDialog] = useState(false)
  const [onboardingProgress, setOnboardingProgress] = useState<OnboardingProgress>(() => readOnboardingProgress(userId))
  const [copied, setCopied] = useState(false)
  const [terminalRefreshSignal, setTerminalRefreshSignal] = useState(0)
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
    if (searchParams.get('onboarding') === '1') setShowOnboardingDialog(true)
  }, [searchParams, selectedOrganization, user?.profile.sub])

  const clearOnboardingUrlParam = useCallback(() => {
    if (searchParams.get('onboarding') !== '1') return
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('onboarding')
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  const closeOnboardingDialog = useCallback(() => {
    if (userId) setLocalStorageItem(`${LocalStorageKey.SkipOnboardingPrefix}${userId}`, 'true')
    setShowOnboardingDialog(false)
    window.setTimeout(() => {
      window.dispatchEvent(new Event(ONBOARDING_ENTRY_HIGHLIGHT_EVENT))
      clearOnboardingUrlParam()
    }, 220)
  }, [clearOnboardingUrlParam, userId])

  const { data: box, isLoading, isError, error, refetch } = useBoxQuery(boxId ?? '')
  const canViewBilling = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER
  const pricingQuery = useBillingPricingQuery(selectedOrganization?.id ?? '', canViewBilling)
  const boxBillingQuery = useBoxBillingUsageQuery(
    selectedOrganization?.id ?? '',
    box?.id ?? '',
    Boolean(canViewBilling && box),
  )
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

  const copyId = () => {
    const id = box ? getBoxPublicId(box) : null
    if (!id) return
    try {
      navigator.clipboard?.writeText(id)
    } catch {
      /* clipboard may be unavailable */
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1300)
  }

  return (
    <div className="flex h-[calc(100svh-60px)] min-h-0 flex-col gap-[14px] px-4 pb-[22px] pt-4 font-mono text-[13px] sm:px-6 lg:px-[40px]">
      <OnboardingGuideDialog
        open={showOnboardingDialog}
        onOpenChange={(isOpen) => (isOpen ? setShowOnboardingDialog(true) : closeOnboardingDialog())}
        onProgressChange={updateOnboardingProgress}
        progress={onboardingProgress}
      />

      {/* breadcrumb */}
      <div className="flex flex-none items-center gap-[9px] text-[12px] text-muted-foreground">
        <button type="button" onClick={() => navigate(RoutePath.BOXES)} className="hover:text-foreground">
          boxes
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">{box ? getBoxPublicIdLabel(box).toLowerCase() : boxId?.toLowerCase()}</span>
      </div>

      {isNotFound ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <Container className="size-8" strokeWidth={1.3} />
          <div className="text-foreground">Box not found</div>
          <div className="text-[12px]">Are you sure you&apos;re in the right organization?</div>
          <button
            type="button"
            onClick={() => navigate(RoutePath.BOXES)}
            className="mt-2 border border-border px-4 py-2 text-[13px] transition-colors hover:bg-card"
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
          <div className="flex flex-none flex-col gap-4 border-b border-dashed border-border pb-[14px] lg:flex-row lg:items-center lg:gap-[18px]">
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:gap-[14px]">
              <span className="max-w-full truncate text-[20px] font-medium tracking-[-0.4px] sm:max-w-[360px] sm:text-[22px]">
                {getBoxPublicIdLabel(box)}
              </span>
              <span className="flex flex-none items-center gap-2 text-[13px]">
                <span
                  className="size-[8px] rounded-[2px]"
                  style={{ background: statusOf(box).color, boxShadow: `0 0 6px ${statusOf(box).color}` }}
                />
                <span className="font-medium">{statusOf(box).label}</span>
              </span>
              {box.image && (
                <span className="max-w-full truncate border border-border px-[9px] py-[3px] text-[11px] tracking-[0.5px] text-muted-foreground sm:flex-none">
                  {box.image}
                </span>
              )}
            </div>

            <div className="flex flex-none flex-wrap items-center gap-2 sm:gap-[10px]">
              {writePermitted && isRecoverable(box) && (
                <button
                  type="button"
                  onClick={handleRecover}
                  disabled={actionsDisabled}
                  className="flex min-h-10 items-center gap-2 border border-border px-[15px] py-2 text-[13px] font-medium transition-colors hover:bg-background focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:opacity-50"
                >
                  <RotateCcw className="size-[14px]" /> recover
                </button>
              )}
              {writePermitted && isStartable(box) && (
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={actionsDisabled}
                  className="flex min-h-10 items-center gap-2 border border-border px-[15px] py-2 text-[13px] font-medium transition-colors hover:bg-background focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:opacity-50"
                >
                  <Play className="size-[14px]" fill="currentColor" /> start
                </button>
              )}
              {writePermitted && isStoppable(box) && (
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={actionsDisabled}
                  className="flex min-h-10 items-center gap-2 border border-border px-[15px] py-2 text-[13px] font-medium transition-colors hover:bg-background focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:opacity-50"
                >
                  <Pause className="size-[13px]" fill="currentColor" /> stop
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
                    className="flex min-h-10 items-center gap-2 border border-border px-[15px] py-2 text-[13px] font-medium text-muted-foreground"
                  >
                    <RefreshCw className="size-[14px] animate-spin" /> working…
                  </button>
                )}
              {deletePermitted && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label="Open box actions"
                    className="flex size-10 items-center justify-center border border-border outline-none transition-colors hover:bg-background focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/35 data-[state=open]:bg-background sm:size-[34px]"
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
                title="refresh"
                className="flex size-10 items-center justify-center border border-border transition-colors hover:bg-background focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 sm:size-[34px]"
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
            <div className="w-full lg:w-[340px] lg:flex-none lg:overflow-y-auto lg:pr-6">
              <SectionHeader title="general" />
              <SpecRow label="box id">
                <span className="flex items-center gap-[7px]">
                  {getBoxPublicIdLabel(box)}
                  <button
                    type="button"
                    onClick={copyId}
                    title="copy"
                    className="text-muted-foreground hover:text-foreground"
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
                {box.image ?? '—'}
              </SpecRow>
              <SpecRow label="region">{(getRegionName(box.target) ?? box.target ?? '—').toUpperCase()}</SpecRow>

              <SectionHeader
                title="resources"
                right={<span className="text-[10px] tracking-[1px] text-muted-foreground">quota</span>}
              />
              <SpecRow label="cpu">{box.cpu} vcpu</SpecRow>
              <SpecRow label="memory">{box.memory} gib</SpecRow>
              <SpecRow label="disk">{box.disk} gib</SpecRow>

              {canViewBilling ? (
                <>
                  <SectionHeader
                    title="cost"
                    right={
                      pricingQuery.data ? (
                        <span className="text-[10px] text-muted-foreground">pricing v{pricingQuery.data.version}</span>
                      ) : undefined
                    }
                  />
                  <SpecRow label="running rate">
                    {pricingQuery.data
                      ? `${formatUsdFromCents(
                          calculateBoxHourlyCost(pricingQuery.data, {
                            cpu: box.cpu,
                            memory: box.memory,
                            disk: box.disk,
                          }).totalCents,
                          5,
                        )} / hr`
                      : 'unavailable'}
                  </SpecRow>
                  <SpecRow label="rated total">
                    {boxBillingQuery.data
                      ? formatUsdFromCents(boxBillingQuery.data.costPreciseCents, 4)
                      : boxBillingQuery.isError
                        ? 'unavailable'
                        : 'pending'}
                  </SpecRow>
                </>
              ) : null}

              <SectionHeader title="timestamps" />
              <SpecRow label="created">{getRelativeTimeString(box.createdAt).relativeTimeString}</SpecRow>
              <SpecRow label="last event">{getRelativeTimeString(box.updatedAt).relativeTimeString}</SpecRow>

              {box.errorReason && (
                <>
                  <SectionHeader title="error" />
                  <p className="text-[12px] leading-relaxed" style={{ color: STATUS.error }}>
                    {box.errorReason}
                  </p>
                </>
              )}
            </div>

            {/* shell / terminal */}
            <div className="flex h-[60vh] flex-none flex-col border border-border bg-[hsl(var(--code-background))] lg:h-auto lg:min-h-0 lg:flex-1">
              <div className="flex flex-none items-center justify-between border-b border-dashed border-border px-5 py-[15px]">
                <span className="flex items-center gap-[9px] text-[11px] uppercase tracking-[2px]">
                  <span className="size-[6px] flex-none bg-brand" />
                  shell
                  <span className="ml-0.5 tracking-[0.5px] text-muted-foreground normal-case">
                    {getBoxPublicIdLabel(box)}
                  </span>
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <BoxTerminalTab box={box} refreshSignal={terminalRefreshSignal} />
              </div>
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
