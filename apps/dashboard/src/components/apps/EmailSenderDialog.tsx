/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useEmailSender } from '@/hooks/mutations/useAppMutations'
import type { AppDetail, EmailSender } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useConfirm } from './confirm'
import { DIALOG_FRAME, FlatButton } from './spec'
import { ToolButton } from './SubNav'

// Email code sign-in sends through the App's own SMTP account (any mail provider: SendGrid,
// Mailgun, Postmark, Amazon SES, Gmail with an app password). Set here for every environment of the
// App; a test email checks it before visitors depend on it.

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function EmailSenderDialog({ app, sender, onClose }: { app: AppDetail; sender: EmailSender; onClose: () => void }) {
  const { save, remove, test } = useEmailSender()
  const [confirm, confirmElement] = useConfirm()
  const [host, setHost] = useState(sender.host ?? '')
  const [port, setPort] = useState(String(sender.port ?? 587))
  const [username, setUsername] = useState(sender.username ?? '')
  const [password, setPassword] = useState('')
  const [replacing, setReplacing] = useState(!sender.passwordSet)
  const [from, setFrom] = useState(sender.from ?? '')
  const [to, setTo] = useState('')

  const changed =
    host.trim() !== (sender.host ?? '') ||
    Number(port) !== (sender.port ?? 587) ||
    username.trim() !== (sender.username ?? '') ||
    from.trim() !== (sender.from ?? '') ||
    !!password
  const missing = !host.trim() || !from.trim() || !Number.isInteger(Number(port))
  const blocked = !changed || missing || save.isPending

  const submit = async () => {
    if (blocked) return
    try {
      await save.mutateAsync({
        appId: app.id,
        body: { host: host.trim(), port: Number(port), username: username.trim() || null, from: from.trim(), ...(password ? { password } : {}) },
      })
      setPassword('')
      setReplacing(false)
      toast.success('Email sender saved', { description: 'Send a test email to check it.' })
    } catch (error) {
      handleApiError(error, 'Could not save the email sender')
    }
  }

  const sendTest = async () => {
    try {
      const r = await test.mutateAsync({ appId: app.id, to: to.trim() })
      toast.success(`Test email sent to ${r.to}`, { description: 'Check that it arrived, and not in spam.' })
    } catch (error) {
      handleApiError(error, 'The test email was not sent')
    }
  }

  const removeSender = async () => {
    const ok = await confirm({
      title: 'Remove the email sender?',
      body: <>Visitors can no longer get sign-in codes by email. People already signed in stay signed in.</>,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    try {
      await remove.mutateAsync({ appId: app.id })
      toast.success('Email sender removed')
      onClose()
    } catch (error) {
      handleApiError(error, 'Could not remove the email sender')
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[540px] font-mono text-body')} data-testid="email-sender-dialog">
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">Email code sign-in</DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground">
          Visitors type their email address and get a 6-digit code. It is sent from your own mail account: copy the
          SMTP settings from your mail provider.
        </p>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
            <Field label="SMTP server">
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.sendgrid.net" className="font-mono" />
            </Field>
            <Field label="Port">
              <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className="font-mono" />
            </Field>
          </div>
          <Field label="Username">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="apikey" className="font-mono" autoComplete="off" />
          </Field>
          {replacing ? (
            <Field label="Password" hint="Saved for this app only. It cannot be viewed after saving.">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="font-mono"
                autoComplete="new-password"
                autoFocus={sender.passwordSet}
              />
            </Field>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-muted-foreground">Password</span>
              <span className="flex items-center gap-3">
                <span className="text-foreground">Password saved</span>
                <ToolButton onClick={() => setReplacing(true)}>Replace</ToolButton>
              </span>
            </div>
          )}
          <Field label="From" hint="An address your mail account may send as.">
            <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Your App <no-reply@yourdomain.com>" className="font-mono" />
          </Field>
          {sender.configured && (
            <div className="flex items-end gap-2 border-t border-border/60 pt-4">
              <Field label="Send a test email to">
                <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" className="w-[300px] font-mono" />
              </Field>
              <ToolButton loading={test.isPending} disabled={!to.trim() || changed} onClick={() => void sendTest()}>
                Send test
              </ToolButton>
            </div>
          )}
        </div>
        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span>
            {sender.configured && (
              <ToolButton danger loading={remove.isPending} onClick={() => void removeSender()}>
                Remove
              </ToolButton>
            )}
          </span>
          <span className="flex items-center gap-2">
            <span className="text-[12px] text-muted-foreground">
              {missing ? 'Enter the server and the from address.' : changed && sender.configured ? 'Save, then send a test.' : ''}
            </span>
            <FlatButton onClick={onClose}>Close</FlatButton>
            <FlatButton variant="primary" disabled={blocked} onClick={() => void submit()}>
              Save
            </FlatButton>
          </span>
        </DialogFooter>
        {confirmElement}
      </DialogContent>
    </Dialog>
  )
}
