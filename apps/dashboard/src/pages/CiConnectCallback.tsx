/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useState, type MouseEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useApi } from '@/hooks/useApi'
import { clearCiConnectSession, getCiConnectSession, completeCiRedirect } from '@/lib/ci-connect'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { Button } from '@/components/ui/button'
import { CiOrganizationRecovery } from '@/components/CiAccountPicker'
import { toast } from 'sonner'

export default function CiConnectCallback() {
  const api = useApi()
  const [view, setView] = useState<Awaited<ReturnType<typeof completeCiRedirect>>>()
  const [failed, setFailed] = useState(false)
  const [storageFailed, setStorageFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [pending] = useState(getCiConnectSession)
  const selectOrganization = (organization: string) => {
    try {
      window.localStorage.setItem(LocalStorageKey.SelectedOrganizationId, organization)
      setStorageFailed(false)
      return true
    } catch {
      setStorageFailed(true)
      return false
    }
  }
  const leave = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    clearCiConnectSession()
    if (pending)
      void api
        .cancelCiConnect(pending.organization, pending.attempt)
        .catch(() => toast.error('Unable to confirm cancellation of the previous GitHub authorization.'))
  }
  useEffect(() => {
    let active = true
    setFailed(false)
    completeCiRedirect(api).then(
      (value) => {
        if (active) {
          selectOrganization(value.organization)
          setView(value)
        }
      },
      () => {
        if (active) setFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [api, retry])
  const result = view?.result
  return (
    <main className="mx-auto max-w-lg space-y-5 px-6 py-20">
      <Link
        onClick={leave}
        className="block font-mono text-meta underline underline-offset-4"
        to="/dashboard/ci/connects"
      >
        Back to Connects
      </Link>
      <h1 className="font-display text-2xl font-semibold">Connect GitHub CI</h1>
      {!view && !failed && <p role="status">Verifying GitHub authorization…</p>}
      {storageFailed && (
        <div role="alert">
          GitHub authorization was received, but this browser could not select the original BoxLite organization. Free
          browser storage and retry.
          <Button onClick={() => view && selectOrganization(view.organization)}>Retry organization selection</Button>
        </div>
      )}
      {['selection_required', 'installation_required', 'pending'].includes(result?.status || '') &&
      !storageFailed &&
      view &&
      result?.id ? (
        <Navigate replace to={'/dashboard/ci/connects?connect=' + encodeURIComponent(result.id)} />
      ) : result?.status === 'connected' ? (
        <>
          <p role="status">GitHub connected. Listener setup: {result.listener_status}.</p>
          <Button
            onClick={() => {
              if (selectOrganization(view!.organization)) window.location.assign('/dashboard/ci/connects')
            }}
          >
            Continue to CI settings
          </Button>
        </>
      ) : (
        (view || failed) && (
          <>
            <p role="alert">
              {result?.status === 'installation_required'
                ? 'Install the GitHub App, then restart connect.'
                : 'Authorization did not complete. Restart connect from CI settings.'}
            </p>
            {failed && getCiConnectSession() && (
              <Button onClick={() => setRetry((value) => value + 1)}>Retry authorization status</Button>
            )}
            <CiOrganizationRecovery />
            {result?.installation_url && (
              <a className="underline" href={result.installation_url} rel="noreferrer" target="_blank">
                Install GitHub App
              </a>
            )}
            <Link className="block underline" to="/dashboard/ci/connects">
              Back to CI settings
            </Link>
          </>
        )
      )}
    </main>
  )
}
