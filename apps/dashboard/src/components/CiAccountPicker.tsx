/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useRef, useState } from 'react'
import type { CiConnectResult } from '@/api/ci-types'
import type { ApiClient } from '@/api/apiClient'
import { Button } from '@/components/ui/button'
import { clearCiConnectSession } from '@/lib/ci-connect'

export function CiAccountPicker({
  api,
  organization,
  result,
  onResult,
}: {
  api: Pick<ApiClient, 'selectCiConnect'>
  organization: string
  result: CiConnectResult
  onResult(result: CiConnectResult): void
}) {
  const accounts = result.accounts ?? []
  const [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false)
  const submitting = useRef(false)
  const connect = async () => {
    if (submitting.current || !result.id || !selected) return
    submitting.current = true
    setBusy(true)
    setError(false)
    try {
      const value = await api.selectCiConnect(organization, result.id, Number(selected))
      if (value.status !== 'selection_required' && value.status !== 'pending') clearCiConnectSession()
      onResult(value)
    } catch {
      setError(true)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <section className="space-y-4">
      <p>Choose the GitHub account to connect to this BoxLite account.</p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          void connect()
        }}
      >
        <fieldset disabled={busy} className="space-y-2">
          <legend className="sr-only">Available GitHub accounts</legend>
          {accounts.map((account) => (
            <label key={account.installation_id} className="flex items-center gap-3 border border-border p-3">
              <input
                type="radio"
                name="github-installation"
                value={account.installation_id}
                checked={selected === String(account.installation_id)}
                onChange={(event) => setSelected(event.target.value)}
              />
              <span>
                {account.github_account}{' '}
                <span className="text-muted-foreground">
                  {account.account_type === 'User' ? 'Personal account' : 'Organization'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {!accounts.length && <p>No installed account that you own is available. Install the App to continue.</p>}
        <Button type="submit" disabled={busy || !selected}>
          Connect selected account
        </Button>
      </form>
      {error && <p role="alert">Unable to connect this account. Retry or restart authorization.</p>}
      {result.installation_url && (
        <a className="block underline" href={result.installation_url}>
          Install on another account
        </a>
      )}
    </section>
  )
}
