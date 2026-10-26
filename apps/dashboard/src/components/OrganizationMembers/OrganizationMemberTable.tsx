/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMemo, useState } from 'react'
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
import { OrganizationInvitation, OrganizationUser } from '@boxlite-ai/api-client'
import { Pagination } from '@/components/Pagination'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { TableHeader, TableRow, TableHead, TableBody, TableCell, Table } from '@/components/ui/table'
import { RemoveOrganizationMemberDialog } from '@/components/OrganizationMembers/RemoveOrganizationMemberDialog'
import { CancelOrganizationInvitationDialog } from '@/components/OrganizationMembers/CancelOrganizationInvitationDialog'
import { capitalize } from '@/lib/utils'
import { DEFAULT_PAGE_SIZE } from '@/constants/Pagination'
import { TableEmptyState } from '../TableEmptyState'

interface DataTableProps {
  data: OrganizationUser[]
  invitations: OrganizationInvitation[]
  loadingData: boolean
  onRemoveMember: (userId: string) => Promise<boolean>
  loadingMemberAction: Record<string, boolean>
  ownerMode: boolean
  onCancelInvitation: (invitationId: string) => Promise<boolean>
  onResendInvitation: (invitation: OrganizationInvitation) => Promise<boolean>
  loadingInvitationAction: Record<string, boolean>
}

type MemberRow = (OrganizationUser & { kind: 'member' }) | (OrganizationInvitation & { kind: 'invitation' })

export function OrganizationMemberTable({
  data,
  invitations,
  loadingData,
  onRemoveMember,
  loadingMemberAction,
  ownerMode,
  onCancelInvitation,
  onResendInvitation,
  loadingInvitationAction,
}: DataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [action, setAction] = useState<MemberRow | null>(null)
  const rows = useMemo<MemberRow[]>(
    () => [
      ...data.map((member) => ({ ...member, kind: 'member' as const })),
      ...(ownerMode ? invitations.map((invitation) => ({ ...invitation, kind: 'invitation' as const })) : []),
    ],
    [data, invitations, ownerMode],
  )

  const isLoading = (row: MemberRow) =>
    row.kind === 'member' ? loadingMemberAction[row.userId] : loadingInvitationAction[row.id]

  const columns = getColumns({
    onAction: setAction,
    onResendInvitation,
    isLoading,
    ownerMode,
  })

  const table = useReactTable({
    data: rows,
    columns,
    getRowId: (row) => (row.kind === 'member' ? `member:${row.userId}` : `invitation:${row.id}`),
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

  const handleConfirmAction = async () => {
    if (!action) return false
    const success = await (action.kind === 'member' ? onRemoveMember(action.userId) : onCancelInvitation(action.id))
    if (success) setAction(null)
    return success
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
                    className={`h-14 ${isLoading(row.original) ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableEmptyState colSpan={columns.length} message="No members or invitations found." />
              )}
            </TableBody>
          </Table>
        </div>
        <Pagination table={table} className="mt-4" entityName="Members" />
      </div>

      {action?.kind === 'member' && (
        <RemoveOrganizationMemberDialog
          open
          onOpenChange={(open) => {
            if (!open) setAction(null)
          }}
          onRemoveMember={handleConfirmAction}
          loading={isLoading(action)}
        />
      )}
      {action?.kind === 'invitation' && (
        <CancelOrganizationInvitationDialog
          open
          onOpenChange={(open) => {
            if (!open) setAction(null)
          }}
          onCancelInvitation={handleConfirmAction}
          expired={new Date(action.expiresAt) < new Date()}
          loading={isLoading(action)}
        />
      )}
    </>
  )
}

const getColumns = ({
  onAction,
  onResendInvitation,
  isLoading,
  ownerMode,
}: {
  onAction: (row: MemberRow) => void
  onResendInvitation: (invitation: OrganizationInvitation) => Promise<boolean>
  isLoading: (row: MemberRow) => boolean
  ownerMode: boolean
}): ColumnDef<MemberRow>[] => {
  const columns: ColumnDef<MemberRow>[] = [
    {
      accessorKey: 'email',
      header: 'Email',
      cell: ({ row }) => (
        <div>
          <div>{row.original.email}</div>
          {row.original.kind === 'invitation' && (
            <div className="mt-1 text-xs text-muted-foreground">
              Invited by {row.original.invitedBy} · Expires {new Date(row.original.expiresAt).toLocaleString()}
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      accessorFn: (row) =>
        row.kind === 'member' ? 'Member' : new Date(row.expiresAt) < new Date() ? 'Expired' : 'Invited',
      cell: ({ getValue }) => <span className="border border-border px-2 py-1 text-xs">{getValue<string>()}</span>,
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
        const item = row.original
        // The API refuses to remove a user from their own personal organization.
        if (item.kind === 'member' && item.isDefaultForUser) {
          return null
        }
        const expired = item.kind === 'invitation' && new Date(item.expiresAt) < new Date()

        return (
          <div className="text-right">
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={isLoading(item)}>
                <Button variant="ghost" className="h-8 w-8 p-0">
                  <span className="sr-only">Open menu</span>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="end">
                {item.kind === 'invitation' && expired && (
                  <DropdownMenuItem
                    className="cursor-pointer"
                    disabled={isLoading(item)}
                    onClick={() => onResendInvitation(item)}
                  >
                    Resend
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={isLoading(item)}
                  className="cursor-pointer text-red-600 dark:text-red-400"
                  onClick={() => onAction(item)}
                >
                  {item.kind === 'member' || expired ? 'Remove' : 'Cancel'}
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
