/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Organization } from '@boxlite-ai/api-client'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { OrganizationsContext, IOrganizationsContext } from '@/contexts/OrganizationsContext'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import LoadingFallback from '@/components/LoadingFallback'
import { Button } from '@/components/ui/button'
import { registrationSession } from '@/lib/referral-session'

type Initialization = { request: Promise<Organization[]>; consumers: number }
const initializing = new Map<string, Initialization>()

function failureDetails(error: unknown): { status?: number; message: string } {
  let cause = error as { response?: { status: number }; cause?: unknown; message?: string }
  for (let depth = 0; cause && depth < 4; depth++) {
    if (cause.response) return { status: cause.response.status, message: String((error as Error).message) }
    cause = cause.cause as typeof cause
  }
  return { message: error instanceof Error ? error.message : 'Could not load your organizations' }
}

export function OrganizationsProvider({ children }: { children: ReactNode }) {
  const { organizationsApi } = useApi()
  const config = useConfig()
  const auth = useAuth()
  const identityKey = JSON.stringify([config.oidc.issuer, auth.user?.profile.sub])
  const activeIdentity = useRef(identityKey)
  activeIdentity.current = identityKey
  const [loaded, setLoaded] = useState<{ identityKey: string; organizations: Organization[] }>()
  const [failure, setFailure] = useState<ReturnType<typeof failureDetails>>()
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let current = true
    let lease: { key: string; entry: Initialization } | undefined
    setFailure(undefined)
    const initialize = async () => {
      const draft = registrationSession.snapshot({ issuer: config.oidc.issuer, userId: auth.user?.profile.sub ?? '' })
      const key = JSON.stringify([identityKey, draft?.contextId, draft?.referredCode])
      let entry = initializing.get(key)
      if (!entry) {
        const request = (
          draft?.referredCode
            ? organizationsApi.listOrganizations({ referredCode: draft.referredCode })
            : organizationsApi.listOrganizations()
        ).then(({ data }) => data)
        entry = { request, consumers: 0 }
        initializing.set(key, entry)
        const release = () => {
          if (initializing.get(key) === entry) initializing.delete(key)
        }
        void request.then(release, release)
      }
      entry.consumers += 1
      lease = { key, entry }
      const organizations = await entry.request
      if (!current) return
      if (draft) registrationSession.complete(draft.contextId)
      const url = new URL(window.location.href)
      url.searchParams.delete('referredCode')
      window.history.replaceState({}, '', url.pathname + url.search + url.hash)
      setLoaded({ identityKey, organizations })
    }
    void initialize().catch((error) => {
      if (!current) return
      const details = failureDetails(error)
      if (details.status === 400 || details.status === 422) registrationSession.rejectLink()
      setFailure(details)
    })
    return () => {
      current = false
      if (!lease) return
      const { key, entry } = lease
      entry.consumers -= 1
      // StrictMode remounts synchronously and reuses the pending call. A real unmount must
      // release it: ApiClient deliberately leaves a 401 recovery promise unresolved.
      queueMicrotask(() => {
        if (entry.consumers === 0 && initializing.get(key) === entry) initializing.delete(key)
      })
    }
  }, [organizationsApi, identityKey, config.oidc.issuer, auth.user?.profile.sub, retry])

  const refreshOrganizations = useCallback(
    async (selectedOrganizationId?: string) => {
      const { data } = await organizationsApi.listOrganizations()
      if (activeIdentity.current !== identityKey) return
      setLoaded({ identityKey, organizations: data })
      if (selectedOrganizationId) localStorage.setItem(LocalStorageKey.SelectedOrganizationId, selectedOrganizationId)
    },
    [organizationsApi, identityKey],
  )

  const contextValue: IOrganizationsContext = useMemo(
    () => ({
      organizations: loaded?.organizations ?? [],
      refreshOrganizations,
    }),
    [loaded, refreshOrganizations],
  )

  if (failure) {
    const status = failure.status
    return (
      <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-4 px-6">
        <h1 className="text-xl font-semibold">Registration could not continue</h1>
        <p role="alert">
          {status === 403
            ? 'Verify your email, then sign in again to continue with the same invitation.'
            : status === 409
              ? 'This identity already has a finalized registration.'
              : status === 410
                ? 'This registration is unavailable. Contact support.'
                : status === 400 || status === 422
                  ? 'This invitation cannot be used. Open a new valid invitation link.'
                  : failure.message}
        </p>
        {status === 409 && (
          <Button
            onClick={() => {
              registrationSession.ordinaryLogin()
              setRetry(retry + 1)
            }}
          >
            Continue with ordinary login
          </Button>
        )}
        {status === 403 && (
          <Button
            onClick={() => {
              let draft: ReturnType<typeof registrationSession.read>
              try {
                draft = registrationSession.read()
              } catch {
                return window.location.replace('/register?resume=1')
              }
              void auth.signinRedirect({
                prompt: 'login',
                state: draft ? registrationSession.oidcState(draft) : { returnTo: '/dashboard' },
              })
            }}
          >
            I verified my email — sign in again
          </Button>
        )}
        {![400, 403, 409, 410, 422].includes(status ?? 0) && <Button onClick={() => setRetry(retry + 1)}>Retry</Button>}
      </main>
    )
  }
  if (!loaded || loaded.identityKey !== identityKey) return <LoadingFallback />
  return <OrganizationsContext.Provider value={contextValue}>{children}</OrganizationsContext.Provider>
}
