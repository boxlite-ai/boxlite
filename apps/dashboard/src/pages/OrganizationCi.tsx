/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { Button } from '@/components/ui/button'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { prepareCiRedirect } from '@/lib/ci-connect'

export default function OrganizationCi() {
  const api = useApi(),
    cache = useQueryClient()
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const organization = selectedOrganization!.id
  const owner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER
  const settings = useQuery({
    queryKey: ['ci-settings', organization],
    queryFn: () => api.getCiSettings(organization),
    enabled: owner,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.connections.some((item) => item.listener_status === 'provisioning') ? 5000 : false,
  })
  const configuration = useQuery({
    queryKey: ['ci-connect-configuration', organization],
    queryFn: () => api.getCiConnectConfiguration(organization),
    enabled: owner && settings.data?.available === true,
    retry: false,
  })
  const [maximum, setMaximum] = useState(''),
    [accountType, setAccountType] = useState<'User' | 'Organization'>('User'),
    [allowPublic, setAllowPublic] = useState(false)
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const submitting = useRef(false)
  useEffect(() => {
    setMaximum(settings.data?.max_concurrent_jobs?.toString() ?? '')
  }, [settings.data?.max_concurrent_jobs])
  if (!owner) return <p>Only account owners can connect GitHub and configure CI.</p>
  if (settings.isPending) return <p role="status">Loading CI settings…</p>
  if (settings.isError)
    return (
      <div>
        <p role="alert">Unable to load CI settings.</p>
        <Button onClick={() => void settings.refetch()}>Retry</Button>
      </div>
    )
  const value = settings.data!
  if (!value.available) return <p>Hosted CI is not enabled on this deployment.</p>
  const inputClass = 'w-full border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand'
  const save = async () => {
    if (submitting.current) return
    const parsed = maximum === '' ? null : Number(maximum)
    if (
      maximum !== '' &&
      (!/^(0|[1-9]\d*)$/.test(maximum) ||
        !Number.isSafeInteger(parsed) ||
        (value.commerce_limit !== null && parsed! > value.commerce_limit))
    ) {
      setMessage('Enter a whole number within your account allowance, or leave blank to inherit it.')
      return
    }
    submitting.current = true
    setBusy(true)
    setMessage('')
    try {
      cache.setQueryData(['ci-settings', organization], await api.setCiCapacity(organization, parsed))
      setMessage('CI capacity saved.')
    } catch {
      setMessage('Unable to save CI capacity. Try again.')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  const connect = async () => {
    if (
      submitting.current ||
      !configuration.data?.apps.find((app) => app.account_type === accountType)?.web_connect_available
    )
      return
    submitting.current = true
    setBusy(true)
    setMessage('')
    try {
      const attempt = await api.startCiConnect(organization, {
        account_type: accountType,
        follow_installation: true,
        allow_public_repositories: allowPublic,
      })
      window.location.assign(prepareCiRedirect(organization, attempt))
    } catch {
      submitting.current = false
      setBusy(false)
      setMessage('Unable to start GitHub authorization. Try again.')
    }
  }
  return (
    <div className="space-y-7">
      <section className="space-y-4 border border-border p-5">
        <h2 className="font-semibold">CI capacity</h2>
        <p className="text-sm text-muted-foreground">
          One total across all connected GitHub accounts and repositories. Existing jobs continue when you lower it.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
          className="space-y-3"
        >
          <label className="block text-sm" htmlFor="ci-maximum">
            Maximum concurrent CI jobs
          </label>
          <input
            id="ci-maximum"
            type="number"
            min="0"
            max={value.commerce_limit ?? undefined}
            step="1"
            value={maximum}
            placeholder="Inherit account allowance"
            disabled={busy}
            onChange={(event) => setMaximum(event.target.value)}
            className={inputClass}
          />
          <p className="text-sm text-muted-foreground">
            Leave blank to inherit; 0 pauses new workers. Effective limit: {value.effective_limit ?? 'Unlimited'}.
            Account allowance: {value.commerce_limit ?? 'Unlimited'}. Other Boxes also use this allowance.
          </p>
          <Button type="submit" disabled={busy}>
            Save capacity
          </Button>
        </form>
      </section>
      <section className="space-y-4 border border-border p-5">
        <h2 className="font-semibold">Connect GitHub</h2>
        <p className="text-sm text-muted-foreground">
          Connect a personal account or an organization you own. Installed repositories use{' '}
          <code>runs-on: boxlite-ci-runner</code>.
        </p>
        {configuration.isError && (
          <div>
            <p role="alert">Unable to load GitHub App configuration.</p>
            <Button onClick={() => void configuration.refetch()}>Retry GitHub configuration</Button>
          </div>
        )}
        {configuration.data &&
          !configuration.data.apps.find((app) => app.account_type === accountType)?.web_connect_available && (
            <p>Browser connect is not configured on this deployment.</p>
          )}
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
          className="space-y-3"
        >
          <fieldset className="space-y-2">
            <legend className="text-sm">GitHub account type</legend>
            {(['User', 'Organization'] as const).map((type) => (
              <label key={type} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="ci-account-type"
                  value={type}
                  checked={accountType === type}
                  disabled={busy}
                  onChange={() => setAccountType(type)}
                />
                {type === 'User' ? 'Personal account' : 'Organization (owner required)'}
              </label>
            ))}
          </fieldset>
          <p className="text-sm text-muted-foreground">
            Authorize GitHub, then choose an installed account or install the App.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowPublic}
              onChange={(event) => setAllowPublic(event.target.checked)}
              disabled={busy}
            />
            Allow installed public repositories to run CI
          </label>
          <Button
            type="submit"
            disabled={
              busy || !configuration.data?.apps.find((app) => app.account_type === accountType)?.web_connect_available
            }
          >
            Connect GitHub
          </Button>
        </form>
      </section>
      {message && <p role="status">{message}</p>}
      <section className="space-y-3">
        <h2 className="font-semibold">Connected GitHub accounts</h2>
        {value.connections.length ? (
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>GitHub account</th>
                <th>Listener</th>
                <th>Public repositories</th>
              </tr>
            </thead>
            <tbody>
              {value.connections.map((connection) => (
                <tr key={connection.binding_id}>
                  <td>{connection.github_account}</td>
                  <td>{connection.listener_status}</td>
                  <td>{connection.allow_public_repositories ? 'Allowed' : 'Excluded'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">Connect GitHub to run installed repositories on BoxLite.</p>
        )}
        <Button variant="outline" onClick={() => void settings.refetch()}>
          Refresh connections
        </Button>
      </section>
    </div>
  )
}
