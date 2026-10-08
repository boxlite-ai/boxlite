/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus } from '@/components/ui/icon'
import React, { useState } from 'react'

interface CreateOrganizationInvitationDialogProps {
  onCreateInvitation: (email: string) => Promise<boolean>
  className?: string
}

export const CreateOrganizationInvitationDialog: React.FC<CreateOrganizationInvitationDialogProps> = ({
  onCreateInvitation,
  className,
}) => {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)

  const handleCreateInvitation = async () => {
    setLoading(true)
    const success = await onCreateInvitation(email)
    if (success) {
      setOpen(false)
      setEmail('')
    }
    setLoading(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen)
        if (!isOpen) {
          setEmail('')
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="default" size="sm" className={className} title="Add Registry">
          <Plus className="w-4 h-4" />
          Invite Member
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite Member</DialogTitle>
          <DialogDescription>
            Members have full access to the organization. The invitee accepts after signing in with this email.
          </DialogDescription>
        </DialogHeader>
        <form
          id="invitation-form"
          className="space-y-6 overflow-y-auto px-1 pb-1"
          onSubmit={async (e) => {
            e.preventDefault()
            await handleCreateInvitation()
          }}
        >
          <div className="space-y-3">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              value={email}
              type="email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="mail@example.com"
            />
          </div>
        </form>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="secondary" disabled={loading}>
              Cancel
            </Button>
          </DialogClose>
          {loading ? (
            <Button type="button" variant="default" disabled>
              Inviting...
            </Button>
          ) : (
            <Button type="submit" form="invitation-form" variant="default" disabled={!email.trim()}>
              Invite
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
