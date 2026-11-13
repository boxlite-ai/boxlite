/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useRef, useState } from 'react'
import type { CiConnectResult } from '@/api/ci-types'
import type { ApiClient } from '@/api/apiClient'
import { CiRepositoryDetails } from './ci/CiRepositoryDetails'
import { AsciiButton } from '@/components/ascii'
import { Building2, Check, ChevronDown, ExternalLink, Github, Loader2 } from '@/components/ui/icon'
import { githubAuthorizationSettingsUrl, prepareCiInstallationRedirect } from '@/lib/ci-connect'

export function CiAccountPicker({
  api,
  organization,
  result,
  onResult,
  onSwitch,
}: {
  api: Pick<ApiClient, 'selectCiAccount' | 'getCiRepositories'>
  organization: string
  result: CiConnectResult
  onResult(result: CiConnectResult): void
  onSwitch(selectAccount: boolean): void
}) {
  const [busy, setBusy] = useState<number>(),
    [allowPrivate, setAllowPrivate] = useState(false),
    [error, setError] = useState('')
  const [expanded, setExpanded] = useState<number[]>([])
  const generation = useRef(0),
    submitting = useRef(false)
  useEffect(
    () => () => {
      generation.current++
      submitting.current = false
    },
    [organization, result.id],
  )
  const choose = async (account: number) => {
    if (submitting.current || !result.id) return
    const request = ++generation.current
    submitting.current = true
    setBusy(account)
    setError('')
    try {
      const value = await api.selectCiAccount(organization, result.id, account, allowPrivate)
      if (request !== generation.current) return
      if (value.status === 'installation_required' && value.installation_url)
        window.location.assign(prepareCiInstallationRedirect(result.id, value.installation_url))
      onResult(value)
    } catch {
      if (request === generation.current) setError('Unable to complete this connection. Reconnect GitHub to retry.')
    } finally {
      if (request === generation.current) {
        submitting.current = false
        setBusy(undefined)
      }
    }
  }
  const switchAccount = (select: boolean) => {
    generation.current++
    submitting.current = false
    setBusy(undefined)
    onSwitch(select)
  }
  const settingsUrl = githubAuthorizationSettingsUrl(result.authorization_settings_url)
  return (
    <>
      <div className="flex items-center gap-2 font-mono text-meta text-muted-foreground">
        <Github className="size-4 shrink-0" />
        <span>
          Signed in as <span className="text-foreground">{result.authenticated_account}</span>
        </span>
        <button
          type="button"
          onClick={() => switchAccount(true)}
          className="ml-auto whitespace-nowrap underline underline-offset-4 hover:text-foreground"
        >
          Switch account
        </button>
      </div>
      <div className="divide-y divide-border border-y border-border">
        {(result.accounts ?? []).map((account) => (
          <div
            key={account.account_id}
            data-account-id={account.account_id}
            className="flex flex-wrap items-center gap-3 py-3"
          >
            <div className="flex size-9 shrink-0 items-center justify-center border border-border bg-card text-muted-foreground">
              {account.account_type === 'User' ? <Github className="size-4" /> : <Building2 className="size-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-body font-medium">{account.github_account}</div>
              <div className="mt-1 flex items-center gap-2 font-mono text-meta text-muted-foreground">
                {account.account_type === 'User' ? (
                  'Personal account'
                ) : (
                  <>
                    {'Organization'}
                    <span className="text-label">OWNER</span>
                  </>
                )}
              </div>
            </div>
            {account.installed && account.installation_id && (
              <button
                type="button"
                aria-label={`Repositories for ${account.github_account}`}
                aria-expanded={expanded.includes(account.account_id)}
                onClick={() =>
                  setExpanded((rows) =>
                    rows.includes(account.account_id)
                      ? rows.filter((id) => id !== account.account_id)
                      : [...rows, account.account_id],
                  )
                }
                className="mr-3 text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={`size-4 ${expanded.includes(account.account_id) ? '' : '-rotate-90'}`} />
              </button>
            )}
            <div className="flex min-w-[96px] shrink-0 justify-end">
              {account.connected ? (
                <span className="inline-flex items-center gap-1.5 font-mono text-meta text-success">
                  <Check className="size-4" />
                  Connected
                </span>
              ) : busy === account.account_id ? (
                <span role="status" className="inline-flex items-center gap-2 text-meta text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Connecting…
                </span>
              ) : (
                <AsciiButton size="sm" disabled={busy !== undefined} onClick={() => void choose(account.account_id)}>
                  {account.installed ? (
                    'Connect'
                  ) : (
                    <>
                      {'Install'}
                      <ExternalLink className="size-3.5" />
                    </>
                  )}
                </AsciiButton>
              )}
            </div>
            {expanded.includes(account.account_id) && account.installation_id && result.id && (
              <div className="w-full basis-full pt-2">
                <CiRepositoryDetails
                  api={api}
                  organization={organization}
                  context={{ kind: 'grant', id: result.id, account: account.account_id }}
                  installation={account.installation_id}
                  account={account.github_account}
                  managementUrl={account.installation_settings_url}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <CiOrganizationRecovery settingsUrl={settingsUrl} reconnect={() => switchAccount(false)} />
      <label className="flex items-center gap-2 text-body">
        <input
          type="checkbox"
          checked={allowPrivate}
          disabled={busy !== undefined}
          onChange={(event) => setAllowPrivate(event.target.checked)}
        />
        Allow private repositories
      </label>
      {error && (
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

export function CiOrganizationRecovery({ settingsUrl, reconnect }: { settingsUrl?: string; reconnect?(): void }) {
  return (
    <details className="font-sans text-meta text-muted-foreground">
      <summary className="cursor-pointer underline underline-offset-4 hover:text-foreground">
        Missing an organization?
      </summary>
      <p className="mt-2">
        Your organization may need to approve OAuth access, or require you to sign in with SSO before reconnecting.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {settingsUrl && (
          <a href={settingsUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
            Review GitHub access
          </a>
        )}
        {reconnect && (
          <button type="button" onClick={reconnect} className="underline underline-offset-4">
            Reconnect GitHub
          </button>
        )}
        <a
          href="https://docs.github.com/en/apps/oauth-apps/using-oauth-apps/authorizing-oauth-apps#oauth-apps-and-organizations"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4"
        >
          GitHub help
        </a>
      </div>
    </details>
  )
}
