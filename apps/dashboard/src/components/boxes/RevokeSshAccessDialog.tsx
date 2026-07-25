/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useState } from 'react'
import { TemporarySshCredentialStatusEnum } from '@boxlite-ai/api-client'
import { toast } from 'sonner'
import { Field, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useRevokeSshAccessMutation } from '@/hooks/mutations/useRevokeSshAccessMutation'
import { useSshCredentialsQuery } from '@/hooks/queries/useSshCredentialsQuery'
import { handleApiError } from '@/lib/error-handling'

interface RevokeSshAccessDialogProps {
  boxId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RevokeSshAccessDialog({ boxId, open, onOpenChange }: RevokeSshAccessDialogProps) {
  const [credentialId, setCredentialId] = useState('')
  const { data: credentials, isLoading } = useSshCredentialsQuery(boxId, open)
  const revokeMutation = useRevokeSshAccessMutation()

  const activeCredentials = (credentials ?? []).filter((c) => c.status === TemporarySshCredentialStatusEnum.ACTIVE)

  const handleOpenChange = (isOpen: boolean) => {
    onOpenChange(isOpen)
    if (!isOpen) {
      setCredentialId('')
      revokeMutation.reset()
    }
  }

  const handleRevoke = async () => {
    if (!credentialId) {
      toast.error('Please select a credential to revoke')
      return
    }
    try {
      await revokeMutation.mutateAsync({ boxId, credentialId })
      toast.success('SSH access revoked successfully')
      handleOpenChange(false)
    } catch (error) {
      handleApiError(error, 'Failed to revoke SSH access')
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Revoke SSH Access</DialogTitle>
          <DialogDescription>Select the SSH credential you want to revoke.</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="ssh-revoke-credential">Credential</FieldLabel>
          <Select value={credentialId} onValueChange={setCredentialId} disabled={isLoading}>
            <SelectTrigger id="ssh-revoke-credential">
              <SelectValue
                placeholder={
                  isLoading
                    ? 'Loading credentials…'
                    : activeCredentials.length === 0
                      ? 'No active credentials'
                      : 'Select a credential'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {activeCredentials.map((credential) => (
                <SelectItem key={credential.id} value={credential.id}>
                  {credential.publicKeyFingerprint}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button variant="destructive" onClick={handleRevoke} disabled={!credentialId || revokeMutation.isPending}>
            {revokeMutation.isPending && <Spinner />}
            Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
