/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

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
}

// Mirrors the Boxes (BoxTable) layout: borderless full-height column, header with a
// bottom rule, hover-highlighted rows, and a plain "Showing N" footer.
const GRID = 'grid-cols-[1.4fr_1.6fr_1.2fr_1fr_1fr_1fr_44px] gap-x-4'

export function ApiKeyTable({ data, loading, isLoadingKey, onRevoke }: DataTableProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <div
        className={`grid ${GRID} flex-none items-center border-b border-border px-[18px] pb-[11px] font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground`}
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`grid ${GRID} items-center border-b border-border px-[18px] py-3`}>
              <div className="h-4 w-3/4 animate-pulse bg-card" />
            </div>
          ))
        ) : data.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <KeyRound className="size-14 text-muted-foreground opacity-70" strokeWidth={1.4} />
            <div className="mt-[22px] text-[17px] font-semibold">No API Keys yet.</div>
            <div className="mt-[18px] max-w-[440px] text-[13.5px] leading-relaxed text-muted-foreground">
              API Keys authenticate requests made through the BoxLite SDK or CLI.
            </div>
            <div className="mt-1.5 text-[13.5px] text-muted-foreground">
              Generate one and{' '}
              <a
                href="https://docs.boxlite.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-foreground underline decoration-brand underline-offset-2"
              >
                check out the API Key setup guide
              </a>
              .
            </div>
          </div>
        ) : (
          data.map((key) => {
            const busy = isLoadingKey(key)
            return (
              <div
                key={`${key.userId}-${key.name}`}
                className={`grid ${GRID} items-center border-b border-border px-[18px] py-3 text-[13px] transition-colors hover:bg-card ${
                  busy ? 'pointer-events-none opacity-50' : ''
                }`}
              >
                <span className="truncate font-semibold">{key.name}</span>
                <span className="truncate font-mono text-[12px] text-muted-foreground">{key.value}</span>
                <span>
                  <PermissionsTooltip permissions={key.permissions} />
                </span>
                <span className="font-mono text-[12px] text-muted-foreground">
                  {getRelativeTimeString(key.createdAt).relativeTimeString}
                </span>
                <span className="font-mono text-[12px] text-muted-foreground">
                  {key.lastUsedAt ? getRelativeTimeString(key.lastUsedAt).relativeTimeString : 'Never'}
                </span>
                <span className="font-mono text-[12px] text-muted-foreground">
                  {key.expiresAt ? getRelativeTimeString(key.expiresAt).relativeTimeString : 'Never'}
                </span>
                <span className="flex justify-end">
                  <Dialog>
                    <DialogTrigger asChild>
                      <button
                        type="button"
                        title="Revoke key"
                        disabled={busy}
                        className="inline-flex h-7 w-[30px] items-center justify-center border border-border text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
                      >
                        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                      </button>
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

      {/* footer */}
      <div className="flex flex-none items-center justify-between px-0 py-4 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
        <span>
          Showing {data.length} key{data.length === 1 ? '' : 's'}
        </span>
      </div>
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
      <PopoverTrigger>
        <span className="inline-flex items-center border border-brand/30 px-[9px] py-[3px] font-mono text-[11px] tracking-[0.5px] text-brand">
          {badgeText}
        </span>
      </PopoverTrigger>
      <PopoverContent className="p-0">
        <p className="border-b border-border p-2 text-xs font-medium text-muted-foreground">Permissions</p>
        <div className="flex flex-col">
          {availableGroups.map((group) => {
            const selectedPermissions = group.permissions.filter((p) => permissions.includes(p))
            const hasImplicitRead = IMPLICIT_READ_RESOURCES.includes(group.name)
            if (selectedPermissions.length === 0 && !hasImplicitRead) return null
            return (
              <div key={group.name} className="flex justify-between gap-3 border-b border-border p-2 last:border-b-0">
                <h3 className="text-sm">{group.name}</h3>
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
