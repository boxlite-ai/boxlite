/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { RoutePath } from '@/enums/RoutePath'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn } from '@/lib/utils'
import { Building2, Copy } from 'lucide-react'
import React, { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useCopyToClipboard } from 'usehooks-ts'
import { useRegisterCommands, type CommandConfig } from '../CommandPalette'

const DEFAULT_ORGANIZATION_DISPLAY_NAME = 'Default Organization'

const getOrganizationDisplayName = (name?: string) => {
  if (!name) return DEFAULT_ORGANIZATION_DISPLAY_NAME
  return name
}

function useOrganizationCommands() {
  const { selectedOrganization } = useSelectedOrganization()
  const [, copyToClipboard] = useCopyToClipboard()

  const commands: CommandConfig[] = useMemo(() => {
    if (!selectedOrganization) {
      return []
    }

    return [
      {
        id: 'copy-org-id',
        label: 'Copy Organization ID',
        icon: <Copy className="w-4 h-4" />,
        onSelect: () => {
          copyToClipboard(selectedOrganization.id)
          toast.success('Organization ID copied to clipboard')
        },
      },
    ]
  }, [copyToClipboard, selectedOrganization])

  useRegisterCommands(commands, { groupId: 'organization', groupLabel: 'Organization', groupOrder: 5 })
}

interface OrganizationPickerProps {
  variant?: 'sidebar' | 'header'
}

export const OrganizationPicker: React.FC<OrganizationPickerProps> = ({ variant = 'sidebar' }) => {
  const { selectedOrganization } = useSelectedOrganization()

  useOrganizationCommands()

  if (!selectedOrganization) {
    return null
  }

  const displayName = getOrganizationDisplayName(selectedOrganization.name)
  const Wrapper = variant === 'header' ? 'div' : SidebarMenuItem

  return (
    <Wrapper className={cn(variant === 'header' && 'min-w-[11rem] max-w-[15rem]')}>
      <SidebarMenuButton
        asChild
        className={cn(
          'outline outline-1 outline-border outline-offset-0 bg-muted',
          variant === 'sidebar' && 'mb-2',
          variant === 'header' &&
            'mb-0 w-auto min-w-[11rem] max-w-[15rem] rounded-full border-0 bg-background px-3 text-xs font-normal text-foreground hover:bg-background',
        )}
        tooltip={variant === 'sidebar' ? displayName : undefined}
      >
        <Link to={RoutePath.SETTINGS} aria-label="Organization settings">
          <Building2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="truncate text-foreground">{displayName}</span>
        </Link>
      </SidebarMenuButton>
    </Wrapper>
  )
}
