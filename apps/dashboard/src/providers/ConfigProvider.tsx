/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RoutePath } from '@/enums/RoutePath'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { BoxliteConfiguration } from '@boxlite-ai/api-client'
import { useSuspenseQuery } from '@tanstack/react-query'
import { InMemoryWebStorage, WebStorageStateStore } from 'oidc-client-ts'
import { ReactNode, useMemo } from 'react'
import { AuthProvider, AuthProviderProps } from 'react-oidc-context'
import { ConfigContext } from '../contexts/ConfigContext'
import { MockAuthProvider } from '../mocks/MockAuthProvider'

const apiUrl = (import.meta.env.VITE_BASE_API_URL ?? window.location.origin) + '/api'
const isMocking = import.meta.env.VITE_ENABLE_MOCKING === 'true'

type Props = {
  children: ReactNode
}

export function ConfigProvider(props: Props) {
  const { data: config } = useSuspenseQuery({
    queryKey: queryKeys.config.all,
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/config`)
      if (!res.ok) {
        throw res
      }
      return res.json() as Promise<BoxliteConfiguration>
    },
  })

  const oidcConfig: AuthProviderProps = useMemo(() => {
    const isLocalhost = window.location.hostname === 'localhost'
    const stateStore = isLocalhost ? window.sessionStorage : new InMemoryWebStorage()
    // OIDC redirect target — must match an Auth0 Allowed Callback URL exactly. The SPA is mounted
    // under Vite's BASE_URL (always trailing slash, e.g. '/dashboard/' for prod-B, '/' for dev),
    // and the callback page lives at the SPA root; we strip the trailing slash so the URL Auth0
    // sees is e.g. 'https://app.boxlite.ai/dashboard' (matches the allowed callback) or
    // 'https://dev.boxlite.ai' for dev (BASE_URL='/' → strips to '').
    const appOrigin = window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, '')

    return {
      authority: config.oidc.issuer,
      client_id: config.oidc.clientId,
      extraQueryParams: {
        audience: config.oidc.audience,
      },
      scope: 'openid profile email',
      redirect_uri: appOrigin,
      staleStateAgeInSeconds: 60,
      accessTokenExpiringNotificationTimeInSeconds: 290,
      userStore: new WebStorageStateStore({ store: stateStore }),
      onSigninCallback: (user) => {
        const state = user?.state as { returnTo?: string } | undefined
        const targetUrl = state?.returnTo || RoutePath.DASHBOARD
        window.history.replaceState({}, '', targetUrl)
        window.dispatchEvent(new PopStateEvent('popstate'))
      },
      post_logout_redirect_uri: appOrigin,
      // For IdPs (e.g. Dex) that don't advertise end_session_endpoint via discovery,
      // the API exposes a compatible endpoint and reports it here.
      ...(config.oidc.endSessionEndpoint && {
        metadataSeed: { end_session_endpoint: config.oidc.endSessionEndpoint },
      }),
    }
  }, [config])

  return (
    <ConfigContext.Provider value={{ ...config, apiUrl }}>
      {isMocking ? (
        <MockAuthProvider>{props.children}</MockAuthProvider>
      ) : (
        <AuthProvider {...oidcConfig}>{props.children}</AuthProvider>
      )}
    </ConfigContext.Provider>
  )
}
