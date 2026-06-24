/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CopyButton } from '@/components/CopyButton'
import { BoxState } from '@/components/BoxTable/BoxState'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { getBoxDisplayName } from '@/lib/box-identity'
import { isRecoverable, isStartable, isStoppable } from '@/lib/utils/box'
import { Box } from '@boxlite-ai/api-client'
import { ArrowLeft, MoreHorizontal, Play, RefreshCw, Square, Wrench } from '@/components/ui/icon'

interface BoxHeaderProps {
  box: Box | undefined
  isLoading: boolean
  writePermitted: boolean
  deletePermitted: boolean
  actionsDisabled: boolean
  isFetching: boolean
  onStart: () => void
  onStop: () => void
  onRecover: () => void
  onDelete: () => void
  onRefresh: () => void
  onBack: () => void
  mutations: {
    start: boolean
    stop: boolean
    recover: boolean
  }
}

export function BoxHeader({
  box,
  isLoading,
  writePermitted,
  deletePermitted,
  actionsDisabled,
  isFetching,
  onStart,
  onStop,
  onRecover,
  onDelete,
  onRefresh,
  onBack,
  mutations,
}: BoxHeaderProps) {
  return (
    <div className="shrink-0">
      <div className="mx-auto flex w-full max-w-[1040px] flex-wrap items-center justify-between gap-x-4 gap-y-2 min-w-0 px-4 sm:px-5 2xl:px-0 pt-7 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </Button>
          {isLoading ? (
            <BoxHeaderSkeleton />
          ) : box ? (
            <>
              <div className="flex items-center gap-1 min-w-0">
                <h2 className="font-display text-base font-medium truncate">{getBoxDisplayName(box)}</h2>
                <CopyButton value={getBoxDisplayName(box)} tooltipText="Copy name" size="icon-xs" />
              </div>
              <BoxState pill state={box.state} errorReason={box.errorReason} recoverable={box.recoverable} />
            </>
          ) : null}
        </div>

        <div className="flex items-center gap-3 shrink-0 ml-8 sm:ml-0">
          {isLoading ? (
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-8 w-8" />
              <Skeleton className="h-8 w-8" />
            </div>
          ) : box ? (
            <>
              <div className="flex items-center gap-2">
                {writePermitted && (
                  <ButtonGroup>
                    {isStartable(box) && !box.recoverable && (
                      <Button variant="secondary" size="sm" onClick={onStart} disabled={actionsDisabled}>
                        {mutations.start ? <Spinner className="size-4" /> : <Play className="size-4" />}
                        Start
                      </Button>
                    )}
                    {isStoppable(box) && (
                      <Button variant="secondary" size="sm" onClick={onStop} disabled={actionsDisabled}>
                        {mutations.stop ? <Spinner className="size-4" /> : <Square className="size-4" />}
                        Stop
                      </Button>
                    )}
                    {isRecoverable(box) && (
                      <Button variant="secondary" size="sm" onClick={onRecover} disabled={actionsDisabled}>
                        {mutations.recover ? <Spinner className="size-4" /> : <Wrench className="size-4" />}
                        Recover
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="icon-sm" aria-label="More actions">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuGroup className="sm:hidden">
                          <DropdownMenuItem onClick={onRefresh} disabled={isFetching}>
                            Refresh
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </DropdownMenuGroup>
                        {deletePermitted && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuGroup>
                              <DropdownMenuItem variant="destructive" onClick={onDelete} disabled={actionsDisabled}>
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </ButtonGroup>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onRefresh}
                  disabled={isFetching}
                  title="Refresh"
                  className="hidden sm:inline-flex"
                >
                  {isFetching ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function BoxHeaderSkeleton() {
  return (
    <div className="flex items-center gap-2">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3.5 w-28" />
    </div>
  )
}
