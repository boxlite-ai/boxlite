/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useState } from 'react'
import { MoreHorizontal } from '@/components/ui/icon'
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from '@tanstack/react-table'
import { OrganizationUser } from '@boxlite-ai/api-client'
import { Pagination } from '@/components/Pagination'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { TableHeader, TableRow, TableHead, TableBody, TableCell, Table } from '@/components/ui/table'
import { RemoveOrganizationMemberDialog } from '@/components/OrganizationMembers/RemoveOrganizationMemberDialog'
import { capitalize } from '@/lib/utils'
import { DEFAULT_PAGE_SIZE } from '@/constants/Pagination'
import { TableEmptyState } from '../TableEmptyState'

interface DataTableProps {
  data: OrganizationUser[]
  loadingData: boolean
  onRemoveMember: (userId: string) => Promise<boolean>
  loadingMemberAction: Record<string, boolean>
  ownerMode: boolean
}

export function OrganizationMemberTable({
  data,
  loadingData,
  onRemoveMember,
  loadingMemberAction,
  ownerMode,
}: DataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [memberToRemove, setMemberToRemove] = useState<string | null>(null)
  const [isRemoveDialogOpen, setIsRemoveDialogOpen] = useState(false)

  const columns = getColumns({
    onRemove: (userId: string) => {
      setMemberToRemove(userId)
      setIsRemoveDialogOpen(true)
    },
    ownerMode,
  })

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    state: {
      sorting,
    },
    initialState: {
      pagination: {
        pageSize: DEFAULT_PAGE_SIZE,
      },
    },
  })

  const handleConfirmRemove = async () => {
    if (memberToRemove) {
      const success = await onRemoveMember(memberToRemove)
      if (success) {
        setMemberToRemove(null)
        setIsRemoveDialogOpen(false)
      }
      return success
    }
    return false
  }

  return (
    <>
      <div>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    return (
                      <TableHead key={header.id}>
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    )
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {loadingData ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-24 text-center">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : table.getRowModel().rows?.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() && 'selected'}
                    className={`h-14 ${loadingMemberAction[row.original.userId] ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableEmptyState colSpan={columns.length} message="No Members found." />
              )}
            </TableBody>
          </Table>
        </div>
        <Pagination table={table} className="mt-4" entityName="Members" />
      </div>

      {memberToRemove && (
        <RemoveOrganizationMemberDialog
          open={isRemoveDialogOpen}
          onOpenChange={(open) => {
            setIsRemoveDialogOpen(open)
            if (!open) {
              setMemberToRemove(null)
            }
          }}
          onRemoveMember={handleConfirmRemove}
          loading={loadingMemberAction[memberToRemove]}
        />
      )}
    </>
  )
}

const getColumns = ({
  onRemove,
  ownerMode,
}: {
  onRemove: (userId: string) => void
  ownerMode: boolean
}): ColumnDef<OrganizationUser>[] => {
  const columns: ColumnDef<OrganizationUser>[] = [
    {
      accessorKey: 'email',
      header: 'Email',
    },
    {
      accessorKey: 'role',
      header: () => {
        return <div className="px-3 w-24">Role</div>
      },
      cell: ({ row }) => <div className="px-3 text-sm">{capitalize(row.original.role)}</div>,
    },
  ]

  if (ownerMode) {
    columns.push({
      id: 'actions',
      cell: ({ row }) => {
        // The API refuses to remove a user from their own personal organization.
        if (row.original.isDefaultForUser) {
          return null
        }

        return (
          <div className="text-right">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 p-0">
                  <span className="sr-only">Open menu</span>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="cursor-pointer text-red-600 dark:text-red-400"
                  onClick={() => onRemove(row.original.userId)}
                >
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      },
    })
  }

  return columns
}
