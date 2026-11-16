/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ResourceFilterEmptyState, ResourceEmptyState, ResourceIdentity } from '@/components/ResourceLayout'
import { AsciiButton } from '@/components/ascii'
import { CREATE_API_KEY_PERMISSIONS_GROUPS } from '@/constants/CreateApiKeyPermissionsGroups'
import { getRelativeTimeString } from '@/lib/utils'
import { ApiKeyList, ApiKeyListPermissionsEnum } from '@boxlite-ai/api-client'
import { KeyRound, Loader2, Trash2 } from '@/components/ui/icon'
import { useMemo } from 'react'
import { Badge } from './ui/badge'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Button } from './ui/button'

interface DataTableProps {
  data: ApiKeyList[]
  loading: boolean
  isLoadingKey: (key: ApiKeyList) => boolean
  onRevoke: (key: ApiKeyList) => void
  onClearFilter?: () => void
}

const GRID = 'grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_84px_repeat(3,82px)_28px] gap-x-4'

/**
 * Lists API keys with a confirmation step before calling the owner's revoke handler.
 * Per-key loading state disables revocation while its request is in flight.
 */
export function ApiKeyTable({ data, loading, isLoadingKey, onRevoke, onClearFilter }: DataTableProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="resource-content scroll-edge">
        <div className={loading || data.length > 0 ? 'min-w-[720px]' : 'flex flex-1 flex-col'}>
          {/* header */}
          <div
            className={`${!loading && data.length === 0 ? 'hidden' : 'grid'} ${GRID} resource-list-head flex-none items-center`}
          >
            <span>Name</span>
            <span>Key</span>
            <span>Permissions</span>
            <span>Created</span>
            <span>Last Used</span>
            <span>Expires</span>
            <span />
          </div>

          {/* rows */}
          <div className="flex flex-1 flex-col">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`grid ${GRID} items-center border-b border-border px-[18px] py-3`}>
                  <div className="h-4 w-3/4 animate-pulse bg-card" />
                </div>
              ))
            ) : data.length === 0 && onClearFilter ? (
              <ResourceFilterEmptyState title="No API keys match your search" onClear={onClearFilter} />
            ) : data.length === 0 ? (
              <ResourceEmptyState
                title="No API Keys yet."
                icon={<KeyRound className="size-6" />}
                description="Create a key to get started."
              />
            ) : (
              data.map((key) => {
                const busy = isLoadingKey(key)
                return (
                  <div
                    key={`${key.userId}-${key.name}`}
                    className={`grid ${GRID} resource-list-row items-center ${
                      busy ? 'pointer-events-none opacity-50' : ''
                    }`}
                  >
                    <ResourceIdentity icon={<KeyRound />}>
                      <span className="resource-name" title={key.name}>
                        {key.name}
                      </span>
                    </ResourceIdentity>
                    <span className="truncate font-mono text-meta text-muted-foreground" title={key.value}>
                      {key.value}
                    </span>
                    <span>
                      <PermissionsTooltip permissions={key.permissions} />
                    </span>
                    <span className="font-mono text-meta text-muted-foreground">
                      {getRelativeTimeString(key.createdAt).relativeTimeString}
                    </span>
                    <span className="font-mono text-meta text-muted-foreground">
                      {key.lastUsedAt ? getRelativeTimeString(key.lastUsedAt).relativeTimeString : 'Never'}
                    </span>
                    <span className="font-mono text-meta text-muted-foreground">
                      {key.expiresAt ? getRelativeTimeString(key.expiresAt).relativeTimeString : 'Never'}
                    </span>
                    <span className="flex justify-end">
                      <Dialog>
                        <DialogTrigger asChild>
                          <AsciiButton
                            variant="quiet-danger"
                            size="icon"
                            aria-label="Revoke key"
                            type="button"
                            title="Revoke key"
                            disabled={busy}
                          >
                            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                          </AsciiButton>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Confirm Key Revocation</DialogTitle>
                            <DialogDescription>
                              Are you absolutely sure? This action cannot be undone and will permanently delete this API
                              key.
                            </DialogDescription>
                          </DialogHeader>
                          <DialogFooter>
                            <DialogClose asChild>
                              <Button type="button" variant="secondary">
                                Close
                              </Button>
                            </DialogClose>
                            <DialogClose asChild>
                              <Button variant="destructive" onClick={() => onRevoke(key)}>
                                Revoke
                              </Button>
                            </DialogClose>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* footer */}
      {(loading || data.length > 0 || onClearFilter) && (
        <div className="resource-footer shrink-0">
          <span>
            Showing {data.length} key{data.length === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </div>
  )
}

const visiblePermissions = CREATE_API_KEY_PERMISSIONS_GROUPS.flatMap((group) => group.permissions)
const IMPLICIT_READ_RESOURCES = ['Boxes']

function PermissionsTooltip({ permissions }: { permissions: ApiKeyListPermissionsEnum[] }) {
  const isFullAccess = visiblePermissions.every((permission) => permissions.includes(permission))
  const isSingleResourceAccess = CREATE_API_KEY_PERMISSIONS_GROUPS.find(
    (group) =>
      group.permissions.length === permissions.length && group.permissions.every((p) => permissions.includes(p)),
  )

  const availableGroups = useMemo(
    () => CREATE_API_KEY_PERMISSIONS_GROUPS.filter((group) => group.permissions.length > 0),
    [],
  )

  const badgeText = isSingleResourceAccess ? isSingleResourceAccess.name : isFullAccess ? 'Full' : 'Restricted'

  return (
    <Popover>
      <PopoverTrigger className="border-b border-dotted border-border-selected text-meta text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground">
        {badgeText}
      </PopoverTrigger>
      <PopoverContent className="p-0">
        <p className="border-b border-border p-2 text-meta font-medium text-muted-foreground">Permissions</p>
        <div className="flex flex-col">
          {availableGroups.map((group) => {
            const selectedPermissions = group.permissions.filter((p) => permissions.includes(p))
            const hasImplicitRead = IMPLICIT_READ_RESOURCES.includes(group.name)
            if (selectedPermissions.length === 0 && !hasImplicitRead) return null
            return (
              <div key={group.name} className="flex justify-between gap-3 border-b border-border p-2 last:border-b-0">
                <h3 className="text-body">{group.name}</h3>
                <div className="flex flex-wrap justify-end gap-2">
                  {hasImplicitRead && (
                    <Badge variant="outline" className="capitalize">
                      Read
                    </Badge>
                  )}
                  {selectedPermissions.map((p) => (
                    <Badge key={p} variant="outline" className="capitalize">
                      {p.split(':')[0]}
                    </Badge>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
