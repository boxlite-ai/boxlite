/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { pluralize } from '@/lib/utils'
import { BoxTemplateDto, BoxTemplateState } from '@boxlite-ai/api-client'
import { CheckSquare2Icon, MinusSquareIcon, PauseIcon, PlayIcon, PlusIcon, TrashIcon } from 'lucide-react'
import { useMemo } from 'react'
import { CommandConfig, useRegisterCommands } from '../../CommandPalette'

export interface TemplateBulkActionCounts {
  deletable: number
  deactivatable: number
  activatable: number
}

export function isTemplateDeletable(template: BoxTemplateDto): boolean {
  return template.state !== BoxTemplateState.REMOVING
}

export function isTemplateDeactivatable(template: BoxTemplateDto): boolean {
  return template.state === BoxTemplateState.ACTIVE
}

export function isTemplateActivatable(template: BoxTemplateDto): boolean {
  return template.state === BoxTemplateState.INACTIVE
}

export function getTemplateBulkActionCounts(templates: BoxTemplateDto[]): TemplateBulkActionCounts {
  return {
    deletable: templates.filter(isTemplateDeletable).length,
    deactivatable: templates.filter(isTemplateDeactivatable).length,
    activatable: templates.filter(isTemplateActivatable).length,
  }
}

interface UseTemplatesCommandsProps {
  writePermitted: boolean
  deletePermitted: boolean
  selectedCount: number
  totalCount: number
  selectableCount: number
  toggleAllRowsSelected: (selected: boolean) => void
  bulkActionCounts: TemplateBulkActionCounts
  onDelete: () => void
  onDeactivate: () => void
  onActivate: () => void
  onCreateTemplate?: () => void
}

export function useTemplatesCommands({
  writePermitted,
  deletePermitted,
  selectedCount,
  selectableCount,
  toggleAllRowsSelected,
  bulkActionCounts,
  onDelete,
  onActivate,
  onDeactivate,
  onCreateTemplate,
}: UseTemplatesCommandsProps) {
  const rootCommands: CommandConfig[] = useMemo(() => {
    const commands: CommandConfig[] = []

    if (writePermitted && onCreateTemplate) {
      commands.push({
        id: 'create-template',
        label: 'Create Image',
        icon: <PlusIcon className="w-4 h-4" />,
        onSelect: onCreateTemplate,
      })
    }

    if (selectableCount !== selectedCount) {
      commands.push({
        id: 'select-all-templates',
        label: 'Select All Images',
        icon: <CheckSquare2Icon className="w-4 h-4" />,
        onSelect: () => toggleAllRowsSelected(true),
        chainable: true,
      })
    }

    if (selectedCount > 0) {
      commands.push({
        id: 'deselect-all-templates',
        label: 'Deselect All Images',
        icon: <MinusSquareIcon className="w-4 h-4" />,
        onSelect: () => toggleAllRowsSelected(false),
        chainable: true,
      })
    }

    if (writePermitted && bulkActionCounts.deactivatable > 0) {
      commands.push({
        id: 'deactivate-templates',
        label: `Deactivate ${pluralize(bulkActionCounts.deactivatable, 'Image', 'Images')}`,
        icon: <PauseIcon className="w-4 h-4" />,
        onSelect: onDeactivate,
      })
    }

    if (writePermitted && bulkActionCounts.activatable > 0) {
      commands.push({
        id: 'activate-templates',
        label: `Activate ${pluralize(bulkActionCounts.activatable, 'Image', 'Images')}`,
        icon: <PlayIcon className="w-4 h-4" />,
        onSelect: onActivate,
      })
    }

    if (deletePermitted && bulkActionCounts.deletable > 0) {
      commands.push({
        id: 'delete-templates',
        label: `Delete ${pluralize(bulkActionCounts.deletable, 'Image', 'Images')}`,
        icon: <TrashIcon className="w-4 h-4" />,
        onSelect: onDelete,
      })
    }

    return commands
  }, [
    writePermitted,
    deletePermitted,
    selectedCount,
    selectableCount,
    toggleAllRowsSelected,
    bulkActionCounts,
    onDelete,
    onDeactivate,
    onActivate,
    onCreateTemplate,
  ])

  useRegisterCommands(rootCommands, { groupId: 'template-actions', groupLabel: 'Image actions', groupOrder: 0 })
}
