/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { pluralize } from '@/lib/utils'
import { SnapshotDto, SnapshotState } from '@boxlite-ai/api-client'
import { CheckSquare2Icon, MinusSquareIcon, PauseIcon, PlayIcon, PlusIcon, TrashIcon } from 'lucide-react'
import { useMemo } from 'react'
import { CommandConfig, useRegisterCommands } from '../../CommandPalette'

export interface SnapshotBulkActionCounts {
  deletable: number
  deactivatable: number
  activatable: number
}

export function isSnapshotDeletable(snapshot: SnapshotDto): boolean {
  return snapshot.state !== SnapshotState.REMOVING
}

export function isSnapshotDeactivatable(snapshot: SnapshotDto): boolean {
  return snapshot.state === SnapshotState.ACTIVE
}

export function isSnapshotActivatable(snapshot: SnapshotDto): boolean {
  return snapshot.state === SnapshotState.INACTIVE
}

export function getSnapshotBulkActionCounts(snapshots: SnapshotDto[]): SnapshotBulkActionCounts {
  return {
    deletable: snapshots.filter(isSnapshotDeletable).length,
    deactivatable: snapshots.filter(isSnapshotDeactivatable).length,
    activatable: snapshots.filter(isSnapshotActivatable).length,
  }
}

interface UseSnapshotsCommandsProps {
  writePermitted: boolean
  deletePermitted: boolean
  selectedCount: number
  totalCount: number
  selectableCount: number
  toggleAllRowsSelected: (selected: boolean) => void
  bulkActionCounts: SnapshotBulkActionCounts
  onDelete: () => void
  onDeactivate: () => void
  onActivate: () => void
  onCreateSnapshot?: () => void
}

export function useSnapshotsCommands({
  writePermitted,
  deletePermitted,
  selectedCount,
  selectableCount,
  toggleAllRowsSelected,
  bulkActionCounts,
  onDelete,
  onActivate,
  onDeactivate,
  onCreateSnapshot,
}: UseSnapshotsCommandsProps) {
  const rootCommands: CommandConfig[] = useMemo(() => {
    const commands: CommandConfig[] = []

    if (writePermitted && onCreateSnapshot) {
      commands.push({
        id: 'create-snapshot',
        label: 'Create Image',
        icon: <PlusIcon className="w-4 h-4" />,
        onSelect: onCreateSnapshot,
      })
    }

    if (selectableCount !== selectedCount) {
      commands.push({
        id: 'select-all-snapshots',
        label: 'Select All Images',
        icon: <CheckSquare2Icon className="w-4 h-4" />,
        onSelect: () => toggleAllRowsSelected(true),
        chainable: true,
      })
    }

    if (selectedCount > 0) {
      commands.push({
        id: 'deselect-all-snapshots',
        label: 'Deselect All Images',
        icon: <MinusSquareIcon className="w-4 h-4" />,
        onSelect: () => toggleAllRowsSelected(false),
        chainable: true,
      })
    }

    if (writePermitted && bulkActionCounts.deactivatable > 0) {
      commands.push({
        id: 'deactivate-snapshots',
        label: `Deactivate ${pluralize(bulkActionCounts.deactivatable, 'Image', 'Images')}`,
        icon: <PauseIcon className="w-4 h-4" />,
        onSelect: onDeactivate,
      })
    }

    if (writePermitted && bulkActionCounts.activatable > 0) {
      commands.push({
        id: 'activate-snapshots',
        label: `Activate ${pluralize(bulkActionCounts.activatable, 'Image', 'Images')}`,
        icon: <PlayIcon className="w-4 h-4" />,
        onSelect: onActivate,
      })
    }

    if (deletePermitted && bulkActionCounts.deletable > 0) {
      commands.push({
        id: 'delete-snapshots',
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
    onCreateSnapshot,
  ])

  useRegisterCommands(rootCommands, { groupId: 'snapshot-actions', groupLabel: 'Image actions', groupOrder: 0 })
}
