/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */

import { useEffect, useRef, useState } from 'react'
import { Box, BoxState, NetworkMode, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useApi } from '@/hooks/useApi'
import { useUpdateBoxInboundMutation } from '@/hooks/mutations/useUpdateBoxInboundMutation'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getRestApiUrl } from '@/lib/environment'
import {
  generateSshCredentials,
  requestSsh,
  sshConnectionInstructions,
  type SshCredentials,
  type SshStatus,
} from '@/lib/ssh'

export function BoxSshTab({ box, refreshSignal = 0 }: { box: Box; refreshSignal?: number }) {
  const { selectedOrganization } = useSelectedOrganization()
  return selectedOrganization ? (
    <SshControls
      key={`${selectedOrganization.id}:${box.id}`}
      box={box}
      organizationId={selectedOrganization.id}
      refreshSignal={refreshSignal}
    />
  ) : null
}

function SshControls({
  box,
  organizationId,
  refreshSignal,
}: {
  box: Box
  organizationId: string
  refreshSignal: number
}) {
  const api = useApi()
  const updateInbound = useUpdateBoxInboundMutation()
  const config = useConfig()
  const { authenticatedUserHasPermission } = useSelectedOrganization()
  const [status, setStatus] = useState<SshStatus>()
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [credentials, setCredentials] = useState<SshCredentials>()
  const [configured, setConfigured] = useState(false)
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

  useEffect(() => {
    const version = ++requestVersion.current
    setStatus(undefined)
    setError('')
    if (!running && box.state !== BoxState.STOPPED) {
      setLoading(false)
      return
    }
    setLoading(true)
    requestSsh(api, organizationId, box.id, 'status')
      .then(
        (next) => {
          if (version === requestVersion.current) setStatus(next)
        },
        () => {
          if (version === requestVersion.current) setError('Unable to read SSH status. Refresh to retry.')
        },
      )
      .finally(() => {
        if (version === requestVersion.current) setLoading(false)
      })
    return () => {
      requestVersion.current++
    }
  }, [api, organizationId, box.id, box.state, running, refreshSignal])

  async function run(operation: 'setup' | 'enable' | 'disable') {
    if (busy.current || !running || !canManage) return
    busy.current = true
    const version = ++requestVersion.current
    setPending(operation)
    setError('')
    try {
      let keys = credentials
      if (operation === 'setup' && !keys) {
        keys = await generateSshCredentials()
        if (version !== requestVersion.current) return
        setCredentials(keys)
      }
      if (operation === 'setup' && box.network?.inbound.mode === NetworkMode.DISABLED) {
        try {
          await updateInbound.mutateAsync({ boxId: box.id, mode: NetworkMode.ENABLED })
        } catch {
          if (version === requestVersion.current)
            setError('Unable to enable inbound access. SSH setup stopped; your key is kept here. Retry Setup.')
          return
        }
        if (version !== requestVersion.current) return
      }
      const next = await requestSsh(api, organizationId, box.id, operation, keys?.config)
      if (version !== requestVersion.current) return
      setStatus(next)
      if (operation === 'setup') setConfigured(true)
    } catch {
      if (version === requestVersion.current)
        setError(
          operation === 'setup'
            ? 'SSH setup failed. Use a browser with Ed25519 support and retry. Any generated key is kept here for download and retry.'
            : `Unable to ${operation} SSH. Enable requires a saved configuration; start the box and use Setup if needed.`,
        )
    } finally {
      busy.current = false
      setPending('')
    }
  }

  function download() {
    if (!credentials || !instructions) return
    const url = URL.createObjectURL(new Blob([credentials.privateKey], { type: 'application/octet-stream' }))
    const link = document.createElement('a')
    link.href = url
    link.download = instructions.filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const disabled = !running || !canManage || loading || !!pending
  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      <div>
        <h2 className="text-base font-medium">SSH access</h2>
        <p className="mt-2 text-muted-foreground">Connect from your terminal using a private key.</p>
        <p className="mt-3" role="status">
          {loading
            ? 'Loading SSH status…'
            : !running
              ? 'Box is not running'
              : status
                ? `SSH ${status.enabled ? 'enabled' : 'disabled'}`
                : 'SSH status unavailable'}
        </p>
      </div>
      {!running && <p>Start the box before changing SSH.</p>}
      {!canManage && <p>You need permission to write boxes to manage SSH.</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || !instructions} onClick={() => setOpen(true)}>
          Setup
        </Button>
        <Button variant="outline" disabled={disabled} onClick={() => void run('enable')}>
          {pending === 'enable' ? 'Enabling…' : 'Enable'}
        </Button>
        <Button variant="outline" disabled={disabled} onClick={() => void run('disable')}>
          {pending === 'disable' ? 'Disabling…' : 'Disable'}
        </Button>
      </div>
      <p className="text-muted-foreground">
        Setup replaces the SSH configuration and disconnects existing clients. Enable and Disable keep saved keys.
      </p>
      {status?.host_key_fingerprint && <p className="break-all">Host fingerprint: {status.host_key_fingerprint}</p>}
      {!instructions && <p role="alert">Connection details are unavailable for this box.</p>}
      {error && !open && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy.current) setOpen(value)
        }}
      >
        {/* Normal flow keeps command blocks from shrinking inside the height-limited dialog. */}
        <DialogContent className="block overflow-y-auto text-sm leading-6 sm:max-w-2xl">
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>{configured ? 'SSH connection details' : 'Set up SSH'}</DialogTitle>
              <DialogDescription>
                Login as box on guest address 0.0.0.0:22. Save your private key before leaving this page; it cannot be
                recovered here after a reload.
              </DialogDescription>
            </DialogHeader>
            {!configured && (
              <>
                <p>
                  This replaces existing accounts and host identity, disconnecting SSH clients. A fresh setup after
                  leaving this page generates new keys. Setup also enables inbound access if it is disabled.
                </p>
                <Button disabled={disabled} onClick={() => void run('setup')}>
                  {pending === 'setup' ? 'Setting up…' : 'Set up SSH'}
                </Button>
              </>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            {credentials && <Button onClick={download}>Download private key</Button>}
            {configured && instructions && (
              <>
                <p className="break-all">
                  Host fingerprint: {status?.host_key_fingerprint || 'Enable SSH to read the host fingerprint.'}
                </p>
                <p>
                  1. Use a BoxLite CLI version with cloud SSH proxy support. Run <code>boxlite context ls</code> and
                  confirm your current CLI context points to <code>{instructions.endpoint}</code> with access to this
                  organization. Switch with <code>boxlite context use</code> if needed.
                </p>
                <p>
                  2. Open the folder containing the downloaded key and run. This command uses your current CLI context:
                </p>
                <pre className="whitespace-pre-wrap break-all bg-muted p-3 text-xs leading-6">
                  {instructions.connect}
                </pre>
                <p>
                  SSH starts the BoxLite proxy automatically. Compare the host fingerprint above before accepting it.
                </p>
                <p className="text-muted-foreground">
                  The proxy requires inbound access and opens a public tunnel protected by SSH authentication. Exiting
                  SSH leaves that tunnel open.
                </p>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
