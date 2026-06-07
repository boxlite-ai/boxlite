/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { pluralize } from '@/lib/utils'
import { SavedImageDto, SavedImageState } from '@boxlite-ai/api-client'
import { CheckSquare2Icon, MinusSquareIcon, PauseIcon, PlayIcon, PlusIcon, TrashIcon } from 'lucide-react'
import { useMemo } from 'react'
import { CommandConfig, useRegisterCommands } from '../../CommandPalette'

export interface SavedImageBulkActionCounts {
  deletable: number
  deactivatable: number
  activatable: number
}

export function isSavedImageDeletable(savedImage: SavedImageDto): boolean {
  return savedImage.state !== SavedImageState.REMOVING
}

export function isSavedImageDeactivatable(savedImage: SavedImageDto): boolean {
  return savedImage.state === SavedImageState.ACTIVE
}

export function isSavedImageActivatable(savedImage: SavedImageDto): boolean {
  return savedImage.state === SavedImageState.INACTIVE
}

export function getSavedImageBulkActionCounts(savedImages: SavedImageDto[]): SavedImageBulkActionCounts {
  return {
    deletable: savedImages.filter(isSavedImageDeletable).length,
    deactivatable: savedImages.filter(isSavedImageDeactivatable).length,
    activatable: savedImages.filter(isSavedImageActivatable).length,
  }
}

interface UseSavedImagesCommandsProps {
  writePermitted: boolean
  deletePermitted: boolean
  selectedCount: number
  totalCount: number
  selectableCount: number
  toggleAllRowsSelected: (selected: boolean) => void
  bulkActionCounts: SavedImageBulkActionCounts
  onDelete: () => void
  onDeactivate: () => void
  onActivate: () => void
  onCreateSavedImage?: () => void
}

export function useSavedImagesCommands({
  writePermitted,
  deletePermitted,
  selectedCount,
  selectableCount,
  toggleAllRowsSelected,
  bulkActionCounts,
  onDelete,
  onActivate,
  onDeactivate,
  onCreateSavedImage,
}: UseSavedImagesCommandsProps) {
  const rootCommands: CommandConfig[] = useMemo(() => {
    const commands: CommandConfig[] = []

    if (writePermitted && onCreateSavedImage) {
      commands.push({
        id: 'create-saved-image',
        label: 'Create Image',
        icon: <PlusIcon className="w-4 h-4" />,
        onSelect: onCreateSavedImage,
      })
    }

    if (selectableCount !== selectedCount) {
      commands.push({
        id: 'select-all-savedImages',
        label: 'Select All Images',
        icon: <CheckSquare2Icon className="w-4 h-4" />,
        onSelect: () => toggleAllRowsSelected(true),
        chainable: true,
      })
    }

    if (selectedCount > 0) {
      commands.push({
        id: 'deselect-all-savedImages',
        label: 'Deselect All Images',
        icon: <MinusSquareIcon className="w-4 h-4" />,
        onSelect: () => toggleAllRowsSelected(false),
        chainable: true,
      })
    }

    if (writePermitted && bulkActionCounts.deactivatable > 0) {
      commands.push({
        id: 'deactivate-savedImages',
        label: `Deactivate ${pluralize(bulkActionCounts.deactivatable, 'Image', 'Images')}`,
        icon: <PauseIcon className="w-4 h-4" />,
        onSelect: onDeactivate,
      })
    }

    if (writePermitted && bulkActionCounts.activatable > 0) {
      commands.push({
        id: 'activate-savedImages',
        label: `Activate ${pluralize(bulkActionCounts.activatable, 'Image', 'Images')}`,
        icon: <PlayIcon className="w-4 h-4" />,
        onSelect: onActivate,
      })
    }

    if (deletePermitted && bulkActionCounts.deletable > 0) {
      commands.push({
        id: 'delete-savedImages',
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
    onCreateSavedImage,
  ])

  useRegisterCommands(rootCommands, { groupId: 'saved-image-actions', groupLabel: 'Image actions', groupOrder: 0 })
}
