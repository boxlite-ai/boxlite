/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { FeatureFlags } from '@/enums/FeatureFlags'
import { RoutePath } from '@/enums/RoutePath'
import { isDashboardVncEnabled } from '@/lib/dashboard-features'
import { getSandboxRouteId } from '@/lib/sandbox-identity'
import { SandboxState } from '@boxlite-ai/api-client'
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
import { SandboxTableActionsProps } from './types'

export function SandboxTableActions({
  sandbox,
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
}: SandboxTableActionsProps) {
  const navigate = useNavigate()
  const vncEnabled = isDashboardVncEnabled(useFeatureFlagEnabled(FeatureFlags.DASHBOARD_VNC))
  const isTransitioning = sandbox.state === SandboxState.STARTING || sandbox.state === SandboxState.STOPPING

  const primaryAction = useMemo(() => {
    if (sandbox.state === SandboxState.STARTED) {
      return {
        label: 'Stop',
        icon: <Square className="w-4 h-4" />,
        onClick: () => onStop(sandbox.id),
      }
    }

    if (isTransitioning) {
      return {
        label: 'Working',
        icon: <Loader2 className="w-4 h-4 animate-spin" />,
        onClick: undefined,
      }
    }

    if (sandbox.state === SandboxState.ERROR && sandbox.recoverable) {
      return {
        label: 'Recover',
        icon: <Wrench className="w-4 h-4" />,
        onClick: () => onRecover(sandbox.id),
      }
    }

    return {
      label: 'Start',
      icon: <Play className="w-4 h-4" />,
      onClick: () => onStart(sandbox.id),
    }
  }, [isTransitioning, onRecover, onStart, onStop, sandbox.id, sandbox.recoverable, sandbox.state])

  const menuItems = useMemo(() => {
    const items = []

    items.push({
      key: 'open',
      label: 'View Details',
      onClick: () => navigate(generatePath(RoutePath.BOX_DETAILS, { sandboxId: getSandboxRouteId(sandbox) })),
      disabled: isLoading,
    })

    if (writePermitted) {
      if (sandbox.state === SandboxState.STARTED) {
        items.push({
          key: 'terminal',
          label: 'Terminal',
          onClick: () => onOpenWebTerminal(sandbox.id),
          disabled: isLoading,
        })
        if (vncEnabled) {
          items.push({
            key: 'vnc',
            label: 'VNC',
            onClick: () => onVnc(getSandboxRouteId(sandbox)),
            disabled: isLoading,
          })
        }
        items.push({
          key: 'screen-recordings',
          label: 'Screen Recordings',
          onClick: () => onScreenRecordings(sandbox.id),
          disabled: isLoading,
        })
        items.push({
          key: 'stop',
          label: 'Stop',
          onClick: () => onStop(sandbox.id),
          disabled: isLoading,
        })
      } else if (sandbox.state === SandboxState.STOPPED) {
        items.push({
          key: 'start',
          label: 'Start',
          onClick: () => onStart(sandbox.id),
          disabled: isLoading,
        })
      } else if (sandbox.state === SandboxState.ERROR && sandbox.recoverable) {
        items.push({
          key: 'recover',
          label: 'Recover',
          onClick: () => onRecover(sandbox.id),
          disabled: isLoading,
        })
      }

      // Add SSH access options
      items.push({
        key: 'create-ssh',
        label: 'Create SSH Access',
        onClick: () => onCreateSshAccess(sandbox.id),
        disabled: isLoading,
      })
      items.push({
        key: 'revoke-ssh',
        label: 'Revoke SSH Access',
        onClick: () => onRevokeSshAccess(sandbox.id),
        disabled: isLoading,
      })
    }

    if (deletePermitted) {
      if (items.length > 0 && (sandbox.state === SandboxState.STOPPED || sandbox.state === SandboxState.STARTED)) {
        items.push({ key: 'separator', type: 'separator' })
      }

      items.push({
        key: 'delete',
        label: 'Delete',
        onClick: () => onDelete(sandbox.id),
        disabled: isLoading,
        className: 'text-red-600 dark:text-red-400',
      })
    }

    return items
  }, [
    writePermitted,
    deletePermitted,
    sandbox.state,
    sandbox.id,
    sandbox.boxId,
    isLoading,
    sandbox.recoverable,
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

      {sandbox.state === SandboxState.STARTED ? (
        <TooltipButton
          variant="outline"
          className="text-muted-foreground"
          tooltipText="Open terminal"
          disabled={isLoading}
          onClick={(e) => {
            e.stopPropagation()
            onOpenWebTerminal(sandbox.id)
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
