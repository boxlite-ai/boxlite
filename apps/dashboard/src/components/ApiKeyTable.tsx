/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ResourceFilterEmptyState, ResourceEmptyState, ResourceIdentity } from '@/components/ResourceLayout'
import { AsciiButton } from '@/components/ascii'
import { ApiKeyPermissionsSummary } from './ApiKeyPermissionsSummary'
import { apiKeyExpirationLabel, apiKeyExpirationDate } from '@/lib/api-key-permissions'
import { getRelativeTimeString } from '@/lib/utils'
import { ApiKeyList } from '@boxlite-ai/api-client'
import { KeyRound, Loader2, Trash2 } from '@/components/ui/icon'
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
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

interface DataTableProps {
  data: ApiKeyList[]
  loading: boolean
  isLoadingKey: (key: ApiKeyList) => boolean
  onRevoke: (key: ApiKeyList) => void
  onClearFilter?: () => void
}

const GRID = 'grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(150px,1fr)_repeat(3,100px)_28px] gap-x-4'

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
                      <ApiKeyPermissionsSummary permissions={[...key.permissions, ...(key.proxyPermissions ?? [])]} />
                    </span>
                    <span className="font-mono text-meta text-muted-foreground">
                      {getRelativeTimeString(key.createdAt).relativeTimeString}
                    </span>
                    <span className="font-mono text-meta text-muted-foreground">
                      {key.lastUsedAt ? getRelativeTimeString(key.lastUsedAt).relativeTimeString : 'Never'}
                    </span>
                    <span className="font-mono text-meta text-muted-foreground">
                      {key.expiresAt ? (
                        <Popover>
                          <PopoverTrigger className="text-left underline decoration-dotted underline-offset-4 focus-visible:outline focus-visible:outline-2">
                            {apiKeyExpirationLabel(key.expiresAt)}
                          </PopoverTrigger>
                          <PopoverContent className="text-body">{apiKeyExpirationDate(key.expiresAt)}</PopoverContent>
                        </Popover>
                      ) : (
                        'No expiration'
                      )}
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
