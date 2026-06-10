/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { pluralize } from '@/lib/utils'
import { BulkActionCounts } from '@/lib/utils/box'
import { CheckSquare2Icon, MinusSquareIcon, PlayIcon, SquareIcon, TrashIcon } from 'lucide-react'
import { useMemo } from 'react'
import { CommandConfig, useRegisterCommands } from '../CommandPalette'

interface UseBoxCommandsProps {
  writePermitted: boolean
  deletePermitted: boolean
  selectedCount: number
  totalCount: number
  selectableCount: number
  toggleAllRowsSelected: (selected: boolean) => void
  bulkActionCounts: BulkActionCounts
  onDelete: () => void
  onStart: () => void
  onStop: () => void
}

export function useBoxCommands({
  writePermitted,
  deletePermitted,
  selectedCount,
  selectableCount,
  totalCount,
  toggleAllRowsSelected,
  bulkActionCounts,
  onDelete,
  onStart,
  onStop,
}: UseBoxCommandsProps) {
  const rootCommands: CommandConfig[] = useMemo(() => {
    const commands: CommandConfig[] = []

    if (selectableCount !== selectedCount) {
      commands.push({
        id: 'select-all-boxes',
        label: 'Select All Boxes',
        icon: <CheckSquare2Icon className="w-4 h-4" />,
        onSelect: () => toggleAllRowsSelected(true),
        chainable: true,
      })
    }

    if (selectedCount > 0) {
      commands.push({
        id: 'deselect-all-boxes',
        label: 'Deselect All Boxes',
        icon: <MinusSquareIcon className="w-4 h-4" />,
        onSelect: () => toggleAllRowsSelected(false),
        chainable: true,
      })
    }

    if (writePermitted && bulkActionCounts.startable > 0) {
      commands.push({
        id: 'start-boxes',
        label: `Start ${pluralize(bulkActionCounts.startable, 'Box', 'Boxes')}`,
        icon: <PlayIcon className="w-4 h-4" />,
        onSelect: onStart,
      })
    }

    if (writePermitted && bulkActionCounts.stoppable > 0) {
      commands.push({
        id: 'stop-boxes',
        label: `Stop ${pluralize(bulkActionCounts.stoppable, 'Box', 'Boxes')}`,
        icon: <SquareIcon className="w-4 h-4" />,
        onSelect: onStop,
      })
    }

    if (deletePermitted && bulkActionCounts.deletable > 0) {
      commands.push({
        id: 'delete-boxes',
        label: `Delete ${pluralize(bulkActionCounts.deletable, 'Box', 'Boxes')}`,
        icon: <TrashIcon className="w-4 h-4" />,
        onSelect: onDelete,
      })
    }

    return commands
  }, [
    selectedCount,
    selectableCount,
    toggleAllRowsSelected,
    writePermitted,
    deletePermitted,
    bulkActionCounts,
    onDelete,
    onStart,
    onStop,
  ])

  useRegisterCommands(rootCommands, { groupId: 'box-actions', groupLabel: 'Box actions', groupOrder: 0 })
}
