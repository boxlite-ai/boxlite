/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  FormDialogContent as DialogContent,
  FormDialogHeader as DialogHeader,
  FormDialogFooter as DialogFooter,
  FormDialogBody,
} from '@/components/ui/form-dialog'
import { AsciiButton } from '@/components/ascii'
import { Dialog, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
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

/** Creates an organization API key with a selected expiry and permission set, then exposes its one-time secret. */
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

  const handleCreate = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
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
        <AsciiButton variant="primary" title="Create Key" className={className}>
          <Plus className="size-4" />
          Create Key
        </AsciiButton>
      </DialogTrigger>

      <DialogContent>
        {revealKey ? (
          <>
            <DialogHeader>
              <DialogTitle>API Key Created</DialogTitle>
              <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
                Copy your key now. For security, you won&apos;t be able to see it again.
              </DialogDescription>
            </DialogHeader>
            <FormDialogBody>
              <div className="flex items-center gap-3 border border-brand bg-card px-4 py-[14px]">
                <span className="flex-1 break-all font-mono text-[13px] text-brand">{revealKey}</span>
                <AsciiButton variant="primary" type="button" onClick={() => copy(revealKey)}>
                  {keyCopied ? 'Copied' : 'Copy'}
                </AsciiButton>
              </div>
            </FormDialogBody>
            <DialogFooter>
              <AsciiButton type="button" onClick={() => setOpen(false)}>
                Done
              </AsciiButton>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create New API Key</DialogTitle>
              <DialogDescription className="text-[13px] text-muted-foreground">
                Create a key with your available API permissions.
              </DialogDescription>
            </DialogHeader>

            <form className="form-dialog-body" id="create-api-key-form" onSubmit={handleCreate}>
              <div className="space-y-5">
                {/* name */}
                <div className="flex flex-col gap-[10px]">
                  <div className="form-field-label">Key Name</div>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Name"
                    autoFocus
                    className="form-field-input"
                  />
                </div>

                {/* expires */}
                <div className="flex flex-col gap-[10px]">
                  <div className="form-field-label">Expires</div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className={cn(
                        'flex items-center gap-[11px] border border-border bg-card h-10 px-3 font-mono text-[13px] outline-none data-[state=open]:border-brand',
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
                    <div className="text-[13px] font-semibold text-brand">API access</div>
                    <div className="mt-[5px] text-[12.5px] leading-relaxed text-muted-foreground">
                      {availablePermissions.includes(CreateApiKeyPermissionsEnum.WRITE_MEMBERS)
                        ? 'This key includes member and invitation management. Use the API or SDK to create a key with fewer permissions.'
                        : 'This key includes your available resource permissions. Use the API or SDK to select fewer permissions.'}
                    </div>
                  </div>
                </div>
              </div>
            </form>

            <DialogFooter>
              <AsciiButton type="button" onClick={() => setOpen(false)}>
                Close
              </AsciiButton>
              <AsciiButton
                variant="primary"
                type="submit"
                form="create-api-key-form"
                disabled={!name.trim() || submitting || !organizationId || availablePermissions.length === 0}
              >
                {submitting ? 'Creating…' : 'Create'}
              </AsciiButton>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
