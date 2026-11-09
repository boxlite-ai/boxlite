/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Box, BoxState, NetworkMode, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { createPortal } from 'react-dom'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { copyToClipboard } from '@/lib/copy-text'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useApi } from '@/hooks/useApi'
import { useUpdateBoxInboundMutation } from '@/hooks/mutations/useUpdateBoxInboundMutation'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getRestApiUrl } from '@/lib/environment'
import { readSshPreferences, rememberSshPreferences, sshFailureReason } from '@/lib/ssh-connection-ui'
import {
  generateSshCredentials,
  requestSsh,
  sshConnectionInstructions,
  type SshCredentials,
  type SshStatus,
} from '@/lib/ssh'

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
      preferenceKey={authenticatedUserOrganizationMember?.userId ? `boxlite:ssh:${scope}` : undefined}
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
  preferenceKey,
}: {
  box: Box
  organizationId: string
  refreshSignal: number
  statusContainer?: HTMLDivElement | null
  preferenceKey?: string
}) {
  const api = useApi()
  const updateInbound = useUpdateBoxInboundMutation()
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
  const [credentials, setCredentials] = useState<SshCredentials>()
  const credentialsRef = useRef<SshCredentials | undefined>(undefined)
  const [replacementCredentials, setReplacementCredentials] = useState<SshCredentials>()
  const replacementRef = useRef<SshCredentials | undefined>(undefined)
  const [remembered] = useState(() => readSshPreferences(preferenceKey))
  const [identityNotice, setIdentityNotice] = useState<'path' | 'authorization' | undefined>(
    remembered.keyPath ? 'authorization' : undefined,
  )
  const [cliExpanded, setCliExpanded] = useState(true)
  const [keyPath, setKeyPath] = useState(remembered.keyPath ?? '')
  const [accessConfirmed, setAccessConfirmed] = useState(false)
  const [confirmSetup, setConfirmSetup] = useState<'reset'>()
  const pathHost = useRef(remembered.hostPublicKey ?? '')
  const observedGeneration = useRef<number | undefined>(undefined)
  const authorizationChanged = useRef(false)
  const [statusRefresh, setStatusRefresh] = useState(0)
  const keyPathId = useId()
  const busy = useRef(false)
  const requestVersion = useRef(0)
  const running = box.state === BoxState.STARTED
  const canManage = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  let instructions: ReturnType<typeof sshConnectionInstructions> | undefined
  try {
    instructions = sshConnectionInstructions(
      getRestApiUrl(config.apiUrl, undefined, config.oidc?.issuer),
      organizationId,
      box.id,
    )
  } catch {
    /* Invalid connection metadata must never become a shell command. */
  }

  const cacheCredentials = useCallback((next: SshCredentials | undefined) => {
    credentialsRef.current = next
    setCredentials(next)
  }, [])

  const cacheReplacement = useCallback((next: SshCredentials | undefined) => {
    replacementRef.current = next
    setReplacementCredentials(next)
  }, [])

  const observeStatus = useCallback(
    (next: SshStatus, source: 'read' | 'mutation' | 'setup' = 'read') => {
      if (
        source === 'read' &&
        observedGeneration.current !== undefined &&
        observedGeneration.current !== next.generation
      ) {
        authorizationChanged.current = true
      }
      if (next.enabled && next.host_public_key) {
        if (replacementRef.current?.hostPublicKey === next.host_public_key) {
          cacheCredentials(replacementRef.current)
          cacheReplacement(undefined)
          setKeyPath('')
          pathHost.current = next.host_public_key
          rememberSshPreferences(preferenceKey, { keyPath: '', hostPublicKey: next.host_public_key })
          setIdentityNotice(undefined)
          // A matching host selects the key; only acknowledged Setup confirms its authorization.
          authorizationChanged.current = source !== 'setup'
        }
        const obsoleteCredentials =
          credentialsRef.current && credentialsRef.current.hostPublicKey !== next.host_public_key
        if (obsoleteCredentials || (pathHost.current && next.host_public_key !== pathHost.current)) {
          setKeyPath('')
          rememberSshPreferences(preferenceKey, { keyPath: '', hostPublicKey: next.host_public_key })
          setIdentityNotice('path')
        } else if (pathHost.current === next.host_public_key && authorizationChanged.current) {
          setIdentityNotice('authorization')
        }
        // Clear synchronously: an async continuation must not reuse a superseded key.
        if (obsoleteCredentials) cacheCredentials(undefined)
        pathHost.current = next.host_public_key
        authorizationChanged.current = false
      }
      observedGeneration.current = next.generation
      setStatus(next)
      setStatusError('')
    },
    [cacheCredentials, cacheReplacement, preferenceKey],
  )

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
          if (version === requestVersion.current) {
            observeStatus(next)
          }
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

  async function run(operation: 'reset' | 'enable' | 'disable' | 'access') {
    if (busy.current || loading || !running || !canManage) return
    busy.current = true
    const version = ++requestVersion.current
    setPending(operation)
    setError('')
    let setupAttempted = false
    try {
      if (operation === 'access') {
        let next = await requestSsh(api, organizationId, box.id, 'status')
        if (version !== requestVersion.current) return
        observeStatus(next)
        if (box.network?.inbound.mode === NetworkMode.DISABLED) {
          await updateInbound.mutateAsync({ boxId: box.id, mode: NetworkMode.ENABLED })
          if (version !== requestVersion.current) return
        }
        if (!next.enabled) {
          try {
            next = await requestSsh(api, organizationId, box.id, 'enable')
          } catch (error) {
            if (version !== requestVersion.current) return
            if (sshFailureReason(error) !== 'missing-config') throw error
            const keys = replacementRef.current ?? credentialsRef.current ?? (await generateSshCredentials())
            if (version !== requestVersion.current) return
            if (!replacementRef.current) {
              cacheCredentials(keys)
              pathHost.current = keys.hostPublicKey
              setKeyPath('')
              setIdentityNotice(undefined)
              rememberSshPreferences(preferenceKey, { keyPath: '', hostPublicKey: '' })
            }
            setupAttempted = true
            next = await requestSsh(api, organizationId, box.id, 'setup', keys.config)
          }
        }
        if (version !== requestVersion.current) return
        observeStatus(next, setupAttempted ? 'setup' : 'mutation')
        setAccessConfirmed(true)
        return
      }
      if (operation === 'reset') {
        const keys = replacementRef.current ?? (await generateSshCredentials())
        if (version !== requestVersion.current) return
        setConfirmSetup(undefined)
        if (box.network?.inbound.mode === NetworkMode.DISABLED) {
          try {
            await updateInbound.mutateAsync({ boxId: box.id, mode: NetworkMode.ENABLED })
          } catch {
            if (version === requestVersion.current) {
              setError('Unable to enable inbound access. SSH configuration and your saved key are unchanged.')
            }
            return
          }
          if (version !== requestVersion.current) return
        }
        // A failed POST may have committed. Keep both keys until the host identifies the replacement.
        cacheReplacement(keys)
        setupAttempted = true
        const next = await requestSsh(api, organizationId, box.id, 'setup', keys.config)
        if (version !== requestVersion.current) return
        observeStatus(next, 'setup')
        setAccessConfirmed(true)
        return
      }
      const next = await requestSsh(api, organizationId, box.id, operation)
      if (version !== requestVersion.current) return
      observeStatus(next, 'mutation')
    } catch (error) {
      if (version === requestVersion.current) {
        if (operation === 'enable') {
          if (!open) setCliExpanded(true)
          setAccessConfirmed(false)
          setOpen(true)
        }
        if (operation === 'reset') setConfirmSetup(undefined)
        const reason = sshFailureReason(error)
        if (setupAttempted) setAccessConfirmed(false)
        setError(
          reason === 'authentication'
            ? 'Your session has expired. Sign in to the dashboard again.'
            : reason === 'permission'
              ? 'You do not have permission to change this box’s SSH or network settings.'
              : operation === 'reset' || setupAttempted
                ? 'SSH setup failed. Retry to check the current configuration.'
                : operation === 'access'
                  ? 'Unable to prepare SSH access. Refresh status and retry. Any completed changes remain in place.'
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

  function download(keys = credentials, replacement = false) {
    if (!keys || !instructions) return
    const url = URL.createObjectURL(new Blob([keys.privateKey], { type: 'application/octet-stream' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${instructions.filename}${replacement ? '-replacement' : ''}`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const disabled = !running || !canManage || loading || !!pending
  let connect = ''
  let pathError = ''
  if (keyPath) {
    try {
      connect = sshConnectionInstructions(
        getRestApiUrl(config.apiUrl, undefined, config.oidc?.issuer),
        organizationId,
        box.id,
        keyPath,
      ).connect
    } catch {
      pathError = 'Use a file path without control characters or ${…} variables.'
    }
  }
  const hostMatchesKey = !credentials || credentials.hostPublicKey === status?.host_public_key
  useEffect(() => {
    if (!status?.enabled || pathError || !hostMatchesKey) return
    // Never associate an old path with a newly observed host identity.
    if (pathHost.current && pathHost.current !== status.host_public_key) return
    pathHost.current = status.host_public_key
    rememberSshPreferences(preferenceKey, { keyPath, hostPublicKey: status.host_public_key })
  }, [keyPath, pathError, status, hostMatchesKey, preferenceKey])

  const needsInbound = box.network?.inbound.mode === NetworkMode.DISABLED
  const statusRow = (
    <div className="mb-[6px]">
      <div className="flex items-baseline gap-2">
        <span className="text-muted-foreground">ssh</span>
        <span className="-translate-y-1 min-w-[8px] flex-1 border-b border-dotted border-border" />
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
            className="ml-1 scale-90 self-center"
            onCheckedChange={(enabled) => void run(enabled ? 'enable' : 'disable')}
          />
        )}
      </div>
      {error && !open && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
  return (
    <>
      {statusContainer ? createPortal(statusRow, statusContainer) : statusContainer === undefined ? statusRow : null}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy.current) {
            setOpen(value)
            if (value) {
              setCliExpanded(true)
              setAccessConfirmed(false)
              setConfirmSetup(undefined)
            }
          }
        }}
      >
        <DialogTrigger asChild>
          <Button variant="outline" className="min-h-10" disabled={!instructions}>
            Connect via SSH
          </Button>
        </DialogTrigger>
        <DialogContent className="w-[calc(100%_-_2rem)] gap-5 overflow-hidden p-0 pt-6 text-sm leading-6 sm:max-w-2xl">
          <DialogHeader className="shrink-0 px-6 pr-12">
            <DialogTitle>{confirmSetup ? 'Reset SSH configuration?' : 'Connect via SSH'}</DialogTitle>
            <DialogDescription className="sr-only">Connect from your local terminal.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto overscroll-contain px-6 pb-6 [scrollbar-width:thin] [scrollbar-color:hsl(var(--muted-foreground)/0.25)_transparent]">
            {!running && (
              <p className="mb-4" role="status">
                Start the box to connect via SSH.
              </p>
            )}
            {!canManage && <p className="mb-4">You need permission to write boxes to connect via SSH.</p>}
            <p role="status" className="sr-only">
              {loading
                ? 'Loading SSH status…'
                : status
                  ? `SSH ${status.enabled ? 'enabled' : 'disabled'}`
                  : 'SSH status unavailable'}
            </p>
            {error && (
              <div className="mb-5 space-y-2">
                <p role="alert" className="text-destructive">
                  {error}
                </p>
                <Button
                  variant="outline"
                  disabled={!!pending || loading}
                  onClick={() => setStatusRefresh((n) => n + 1)}
                >
                  Refresh status
                </Button>
              </div>
            )}
            {replacementCredentials && (
              <div className="mb-5 space-y-2">
                <p className="text-muted-foreground">
                  Keep the replacement key until the SSH configuration is confirmed.
                </p>
                <Button variant="outline" onClick={() => download(replacementCredentials, true)}>
                  Download replacement key
                </Button>
              </div>
            )}
            {confirmSetup ? (
              <div className="space-y-5">
                <p>
                  This replaces SSH accounts and host identity and disconnects existing clients.
                  {needsInbound && ' Inbound access will also be enabled.'}
                </p>
                <div className="flex flex-wrap justify-end gap-3">
                  <Button variant="outline" disabled={!!pending} onClick={() => setConfirmSetup(undefined)}>
                    Cancel
                  </Button>
                  <Button disabled={disabled || !status} onClick={() => void run('reset')}>
                    {pending === 'reset' ? 'Resetting…' : 'Reset SSH configuration'}
                  </Button>
                </div>
              </div>
            ) : !accessConfirmed || !canManage ? (
              <div className="space-y-5">
                <p>Enable SSH and inbound access for this box.</p>
                <p className="text-muted-foreground">
                  If SSH needs setup, a private key will be created. Setup replaces SSH accounts and host identity and
                  disconnects existing clients.
                </p>
                {credentials && (
                  <Button variant="outline" onClick={() => download()}>
                    Download private key
                  </Button>
                )}
                <div className="flex flex-wrap justify-end gap-3">
                  {mutationError && canManage && (
                    <Button variant="link" disabled={disabled || !status} onClick={() => setConfirmSetup('reset')}>
                      Reset SSH configuration…
                    </Button>
                  )}
                  <Button variant="outline" disabled={!!pending} onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button disabled={disabled || !status} onClick={() => void run('access')}>
                    {pending ? 'Preparing…' : status?.enabled && !needsInbound ? 'Continue' : 'Enable and continue'}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {(!status?.enabled || needsInbound) && (
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      {loading ? 'Checking access…' : 'SSH or inbound access is unavailable.'}
                    </span>
                    <Button variant="outline" disabled={!!pending || loading} onClick={() => setAccessConfirmed(false)}>
                      Review access
                    </Button>
                  </div>
                )}
                <ol>
                  <SshStep
                    number={1}
                    title="Set up CLI"
                    action={
                      <Button variant="link" onClick={() => setCliExpanded(!cliExpanded)}>
                        {cliExpanded ? 'Hide commands' : 'Show commands'}
                      </Button>
                    }
                  >
                    {cliExpanded && (
                      <>
                        <SshCommand
                          command={`curl -fsSL https://sh.boxlite.ai | sh\nexport PATH="$HOME/.local/bin:$PATH"\n${instructions?.login ?? ''}`}
                        />
                        <a
                          href="/dashboard/keys"
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-block text-muted-foreground underline"
                        >
                          Get an API key ↗
                        </a>
                      </>
                    )}
                  </SshStep>
                  <SshStep
                    number={2}
                    title={<label htmlFor={keyPathId}>Private key path</label>}
                    action={
                      credentials ? (
                        <Button variant="outline" onClick={() => download()}>
                          Download private key
                        </Button>
                      ) : undefined
                    }
                  >
                    <div className="space-y-3">
                      <p id={`${keyPathId}-hint`} className="text-muted-foreground">
                        {credentials && 'Download and save your private key before leaving this page. '}
                        Find the private key file on your computer, copy its full path, and paste it below.
                      </p>
                      {identityNotice && (
                        <p id={`${keyPathId}-notice`} role="status" className="text-muted-foreground">
                          {identityNotice === 'authorization'
                            ? 'Make sure this key is still authorized for this box.'
                            : 'SSH configuration changed. Enter the private key path for the current configuration.'}
                        </p>
                      )}
                      <Input
                        id={keyPathId}
                        aria-describedby={[
                          `${keyPathId}-hint`,
                          identityNotice && `${keyPathId}-notice`,
                          pathError && `${keyPathId}-error`,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        value={keyPath}
                        onChange={(event) => {
                          setKeyPath(event.target.value)
                          setIdentityNotice((notice) => (notice === 'path' ? undefined : notice))
                        }}
                        placeholder="~/Downloads/boxlite-key"
                        aria-invalid={!!pathError}
                        disabled={!!pending}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      {pathError && (
                        <p id={`${keyPathId}-error`} role="alert" className="text-destructive">
                          {pathError}
                        </p>
                      )}
                    </div>
                  </SshStep>
                  {connect && status?.enabled && running && canManage && hostMatchesKey && !needsInbound && (
                    <SshStep number={3} title="Connect">
                      <SshCommand key={connect} command={connect} />
                      {keyPath.startsWith('./') && (
                        <p className="mt-2 text-muted-foreground">Run from the folder containing your key.</p>
                      )}
                      {status.host_key_fingerprint && (
                        <details className="mt-3 text-xs text-muted-foreground">
                          <summary className="cursor-pointer">Host fingerprint</summary>
                          <p className="mt-2 break-all">{status.host_key_fingerprint}</p>
                        </details>
                      )}
                    </SshStep>
                  )}
                </ol>
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-muted-foreground">
                  <a href="https://docs.boxlite.ai/cloud/ssh" target="_blank" rel="noreferrer">
                    SSH guide ↗
                  </a>
                  {(status?.enabled || credentials) && (
                    <Button
                      variant="link"
                      className="h-auto p-0 text-muted-foreground"
                      disabled={disabled}
                      onClick={() => setConfirmSetup('reset')}
                    >
                      Reset SSH configuration…
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function SshStep({
  number,
  title,
  action,
  children,
}: {
  number: number
  title: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <li className="relative ml-4 border-l border-border pb-6 pl-7 last:border-0 last:pb-0">
      <span className="absolute -left-4 -top-1 flex size-8 items-center justify-center rounded-full bg-muted">
        {number}
      </span>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-base font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </li>
  )
}

function SshCommand({ command }: { command: string }) {
  const [result, setResult] = useState<'copied' | 'failed'>()
  useEffect(() => setResult(undefined), [command])
  return (
    <div className="border border-border bg-[hsl(var(--code-background))]">
      <div className="flex items-center justify-between border-b px-3 py-2 text-muted-foreground">
        <span>Local terminal</span>
        <button type="button" onClick={async () => setResult((await copyToClipboard(command)) ? 'copied' : 'failed')}>
          {result === 'copied' ? 'Copied' : result === 'failed' ? 'Copy failed — retry' : 'Copy'}
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-all p-3 text-xs leading-6">{command}</pre>
    </div>
  )
}
