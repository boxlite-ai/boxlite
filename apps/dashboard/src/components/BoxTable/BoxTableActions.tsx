/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { FeatureFlags } from '@/enums/FeatureFlags'
import { RoutePath } from '@/enums/RoutePath'
import { isDashboardVncEnabled } from '@/lib/dashboard-features'
import { getBoxRouteId } from '@/lib/box-identity'
import { BoxState } from '@boxlite-ai/api-client'
import { Terminal, MoreVertical, Play, Square, Loader2, Wrench } from 'lucide-react'
import { useFeatureFlagEnabled } from 'posthog-js/react'
import { generatePath, useNavigate } from 'react-router-dom'
import { useMemo } from 'react'
import TooltipButton from '../TooltipButton'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { BoxTableActionsProps } from './types'

export function BoxTableActions({
  box,
  layout = 'table',
  writePermitted,
  deletePermitted,
  isLoading,
  onStart,
  onStop,
  onDelete,
  onVnc,
  onOpenWebTerminal,
  onCreateSshAccess,
  onRevokeSshAccess,
  onRecover,
  onScreenRecordings,
}: BoxTableActionsProps) {
  const navigate = useNavigate()
  const vncEnabled = isDashboardVncEnabled(useFeatureFlagEnabled(FeatureFlags.DASHBOARD_VNC))
  const isTransitioning = box.state === BoxState.STARTING || box.state === BoxState.STOPPING

  const primaryAction = useMemo(() => {
    if (box.state === BoxState.STARTED) {
      return {
        label: 'Stop',
        icon: <Square className="w-4 h-4" />,
        onClick: () => onStop(box.id),
      }
    }

    if (isTransitioning) {
      return {
        label: 'Working',
        icon: <Loader2 className="w-4 h-4 animate-spin" />,
        onClick: undefined,
      }
    }

    if (box.state === BoxState.ERROR && box.recoverable) {
      return {
        label: 'Recover',
        icon: <Wrench className="w-4 h-4" />,
        onClick: () => onRecover(box.id),
      }
    }

    return {
      label: 'Start',
      icon: <Play className="w-4 h-4" />,
      onClick: () => onStart(box.id),
    }
  }, [isTransitioning, onRecover, onStart, onStop, box.id, box.recoverable, box.state])

  const menuItems = useMemo(() => {
    const items = []

    items.push({
      key: 'open',
      label: 'View Details',
      onClick: () => navigate(generatePath(RoutePath.BOX_DETAILS, { boxId: getBoxRouteId(box) })),
      disabled: isLoading,
    })

    if (writePermitted) {
      if (box.state === BoxState.STARTED) {
        items.push({
          key: 'terminal',
          label: 'Terminal',
          onClick: () => onOpenWebTerminal(box.id),
          disabled: isLoading,
        })
        if (vncEnabled) {
          items.push({
            key: 'vnc',
            label: 'VNC',
            onClick: () => onVnc(getBoxRouteId(box)),
            disabled: isLoading,
          })
        }
        items.push({
          key: 'screen-recordings',
          label: 'Screen Recordings',
          onClick: () => onScreenRecordings(box.id),
          disabled: isLoading,
        })
        items.push({
          key: 'stop',
          label: 'Stop',
          onClick: () => onStop(box.id),
          disabled: isLoading,
        })
      } else if (box.state === BoxState.STOPPED) {
        items.push({
          key: 'start',
          label: 'Start',
          onClick: () => onStart(box.id),
          disabled: isLoading,
        })
      } else if (box.state === BoxState.ERROR && box.recoverable) {
        items.push({
          key: 'recover',
          label: 'Recover',
          onClick: () => onRecover(box.id),
          disabled: isLoading,
        })
      }

      // Add SSH access options
      items.push({
        key: 'create-ssh',
        label: 'Create SSH Access',
        onClick: () => onCreateSshAccess(box.id),
        disabled: isLoading,
      })
      items.push({
        key: 'revoke-ssh',
        label: 'Revoke SSH Access',
        onClick: () => onRevokeSshAccess(box.id),
        disabled: isLoading,
      })
    }

    if (deletePermitted) {
      if (items.length > 0 && (box.state === BoxState.STOPPED || box.state === BoxState.STARTED)) {
        items.push({ key: 'separator', type: 'separator' })
      }

      items.push({
        key: 'delete',
        label: 'Delete',
        onClick: () => onDelete(box.id),
        disabled: isLoading,
        className: 'text-red-600 dark:text-red-400',
      })
    }

    return items
  }, [
    writePermitted,
    deletePermitted,
    box.state,
    box.id,
    box.boxId,
    isLoading,
    box.recoverable,
    onStart,
    onStop,
    onDelete,
    onVnc,
    onOpenWebTerminal,
    onCreateSshAccess,
    onRevokeSshAccess,
    onRecover,
    onScreenRecordings,
    vncEnabled,
    navigate,
  ])

  if (!writePermitted && !deletePermitted) {
    return null
  }

  if (layout === 'mobile') {
    return (
      <div className="flex items-center justify-end gap-2">
        {writePermitted && (
          <Button
            variant="outline"
            size="sm"
            className="min-w-20 justify-center"
            disabled={isLoading || isTransitioning}
            onClick={(e) => {
              e.stopPropagation()
              primaryAction.onClick?.()
            }}
          >
            {primaryAction.icon}
            {primaryAction.label}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="sr-only">Open menu</span>
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {menuItems.map((item) => {
              if (item.type === 'separator') {
                return <DropdownMenuSeparator key={item.key} />
              }

              return (
                <DropdownMenuItem
                  key={item.key}
                  onClick={(e) => {
                    e.stopPropagation()
                    item.onClick?.()
                  }}
                  className={`cursor-pointer ${item.className || ''}`}
                  disabled={item.disabled}
                >
                  {item.label}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <TooltipButton
        variant="outline"
        className="text-muted-foreground"
        tooltipText={primaryAction.label}
        disabled={isLoading || isTransitioning}
        onClick={(e) => {
          e.stopPropagation()
          primaryAction.onClick?.()
        }}
      >
        {primaryAction.icon}
      </TooltipButton>

      {box.state === BoxState.STARTED ? (
        <TooltipButton
          variant="outline"
          className="text-muted-foreground"
          tooltipText="Open terminal"
          disabled={isLoading}
          onClick={(e) => {
            e.stopPropagation()
            onOpenWebTerminal(box.id)
          }}
        >
          <Terminal className="w-4 h-4" />
        </TooltipButton>
      ) : (
        <TooltipButton
          variant="outline"
          className="text-muted-foreground"
          tooltipText="Terminal available when running"
          disabled
        >
          <Terminal className="w-4 h-4" />
        </TooltipButton>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="sr-only">Open menu</span>
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {menuItems.map((item) => {
            if (item.type === 'separator') {
              return <DropdownMenuSeparator key={item.key} />
            }

            return (
              <DropdownMenuItem
                key={item.key}
                onClick={(e) => {
                  e.stopPropagation()
                  item.onClick?.()
                }}
                className={`cursor-pointer ${item.className || ''}`}
                disabled={item.disabled}
              >
                {item.label}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
