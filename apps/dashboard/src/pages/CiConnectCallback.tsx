/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '@/hooks/useApi'
import { completeCiRedirect } from '@/lib/ci-connect'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { Button } from '@/components/ui/button'

export default function CiConnectCallback() {
  const api = useApi()
  const [view, setView] = useState<Awaited<ReturnType<typeof completeCiRedirect>>>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    completeCiRedirect(api).then(
      (value) => {
        if (active) setView(value)
      },
      () => {
        if (active) setFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [api])
  const result = view?.result
  return (
    <main className="mx-auto max-w-lg space-y-5 px-6 py-20">
      <h1 className="font-display text-2xl font-semibold">Connect GitHub CI</h1>
      {!view && !failed && <p role="status">Verifying GitHub authorization…</p>}
      {result?.status === 'connected' ? (
        <>
          <p role="status">GitHub connected. Listener setup: {result.listener_status}.</p>
          <Button
            onClick={() => {
              window.localStorage.setItem(LocalStorageKey.SelectedOrganizationId, view!.organization)
              window.location.assign('/dashboard/settings?tab=ci')
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
            {result?.installation_url && (
              <a className="underline" href={result.installation_url} rel="noreferrer" target="_blank">
                Install GitHub App
              </a>
            )}
            <Link className="block underline" to="/dashboard/settings?tab=ci">
              Back to CI settings
            </Link>
          </>
        )
      )}
    </main>
  )
}
