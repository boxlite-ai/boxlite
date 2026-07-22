/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCreateApiKeyMutation } from '@/hooks/mutations/useCreateApiKeyMutation'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { CreateApiKeyPermissionsEnum } from '@boxlite-ai/api-client'
import { Calendar, Info, Plus } from '@/components/ui/icon'
import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'

interface CreateApiKeyDialogProps {
  availablePermissions: CreateApiKeyPermissionsEnum[]
  apiUrl: string
  className?: string
  organizationId?: string
}

const EXPIRY_OPTS: { label: string; days: number | null }[] = [
  { label: 'No expiration', days: null },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
]

export const CreateApiKeyDialog: React.FC<CreateApiKeyDialogProps> = ({
  availablePermissions,
  className,
  organizationId,
}) => {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [expiryIdx, setExpiryIdx] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [revealKey, setRevealKey] = useState<string | null>(null)
  const [copied, copy] = useCopyToClipboard()

  const { mutateAsync } = useCreateApiKeyMutation()

  useEffect(() => {
    if (open) {
      setName('')
      setExpiryIdx(0)
      setSubmitting(false)
      setRevealKey(null)
    }
  }, [open])

  const handleCreate = async () => {
    if (!organizationId) {
      toast.error('Select an organization to create an API key.')
      return
    }
    if (!name.trim()) return
    setSubmitting(true)
    try {
      const opt = EXPIRY_OPTS[expiryIdx]
      const expiresAt = opt.days ? new Date(Date.now() + opt.days * 86400000) : null
      const created = await mutateAsync({
        organizationId,
        name: name.trim(),
        permissions: availablePermissions,
        expiresAt,
      })
      toast.success('API key created successfully')
      setRevealKey(created.value)
    } catch (error) {
      handleApiError(error, 'Failed to create API key')
    } finally {
      setSubmitting(false)
    }
  }

  const keyCopied = revealKey != null && copied === revealKey

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          title="Create Key"
          className={cn(
            'inline-flex h-[34px] items-center gap-2 bg-primary px-4 text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-85',
            className,
          )}
        >
          <Plus className="size-3.5" strokeWidth={2.4} />
          Create Key
        </button>
      </DialogTrigger>

      <DialogContent className="gap-0 p-0 sm:max-w-[560px]">
        {revealKey ? (
          <>
            <DialogHeader className="px-[26px] pb-0 pt-6">
              <DialogTitle className="text-[20px] font-bold">API Key Created</DialogTitle>
              <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
                Copy your key now. For security, you won&apos;t be able to see it again.
              </DialogDescription>
            </DialogHeader>
            <div className="px-[26px] py-[22px]">
              <div className="flex items-center gap-3 border border-brand bg-card px-4 py-[14px]">
                <span className="flex-1 break-all font-mono text-[13px] text-brand">{revealKey}</span>
                <button
                  type="button"
                  onClick={() => copy(revealKey)}
                  className="flex-none bg-primary px-4 py-2 text-[12px] font-semibold text-primary-foreground transition-opacity hover:opacity-85"
                >
                  {keyCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="flex justify-end border-t border-border px-[26px] py-4">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="border border-border px-[22px] py-[11px] text-[13px] font-medium transition-colors hover:bg-card"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader className="px-[26px] pb-0 pt-6">
              <DialogTitle className="text-[21px] font-bold tracking-[-0.3px]">Create New API Key</DialogTitle>
              <DialogDescription className="text-[13px] text-muted-foreground">
                Create a key for Boxes API access.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-[22px] px-[26px] py-6">
              {/* name */}
              <div className="flex flex-col gap-[10px]">
                <div className="text-[13px] font-semibold">Key Name</div>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name"
                  autoFocus
                  className="border border-border bg-card px-[14px] py-[13px] font-mono text-[13px] text-foreground outline-none focus:border-brand"
                />
              </div>

              {/* expires */}
              <div className="flex flex-col gap-[10px]">
                <div className="text-[13px] font-semibold">Expires</div>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className={cn(
                      'flex items-center gap-[11px] border border-border bg-card px-[14px] py-[13px] font-mono text-[13px] outline-none data-[state=open]:border-brand',
                      expiryIdx === 0 ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    <Calendar className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={2} />
                    {EXPIRY_OPTS[expiryIdx].label}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="min-w-[var(--radix-dropdown-menu-trigger-width)] font-mono text-[12px]"
                  >
                    {EXPIRY_OPTS.map((opt, i) => (
                      <DropdownMenuItem
                        key={opt.label}
                        className={cn('cursor-pointer', i === expiryIdx && 'text-brand')}
                        onClick={() => setExpiryIdx(i)}
                      >
                        {opt.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <div className="text-[12px] text-muted-foreground">Optional expiration date for the API key.</div>
              </div>

              {/* info */}
              <div className="flex gap-3 border border-brand/25 bg-brand/[0.06] px-[18px] py-4">
                <Info className="mt-0.5 size-[17px] shrink-0 text-brand" strokeWidth={2} />
                <div>
                  <div className="text-[13px] font-semibold text-brand">Boxes API access</div>
                  <div className="mt-[5px] text-[12.5px] leading-relaxed text-muted-foreground">
                    This key can create and manage Boxes. Shared Linux base images are available automatically.
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-[10px] border-t border-border px-[26px] py-4">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="border border-border px-[22px] py-[11px] text-[13px] font-medium transition-colors hover:bg-card"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={!name.trim() || submitting || !organizationId || availablePermissions.length === 0}
                className="bg-primary px-[26px] py-[11px] text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {submitting ? 'Creating…' : 'Create'}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
