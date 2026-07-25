/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useCallback, useEffect, useState } from 'react'
import { TemporarySshCredentialCreated } from '@boxlite-ai/api-client'
import { useForm } from '@tanstack/react-form'
import { CheckIcon, CopyIcon, DownloadIcon, InfoIcon } from '@/components/ui/icon'
import { AnimatePresence, motion } from 'motion/react'
import { NumericFormat } from 'react-number-format'
import { z } from 'zod'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { useCreateSshAccessMutation } from '@/hooks/mutations/useCreateSshAccessMutation'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { handleApiError } from '@/lib/error-handling'

interface CreateSshAccessDialogProps {
  boxId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

type CreatedSshAccess = TemporarySshCredentialCreated & { privateKeyPem: string }

const MotionCopyIcon = motion(CopyIcon)
const MotionCheckIcon = motion(CheckIcon)

const iconProps = {
  initial: { opacity: 0, y: 5 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -5 },
  transition: { duration: 0.1 },
}

const formSchema = z.object({
  expiryMinutes: z.number().int('Must be a whole number').min(1, 'Minimum 1 minute').max(60, 'Maximum 60 minutes'),
})

type FormValues = z.infer<typeof formSchema>

const defaultValues: FormValues = {
  expiryMinutes: 5,
}

export function CreateSshAccessDialog({ boxId, open, onOpenChange }: CreateSshAccessDialogProps) {
  const [sshAccess, setSshAccess] = useState<CreatedSshAccess | null>(null)
  const { reset: resetMutation, ...createMutation } = useCreateSshAccessMutation()

  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: formSchema,
    },
    onSubmit: async ({ value }) => {
      try {
        const result = await createMutation.mutateAsync({
          boxId,
          expiresInSeconds: value.expiryMinutes * 60,
        })
        setSshAccess(result)
      } catch (error) {
        handleApiError(error, 'Failed to create SSH access')
      }
    },
  })

  const resetState = useCallback(() => {
    form.reset(defaultValues)
    resetMutation()
    setSshAccess(null)
  }, [form, resetMutation])

  useEffect(() => {
    if (open) {
      resetState()
    }
  }, [open, resetState])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{sshAccess ? 'SSH Access Created' : 'Create SSH Access'}</DialogTitle>
          <DialogDescription>
            {sshAccess ? 'Your SSH access has been created successfully.' : 'Set the expiration time for SSH access.'}
          </DialogDescription>
        </DialogHeader>
        {sshAccess ? (
          <SshAccessCreated sshAccess={sshAccess} />
        ) : (
          <form
            id="create-ssh-form"
            onSubmit={(e) => {
              e.preventDefault()
              e.stopPropagation()
              form.handleSubmit()
            }}
          >
            <form.Field name="expiryMinutes">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Expiry</FieldLabel>
                    <InputGroup>
                      <NumericFormat
                        customInput={InputGroupInput}
                        aria-invalid={isInvalid}
                        id={field.name}
                        name={field.name}
                        inputMode="numeric"
                        allowNegative={false}
                        decimalScale={0}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onValueChange={({ floatValue }) => field.handleChange(floatValue ?? 0)}
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupText>min</InputGroupText>
                      </InputGroupAddon>
                    </InputGroup>
                    {field.state.meta.errors.length > 0 && field.state.meta.isTouched && (
                      <FieldError errors={field.state.meta.errors} />
                    )}
                  </Field>
                )
              }}
            </form.Field>
          </form>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
          {!sshAccess && (
            <form.Subscribe
              selector={(state) => [state.canSubmit, state.isSubmitting]}
              children={([canSubmit, isSubmitting]) => (
                <Button type="submit" form="create-ssh-form" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting && <Spinner />}
                  Create
                </Button>
              )}
            />
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SshAccessCreated({ sshAccess }: { sshAccess: CreatedSshAccess }) {
  const [copiedCommand, copyCommand] = useCopyToClipboard()
  const [copiedKey, copyKey] = useCopyToClipboard()

  const downloadPrivateKey = () => {
    const blob = new Blob([sshAccess.privateKeyPem], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `boxlite_${sshAccess.boxId}_ed25519`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <Alert variant="warning">
        <InfoIcon />
        <AlertDescription>
          Save the private key now — it cannot be recovered after you close this dialog.
        </AlertDescription>
      </Alert>
      <Field>
        <FieldLabel htmlFor="ssh-command">SSH Command</FieldLabel>
        <InputGroup className="pr-1">
          <InputGroupInput id="ssh-command" value={sshAccess.sshCommand} readOnly />
          <InputGroupButton variant="ghost" size="icon-xs" onClick={() => copyCommand(sshAccess.sshCommand)}>
            <AnimatePresence initial={false} mode="wait">
              {copiedCommand ? (
                <MotionCheckIcon className="size-4" key="copied" {...iconProps} />
              ) : (
                <MotionCopyIcon className="size-4" key="copy" {...iconProps} />
              )}
            </AnimatePresence>
          </InputGroupButton>
        </InputGroup>
      </Field>
      <Field>
        <FieldLabel htmlFor="ssh-private-key">Private Key</FieldLabel>
        <InputGroup className="pr-1">
          <InputGroupInput id="ssh-private-key" value="•••••• (ed25519 private key)" readOnly />
          <InputGroupButton variant="ghost" size="icon-xs" onClick={() => copyKey(sshAccess.privateKeyPem)}>
            <AnimatePresence initial={false} mode="wait">
              {copiedKey ? (
                <MotionCheckIcon className="size-4" key="copied" {...iconProps} />
              ) : (
                <MotionCopyIcon className="size-4" key="copy" {...iconProps} />
              )}
            </AnimatePresence>
          </InputGroupButton>
          <InputGroupButton variant="ghost" size="icon-xs" onClick={downloadPrivateKey}>
            <DownloadIcon className="size-4" />
          </InputGroupButton>
        </InputGroup>
      </Field>
    </div>
  )
}
