/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ResourceEmptyState } from '@/components/ResourceLayout'
import { TableRow, TableCell } from './ui/table'

interface TableEmptyStateProps {
  /**
   * The number of columns in the table (used for colSpan)
   */
  colSpan: number
  /**
   * The message to display when no data is found
   */
  message: string
  /**
   * Optional icon to display above the message
   */
  icon?: React.ReactNode
  /**
   * Optional description text to display below the main message
   */
  description?: React.ReactNode
  /**
   * Additional CSS classes for the container
   */
  className?: string
}

/** Spans the table columns with the shared resource empty state and optional guidance. */
export function TableEmptyState({ colSpan, message, icon, description, className = '' }: TableEmptyStateProps) {
  return (
    <TableRow className="hover:bg-background">
      <TableCell colSpan={colSpan} className={`p-0 text-center ${className}`}>
        <ResourceEmptyState title={message} icon={icon} description={description} />
      </TableCell>
    </TableRow>
  )
}
