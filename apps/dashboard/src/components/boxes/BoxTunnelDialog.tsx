/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useRef, useState } from 'react'
import { Box, BoxState, NetworkMode } from '@boxlite-ai/api-client'
import type { ApiClient } from '@/api/apiClient'
import { isFullTunnelToken, TunnelRequestError, type TunnelDescriptor } from '@/api/tunnel'
import { CopyButton } from '@/components/CopyButton'
import { Button } from '@/components/ui/button'
import { Dialog, DialogTitle } from '@/components/ui/dialog'
import { FormDialogContent, FormDialogHeader, FormDialogBody, FormDialogFooter } from '@/components/ui/form-dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ExternalLink } from '@/components/ui/icon'

interface Props {
  api: ApiClient
  organizationId: string
  box: Box
  onClose: () => void
  onEnableInbound: (signal: AbortSignal) => Promise<unknown>
  onRefreshInbound: (signal: AbortSignal) => Promise<NetworkMode | undefined>
}
const resumable: BoxState[] = [
  BoxState.STOPPED,
  BoxState.STOPPING,
  BoxState.STARTING,
  BoxState.CREATING,
  BoxState.RESTORING,
]

/** A scoped operation, not an inventory: descriptors and secrets never enter a shared cache. */
export function BoxTunnelDialog({ api, organizationId, box, onClose, onEnableInbound, onRefreshInbound }: Props) {
  const [mode, setMode] = useState<'create' | 'revoke'>('create')
  const [revokePort, setRevokePort] = useState<number | null>(null)
  const [value, setValue] = useState('')
  const [access, setAccess] = useState('private')
  const [result, setResult] = useState<(TunnelDescriptor & { port: number }) | null>(null)
  const [revoked, setRevoked] = useState(false)
  const [error, setError] = useState<TunnelRequestError | null>(null)
  const [pending, setPending] = useState<'create' | 'revoke' | 'inbound' | 'refresh' | null>(null)
  const [inboundRequested, setInboundRequested] = useState(false)
  const operation = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      operation.current?.abort()
    },
    [],
  )

  const port = revokePort ?? Number(value)
  const validPort = /^\d+$/.test(value) && Number.isInteger(port) && port >= 1 && port <= 65535
  const inbound = box.network?.inbound?.mode === NetworkMode.ENABLED
  const canPrepare =
    box.state === BoxState.STARTED || (!!box.autoResume && !!box.state && resumable.includes(box.state))
  const uncertainCreation = mode === 'create' && error?.outcome === 'unknown'
  const editable = !pending && !uncertainCreation
  // A submitted operation's recovery must survive later policy/lifecycle changes.
  const prerequisite = mode === 'create' && !result && !revoked && !uncertainCreation && (!canPrepare || !inbound)
  const inboundDisabled = box.network?.inbound?.mode === NetworkMode.DISABLED
  const inboundKnown = inbound || inboundDisabled
  const canEnableInbound = canPrepare && inboundDisabled

  function refreshInbound() {
    void run('refresh', onRefreshInbound, (mode) => {
      setInboundRequested(mode !== NetworkMode.DISABLED)
      if (mode !== NetworkMode.ENABLED)
        setError(
          new TunnelRequestError(
            mode === NetworkMode.DISABLED
              ? 'Inbound is still disabled. Enable it to continue.'
              : 'Could not confirm inbound access. Refresh its status to try again.',
          ),
        )
    })
  }

  async function run<T>(
    kind: NonNullable<typeof pending>,
    request: (signal: AbortSignal) => Promise<T>,
    done: (data: T) => void,
  ) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setPending(kind)
    if (kind === 'inbound') setInboundRequested(true)
    setError(null)
    try {
      const data = await request(controller.signal)
      if (!controller.signal.aborted) done(data)
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof TunnelRequestError
            ? failure
            : new TunnelRequestError(
                kind === 'refresh'
                  ? 'Could not refresh inbound access. Try again.'
                  : kind === 'inbound'
                    ? 'Could not confirm inbound access. Refresh its status before continuing.'
                    : 'Could not confirm the operation. Revoke this port to remove access.',
                kind === 'inbound' || kind === 'refresh' ? 'refused' : 'unknown',
              ),
        )
    } finally {
      if (!controller.signal.aborted) {
        operation.current = null
        setPending(null)
      }
    }
  }

  function beginRevoke() {
    if (operation.current) return
    // Recovery always targets the configured/submitted port; historical revocation remains editable.
    const target = result?.port ?? (uncertainCreation ? port : null)
    setRevokePort(target)
    if (target !== null) setValue(String(target))
    setResult(null)
    setError(null)
    setMode('revoke')
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!validPort || operation.current || uncertainCreation || result || revoked) return
    if (mode === 'revoke') {
      void run(
        'revoke',
        (signal) => api.revokeBoxTunnel(organizationId, box.id, port, signal),
        () => {
          setResult(null)
          setRevoked(true)
        },
      )
    } else if (inbound && canPrepare) {
      void run(
        'create',
        (signal) => api.prepareBoxTunnel(organizationId, box.id, port, access === 'public', signal),
        (descriptor) => setResult({ ...descriptor, port }),
      )
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !operation.current) onClose()
      }}
    >
      <FormDialogContent
        className={prerequisite ? 'sm:max-w-[440px]' : 'sm:max-w-[520px]'}
        showCloseButton={!pending}
        aria-describedby={undefined}
      >
        <FormDialogHeader className={prerequisite ? 'border-b-0 pb-3' : undefined}>
          <DialogTitle>
            {revoked
              ? 'Tunnel revoked'
              : result
                ? 'Tunnel configured'
                : mode === 'revoke'
                  ? 'Revoke tunnel'
                  : prerequisite && canEnableInbound
                    ? 'Enable inbound access?'
                    : 'Create tunnel'}
          </DialogTitle>
        </FormDialogHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <FormDialogBody className={prerequisite ? '!bg-none !pt-0 !pb-2' : undefined}>
            {revoked ? (
              <p className="text-body text-muted-foreground">
                New requests to port <span className="font-mono text-foreground">{value}</span> will be blocked within a
                few seconds. Existing connections may continue.
              </p>
            ) : prerequisite ? (
              <div className="space-y-3 text-body text-muted-foreground">
                {!canPrepare ? (
                  <p>
                    {box.state === BoxState.STOPPED
                      ? 'Start this Box before creating a tunnel.'
                      : 'This Box cannot create a tunnel in its current state.'}
                  </p>
                ) : !inboundKnown ? (
                  <p>Could not confirm inbound access. Refresh its status to continue.</p>
                ) : inboundRequested ? (
                  <p role="status">
                    Waiting for the latest inbound status. Tunnel settings will appear once access is enabled.
                  </p>
                ) : (
                  <p>Required to create a tunnel. Existing tunnels also resume with their current access rules.</p>
                )}
              </div>
            ) : result ? (
              <>
                <div className="flex items-center justify-between text-body">
                  <span className="font-mono">Port {result.port}</span>
                  <span>{result.isPublic ? 'Public' : 'Private'}</span>
                </div>
                <div className="flex min-w-0 items-center gap-2 border border-border bg-card px-3 py-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-meta">{result.uri}</span>
                  <CopyButton type="button" value={result.uri} tooltipText="Copy URL" size="icon-sm" />
                </div>
                <p className="text-meta text-muted-foreground">
                  {result.isPublic
                    ? 'Anyone with the URL can access this port.'
                    : 'Organization sign-in or an access token is required. Browser sign-in must be configured on your server.'}
                </p>
                {!result.isPublic && (
                  <details className="border-t border-border pt-3">
                    <summary className="cursor-pointer text-body font-medium">Access token</summary>
                    <div className="mt-3 space-y-3 text-meta text-muted-foreground">
                      <div className="flex min-w-0 items-center gap-2">
                        <code className="min-w-0 flex-1 break-all text-foreground">{result.token}</code>
                        {isFullTunnelToken(result.token) && (
                          <CopyButton
                            type="button"
                            value={result.token}
                            tooltipText="Copy access token"
                            size="icon-sm"
                          />
                        )}
                      </div>
                      <p>
                        {isFullTunnelToken(result.token)
                          ? 'Shown once. Save it now; the token can be reused.'
                          : 'The full token was shown when this tunnel was first created. It cannot be retrieved again.'}
                      </p>
                      <p>
                        External clients send it in the <code className="text-foreground">X-BoxLite-Access-Token</code>{' '}
                        header. The URL alone does not grant access.
                      </p>
                    </div>
                  </details>
                )}
                {box.state !== BoxState.STARTED && box.autoResume && (
                  <p className="text-meta text-muted-foreground">The Box starts when accessed.</p>
                )}
                <p className="text-meta text-muted-foreground">
                  {inbound
                    ? 'Closing this dialog does not revoke the tunnel.'
                    : 'Inbound is disabled. Tunnel access is paused; the configuration is saved.'}
                </p>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-muted-foreground"
                  onClick={beginRevoke}
                  type="button"
                >
                  Revoke port {result.port}…
                </Button>
              </>
            ) : (
              <>
                <div>
                  <label className="form-field-label" htmlFor="tunnel-port">
                    Port
                  </label>
                  <Input
                    id="tunnel-port"
                    autoFocus
                    inputMode="numeric"
                    placeholder="3000"
                    value={value}
                    disabled={!editable}
                    readOnly={revokePort !== null}
                    onChange={(e) => {
                      setValue(e.target.value)
                      setError(null)
                    }}
                    className="form-field-input font-mono"
                  />
                </div>
                {mode === 'create' ? (
                  <>
                    <div>
                      <label className="form-field-label" htmlFor="tunnel-access">
                        Access
                      </label>
                      <Select
                        value={access}
                        onValueChange={(v) => {
                          setAccess(v)
                          setError(null)
                        }}
                        disabled={!editable}
                      >
                        <SelectTrigger id="tunnel-access" className="form-field-input">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="private">Private</SelectItem>
                          <SelectItem value="public">Public</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="mt-2 text-meta text-muted-foreground">
                        {access === 'private'
                          ? 'Organization members or anyone with the access token.'
                          : 'Anyone with the URL can access this port.'}
                      </p>
                    </div>
                  </>
                ) : (
                  <p className="text-body text-muted-foreground">
                    Block new requests to this port. Existing connections may continue. Other ports are unaffected.
                  </p>
                )}
              </>
            )}
            {error && (
              <div role="alert" className="space-y-3 text-meta text-destructive-foreground">
                <p>{error.message}</p>
                {uncertainCreation && (
                  <Button type="button" variant="outline" size="sm" onClick={beginRevoke}>
                    Revoke this port
                  </Button>
                )}
              </div>
            )}
          </FormDialogBody>
          {mode === 'create' && !result && !revoked && !uncertainCreation && (
            <div className="px-6 pb-3">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-muted-foreground"
                disabled={!!pending}
                onClick={beginRevoke}
              >
                Revoke by port…
              </Button>
            </div>
          )}
          <FormDialogFooter className={prerequisite ? 'border-t-0 pt-4 pb-5' : undefined}>
            {revoked ? (
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            ) : result ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setResult(null)
                    setValue('')
                    setAccess('private')
                    setError(null)
                  }}
                >
                  Create another
                </Button>
                {inbound ? (
                  <Button asChild>
                    <a href={result.uri} target="_blank" rel="noreferrer noopener">
                      Open in browser <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                ) : (
                  <Button type="button" disabled>
                    Open in browser
                  </Button>
                )}
              </>
            ) : prerequisite ? (
              <>
                <Button type="button" variant="outline" disabled={!!pending} onClick={onClose}>
                  Cancel
                </Button>
                {canPrepare && (inboundRequested || !inboundKnown) ? (
                  <Button type="button" disabled={!!pending} onClick={refreshInbound}>
                    {pending === 'inbound' ? 'Enabling…' : pending === 'refresh' ? 'Refreshing…' : 'Refresh status'}
                  </Button>
                ) : canEnableInbound ? (
                  <Button
                    type="button"
                    disabled={!!pending}
                    onClick={() => void run('inbound', onEnableInbound, () => {})}
                  >
                    Enable and continue
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <Button type="button" variant="outline" disabled={!!pending} onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={mode === 'revoke' ? 'destructive' : 'default'}
                  disabled={
                    !!pending || !validPort || (mode === 'create' && (!inbound || !canPrepare || !!uncertainCreation))
                  }
                >
                  {pending === 'create'
                    ? 'Creating…'
                    : pending === 'revoke'
                      ? 'Revoking…'
                      : mode === 'revoke'
                        ? 'Revoke tunnel'
                        : 'Create tunnel'}
                </Button>
              </>
            )}
          </FormDialogFooter>
        </form>
      </FormDialogContent>
    </Dialog>
  )
}
