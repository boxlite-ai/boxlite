/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, BoxState, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { createPortal } from 'react-dom'
import { Switch } from '@/components/ui/switch'
import { AsciiButton } from '@/components/ascii'
import { copyToClipboard } from '@/lib/copy-text'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getRestApiUrl } from '@/lib/environment'
import { sshFailureReason } from '@/lib/ssh-connection-ui'
import { requestSsh, sshConnectionInstructions, type SshInstructions, type SshStatus } from '@/lib/ssh'

export function BoxSshTab({
  box,
  refreshSignal = 0,
  statusContainer,
}: {
  box: Box
  refreshSignal?: number
  statusContainer?: HTMLDivElement | null
}) {
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const config = useConfig()
  const scope = JSON.stringify([
    config.apiUrl,
    config.oidc?.issuer,
    authenticatedUserOrganizationMember?.userId,
    selectedOrganization?.id,
    box.id,
  ])
  return selectedOrganization ? (
    <SshControls
      key={scope}
      box={box}
      organizationId={selectedOrganization.id}
      refreshSignal={refreshSignal}
      statusContainer={statusContainer}
    />
  ) : null
}

function SshControls({
  box,
  organizationId,
  refreshSignal,
  statusContainer,
}: {
  box: Box
  organizationId: string
  refreshSignal: number
  statusContainer?: HTMLDivElement | null
}) {
  const api = useApi()
  const config = useConfig()
  const { authenticatedUserHasPermission } = useSelectedOrganization()
  const [status, setStatus] = useState<SshStatus>()
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState('')
  const [mutationError, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const error = mutationError || statusError
  const reading = useRef(false)
  const deferredRefresh = useRef(false)
  const [open, setOpen] = useState(false)
  const [statusRefresh, setStatusRefresh] = useState(0)
  const busy = useRef(false)
  const requestVersion = useRef(0)
  const running = box.state === BoxState.STARTED
  const canManage = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  let instructions: SshInstructions | undefined
  try {
    instructions = sshConnectionInstructions(
      getRestApiUrl(config.apiUrl, undefined, config.oidc?.issuer),
      organizationId,
      box.id,
    )
  } catch {
    /* Invalid connection metadata must never become a shell command. */
  }

  const observeStatus = useCallback((next: SshStatus) => {
    setStatus(next)
    setStatusError('')
  }, [])

  // Ordinary refreshes defer to mutations; only lifecycle changes cancel them.
  useEffect(
    () => () => {
      requestVersion.current++
    },
    [api, organizationId, box.id, box.state, canManage],
  )

  useEffect(() => {
    if (busy.current) {
      deferredRefresh.current = true
      return
    }
    const version = ++requestVersion.current
    reading.current = false
    if (!running && box.state !== BoxState.STOPPED) {
      setStatus(undefined)
      setLoading(false)
      return
    }
    setLoading(true)
    reading.current = true
    requestSsh(api, organizationId, box.id, 'status')
      .then(
        (next) => {
          if (version === requestVersion.current) observeStatus(next)
        },
        () => {
          if (version === requestVersion.current) {
            setStatus(undefined)
            setStatusError('Unable to read SSH status. Refresh to retry.')
          }
        },
      )
      .finally(() => {
        if (version === requestVersion.current) {
          reading.current = false
          setLoading(false)
        }
      })
  }, [api, organizationId, box.id, box.state, running, refreshSignal, statusRefresh, canManage, observeStatus])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible' && !busy.current && !reading.current)
        setStatusRefresh((value) => value + 1)
    }
    const timer = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  async function run(operation: 'enable' | 'disable') {
    if (busy.current || loading || !running || !canManage) return
    busy.current = true
    const version = ++requestVersion.current
    setPending(operation)
    setError('')
    try {
      const next = await requestSsh(api, organizationId, box.id, operation)
      if (version === requestVersion.current) observeStatus(next)
    } catch (error) {
      if (version === requestVersion.current) {
        const reason = sshFailureReason(error)
        if (reason === 'missing-config') setOpen(true)
        setError(
          reason === 'authentication'
            ? 'Your session has expired. Sign in to the dashboard again.'
            : reason === 'permission'
              ? 'You do not have permission to change this box’s SSH settings.'
              : reason === 'missing-config'
                ? 'No saved SSH configuration. Follow the CLI setup guide.'
                : `Unable to ${operation} SSH. Refresh status and retry.`,
        )
      }
    } finally {
      busy.current = false
      setPending('')
      if (deferredRefresh.current) {
        deferredRefresh.current = false
        setStatusRefresh((value) => value + 1)
      }
    }
  }

  const disabled = !running || !canManage || loading || !!pending
  const statusRow = (
    <div>
      <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-3 sm:grid-cols-[100px_minmax(0,1fr)]">
        <span className="text-meta text-muted-foreground">SSH</span>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            title="Refresh SSH status"
            disabled={loading || !!pending}
            onClick={() => setStatusRefresh((value) => value + 1)}
            className="whitespace-nowrap text-muted-foreground hover:text-foreground"
          >
            {pending
              ? 'updating…'
              : loading
                ? 'loading…'
                : !running
                  ? 'not running'
                  : status
                    ? status.enabled
                      ? 'enabled'
                      : 'disabled'
                    : 'unavailable · retry'}
          </button>
          {canManage && (
            <Switch
              aria-label="SSH access"
              checked={status?.enabled ?? false}
              disabled={disabled || !status}
              className="shrink-0"
              onCheckedChange={(enabled) => void run(enabled ? 'enable' : 'disable')}
            />
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-meta text-destructive">
          {error}
        </p>
      )}
    </div>
  )
  return (
    <>
      {statusContainer ? createPortal(statusRow, statusContainer) : statusContainer === undefined ? statusRow : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <AsciiButton disabled={!instructions}>Connect via SSH</AsciiButton>
        </DialogTrigger>
        <DialogContent className="flex max-h-[calc(100svh-2rem)] w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[760px]">
          <DialogHeader className="shrink-0 border-b border-border px-4 py-4 pr-12 sm:px-6 sm:pr-12">
            <DialogTitle className="text-em font-bold tracking-[-0.3px]">Connect via SSH</DialogTitle>
            <DialogDescription className="text-meta leading-5">
              Run these commands in your local terminal.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto px-4 py-4 font-mono text-body leading-5 [scrollbar-width:thin] [scrollbar-color:hsl(var(--muted-foreground)/0.5)_transparent] sm:px-6">
            <p className="text-muted-foreground">
              Start the Box and enable Inbound access in Network. Requires Box-write permission, ssh and ssh-keygen.
            </p>
            <ol className="space-y-4">
              <SshStep
                number="01"
                title="Install or update CLI"
                command={'curl -fsSL https://sh.boxlite.ai | sh\nexport PATH="$HOME/.local/bin:$PATH"'}
              />
              <SshStep number="02" title="Log in" command={instructions?.login ?? ''}>
                <p className="mt-2 text-muted-foreground">
                  Enter an{' '}
                  <a href="/dashboard/keys" target="_blank" rel="noreferrer" className="text-foreground underline">
                    API key ↗
                  </a>{' '}
                  for this organization when prompted.
                </p>
              </SshStep>
              <SshStep number="03" title="Connect" command={instructions?.connect ?? ''}>
                <p className="mt-2 text-muted-foreground">
                  The CLI reuses local keys, verifies the host and opens a shell directly.
                </p>
              </SshStep>
            </ol>
            <p className="text-meta leading-5 text-muted-foreground">
              First setup can replace existing SSH access and disconnect clients. Exiting SSH leaves its public tunnel
              open.
            </p>
            <a
              href="https://docs.boxlite.ai/cloud/ssh"
              target="_blank"
              rel="noreferrer"
              className="inline-block text-muted-foreground underline"
            >
              SSH guide ↗
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function SshStep({
  number,
  title,
  command,
  children,
}: {
  number: string
  title: string
  command: string
  children?: React.ReactNode
}) {
  const [result, setResult] = useState<'copied' | 'failed'>()
  const current = useRef(command)
  current.current = command
  useEffect(() => setResult(undefined), [command])
  return (
    <li>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-baseline gap-3 font-medium">
          <span className="text-muted-foreground">{number}</span>
          {title}
        </h3>
        <AsciiButton
          size="sm"
          onClick={async () => {
            const copied = await copyToClipboard(command)
            if (current.current === command) setResult(copied ? 'copied' : 'failed')
          }}
        >
          {result === 'copied' ? 'Copied' : result === 'failed' ? 'Copy failed — retry' : 'Copy'}
        </AsciiButton>
      </div>
      <pre className="whitespace-pre-wrap break-all border border-border bg-[hsl(var(--code-background))] p-3 text-body leading-5">
        {command}
      </pre>
      {children}
    </li>
  )
}
