/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { useConfig } from '@/hooks/useConfig'
import { Button } from '@/components/ui/button'
import { RoutePath } from '@/enums/RoutePath'

type Scope = 'boxes:read' | 'boxes:write' | 'boxes:delete'
type Preview = {
  client_name: string
  client_id: string
  scopes: Scope[]
  organizations: { id: string; name: string; scopes: Scope[] }[]
}
type Grant = {
  id: string
  organization_id: string
  client_name: string
  scopes: Scope[]
  expires_at: string
  revoked_at: string | null
}
const LABELS: Record<Scope, string> = {
  'boxes:read': 'View Boxes',
  'boxes:write': 'Create Boxes, run commands, and stop Boxes',
  'boxes:delete': 'Permanently delete Boxes',
}

function savedChallenge(): { challenge: string; state: string } | null {
  try {
    const value = JSON.parse(sessionStorage.getItem('boxlite-mcp-consent') || 'null')
    if (
      value &&
      typeof value.challenge === 'string' &&
      typeof value.state === 'string' &&
      Date.now() - value.received < 300000
    )
      return { challenge: value.challenge, state: value.state }
  } catch {
    /* Missing browser storage requires restarting authorization. */
  }
  return null
}

export default function McpAccess({ consent = false }: { consent?: boolean }) {
  const { user, isAuthenticated, isLoading, signinRedirect } = useAuth()
  const config = useConfig()
  const [challenge] = useState(savedChallenge)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [grants, setGrants] = useState<Grant[]>([])
  const [organization, setOrganization] = useState('')
  const [scopes, setScopes] = useState<Scope[]>(['boxes:read'])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const framed = window.top !== window.self

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !framed)
      void signinRedirect({ state: { returnTo: consent ? '/mcp/consent' : '/mcp/access' } })
  }, [isLoading, isAuthenticated, framed, consent, signinRedirect])

  useEffect(() => {
    if (!user || framed) return
    const abort = new AbortController()
    async function load() {
      if (consent && !challenge) {
        setError('This authorization request expired. Restart the connection from your AI app.')
        return
      }
      try {
        const response = await fetch(`${config.apiUrl}/mcp-consent/${consent ? 'preview' : 'grants'}`, {
          method: consent ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${user!.access_token}`, 'content-type': 'application/json' },
          body: consent ? JSON.stringify({ challenge: challenge!.challenge }) : undefined,
          signal: abort.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        })
        if (!response.ok)
          throw new Error(
            'Unable to load access. Sign in with the account used to connect your AI app, or restart authorization.',
          )
        const value = await response.json()
        if (consent) setPreview(value)
        else setGrants(value)
      } catch (cause) {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load access.')
      }
    }
    void load()
    return () => abort.abort()
  }, [user, config.apiUrl, consent, challenge, framed])

  async function approve() {
    if (!challenge || !user || framed) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${config.apiUrl}/mcp-consent/approve`, {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { authorization: `Bearer ${user.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...challenge, organization_id: organization, scopes }),
      })
      if (!response.ok)
        throw new Error(
          'Access was not granted. Your permissions may have changed, or this request expired. Restart authorization.',
        )
      const result = await response.json()
      const destination = new URL('/continue', config.oidc.issuer)
      if (result.continue_url !== destination.href || destination.protocol !== 'https:')
        throw new Error('Invalid authorization destination.')
      sessionStorage.removeItem('boxlite-mcp-consent')
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = destination.href
      for (const name of ['state', 'session_token'] as const) {
        const field = document.createElement('input')
        field.type = 'hidden'
        field.name = name
        field.value = result[name]
        form.appendChild(field)
      }
      document.body.appendChild(form)
      form.submit()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authorization failed.')
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${config.apiUrl}/mcp-consent/grants/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'omit',
        headers: { authorization: `Bearer ${user!.access_token}` },
      })
      if (!response.ok) throw new Error('Could not revoke access. Try again.')
      setGrants((current) =>
        current.map((grant) => (grant.id === id ? { ...grant, revoked_at: new Date().toISOString() } : grant)),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not revoke access.')
    } finally {
      setBusy(false)
    }
  }

  const choice = preview?.organizations.find((item) => item.id === organization)
  return (
    <main className="mx-auto max-w-xl space-y-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">{consent ? 'Connect your AI app' : 'MCP app access'}</h1>
      {framed ? (
        <p role="alert">Open this page in its own browser tab to manage access.</p>
      ) : (
        <>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {consent && preview && (
            <>
              <p>
                <strong>{preview.client_name}</strong> is requesting access to BoxLite Cloud.
              </p>
              <p className="text-sm text-muted-foreground">
                Choose one organization and the permissions this app can use. Running commands may incur Cloud usage
                charges.
              </p>
              <label className="block space-y-2">
                Organization
                <select
                  aria-label="Organization"
                  className="block w-full rounded border bg-background p-2"
                  value={organization}
                  onChange={(event) => {
                    setOrganization(event.target.value)
                    setScopes(['boxes:read'])
                  }}
                >
                  <option value="">Choose an organization</option>
                  {preview.organizations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="space-y-3">
                <legend className="mb-2 font-medium">Permissions</legend>
                {preview.scopes.map((scope) => (
                  <label key={scope} className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      disabled={scope === 'boxes:read' || !choice?.scopes.includes(scope)}
                      onChange={(event) =>
                        setScopes((current) =>
                          event.target.checked ? [...current, scope] : current.filter((value) => value !== scope),
                        )
                      }
                    />
                    {LABELS[scope]}
                  </label>
                ))}
              </fieldset>
              <p className="text-sm text-muted-foreground">
                Access expires within one hour. You can revoke it earlier from API Keys → Manage MCP app access.
              </p>
              <div className="flex gap-3">
                <Button disabled={busy || !organization} onClick={() => void approve()}>
                  Allow access
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    sessionStorage.removeItem('boxlite-mcp-consent')
                    window.location.assign('/mcp/access')
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
          {!consent && (
            <>
              <p className="text-sm text-muted-foreground">
                Revoking access prevents this app's next request. Commands already running remain subject to their time
                limits.
              </p>
              {grants.length === 0 && !error && <p>No active app grants.</p>}
              {grants.map((grant) => (
                <div key={grant.id} className="space-y-2 rounded border p-4">
                  <p className="font-medium">{grant.client_name}</p>
                  <p className="text-sm">Organization: {grant.organization_id}</p>
                  <p className="text-sm">{grant.scopes.map((scope) => LABELS[scope]).join('; ')}</p>
                  <p className="text-sm text-muted-foreground">Expires {new Date(grant.expires_at).toLocaleString()}</p>
                  <Button
                    variant="outline"
                    disabled={busy || Boolean(grant.revoked_at)}
                    onClick={() => void revoke(grant.id)}
                  >
                    {grant.revoked_at ? 'Revoked' : 'Revoke access'}
                  </Button>
                </div>
              ))}
              <a href={RoutePath.KEYS} className="text-sm underline">
                Back to API Keys
              </a>
            </>
          )}
        </>
      )}
    </main>
  )
}
