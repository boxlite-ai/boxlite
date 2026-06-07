/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog'

export enum SavedImageBulkAction {
  Delete = 'delete',
  Deactivate = 'deactivate',
}

interface BulkActionData {
  title: string
  description: string
  buttonLabel: string
  buttonVariant?: 'destructive'
}

function getBulkActionData(action: SavedImageBulkAction, count: number): BulkActionData {
  const countText = count === 1 ? 'this image' : `these ${count} selected images`

  switch (action) {
    case SavedImageBulkAction.Delete:
      return {
        title: 'Delete Images',
        description: `Are you sure you want to delete ${countText}? This action cannot be undone.`,
        buttonLabel: 'Delete',
        buttonVariant: 'destructive',
      }
    case SavedImageBulkAction.Deactivate:
      return {
        title: 'Deactivate Images',
        description: `Are you sure you want to deactivate ${countText}? Deactivated images can be reactivated later.`,
        buttonLabel: 'Deactivate',
      }
  }
}

interface SavedImageBulkActionAlertDialogProps {
  action: SavedImageBulkAction | null
  count: number
  onConfirm: () => void
  onCancel: () => void
}

export function SavedImageBulkActionAlertDialog({
  action,
  count,
  onConfirm,
  onCancel,
}: SavedImageBulkActionAlertDialogProps) {
  const data = action ? getBulkActionData(action, count) : null

  if (!data) return null

  return (
    <AlertDialog open={action !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <>
          <AlertDialogHeader>
            <AlertDialogTitle>{data.title}</AlertDialogTitle>
            <AlertDialogDescription>{data.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm} variant={data.buttonVariant}>
              {data.buttonLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </>
      </AlertDialogContent>
    </AlertDialog>
  )
}
