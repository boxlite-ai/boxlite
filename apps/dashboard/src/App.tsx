/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import OrganizationSettings from '@/pages/OrganizationSettings'
import { NotificationSocketProvider } from '@/providers/NotificationSocketProvider'
import { OrganizationsProvider } from '@/providers/OrganizationsProvider'
import { SelectedOrganizationProvider } from '@/providers/SelectedOrganizationProvider'
import { initPylon } from '@/vendor/pylon'
import { useFeatureFlagEnabled, usePostHog } from 'posthog-js/react'
import React, { Suspense, useEffect } from 'react'
import { useAuth } from 'react-oidc-context'
import { generatePath, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { BannerProvider } from './components/Banner'
import { CommandPaletteProvider } from './components/CommandPalette'
import LoadingFallback from './components/LoadingFallback'
import { Button } from './components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'
import { BOXLITE_DOCS_URL, BOXLITE_SLACK_URL } from './constants/ExternalLinks'
import { FeatureFlags } from './enums/FeatureFlags'
import { RoutePath, getRouteSubPath } from './enums/RoutePath'
import { useConfig } from './hooks/useConfig'
import { isDashboardVncEnabled } from './lib/dashboard-features'
import Dashboard from './pages/Dashboard'
import EmailVerify from './pages/EmailVerify'
import Keys from './pages/Keys'
import LandingPage from './pages/LandingPage'
import Logout from './pages/Logout'
import NotFound from './pages/NotFound'
import Admin from './pages/Admin'
import Billing from './pages/Billing'
import Boxes from './pages/Boxes'
import { BoxDetails, BoxTerminalFullscreen, BoxVncFullscreen } from './components/boxes'
import { ApiProvider } from './providers/ApiProvider'
import { RegionsProvider } from './providers/RegionsProvider'
import { BoxSessionProvider } from './providers/BoxSessionProvider'

const HIDDEN_DASHBOARD_ROUTES = [
  RoutePath.IMAGES,
  RoutePath.REGISTRIES,
  RoutePath.VOLUMES,
  RoutePath.LIMITS,
  RoutePath.BILLING_SPENDING,
  RoutePath.BILLING_WALLET,
  RoutePath.MEMBERS,
  RoutePath.ROLES,
  RoutePath.AUDIT_LOGS,
  RoutePath.REGIONS,
  RoutePath.RUNNERS,
  RoutePath.EXPERIMENTAL,
  RoutePath.PLAYGROUND,
  RoutePath.WEBHOOKS,
  RoutePath.WEBHOOK_ENDPOINT_DETAILS,
]

// Simple redirection components for external URLs
const DocsRedirect = () => {
  React.useEffect(() => {
    window.open(BOXLITE_DOCS_URL, '_blank')
    window.location.href = RoutePath.DASHBOARD
  }, [])
  return null
}

const SlackRedirect = () => {
  React.useEffect(() => {
    window.open(BOXLITE_SLACK_URL, '_blank')
    window.location.href = RoutePath.DASHBOARD
  }, [])
  return null
}

const LegacyBoxRedirect = ({
  route,
}: {
  route: RoutePath.BOX_DETAILS | RoutePath.BOX_TERMINAL | RoutePath.BOX_VNC
}) => {
  const location = useLocation()
  const { boxId } = useParams()

  if (!boxId) {
    return <Navigate to={`${RoutePath.BOXES}${location.search}`} replace />
  }

  return <Navigate to={`${generatePath(route, { boxId })}${location.search}`} replace />
}

const BoxVncFeatureRoute = ({ enabled }: { enabled: boolean }) => {
  const { boxId } = useParams()

  if (!enabled) {
    return <Navigate to={boxId ? generatePath(RoutePath.BOX_DETAILS, { boxId }) : RoutePath.BOXES} replace />
  }

  return <BoxVncFullscreen />
}

// Same-origin OIDC silent-renew iframes are legitimate, so frame refusal
// belongs in deployment headers. The terminal Paste action also refuses to
// read clipboard when the dashboard itself is framed.

function App() {
  const config = useConfig()
  const location = useLocation()
  const posthog = usePostHog()
  const vncEnabled = isDashboardVncEnabled(useFeatureFlagEnabled(FeatureFlags.DASHBOARD_VNC))
  const { error: authError, isAuthenticated, user, removeUser } = useAuth()
  const boxesRedirect = `${RoutePath.BOXES}${location.search}`

  useEffect(() => {
    if (isAuthenticated && user && posthog?.get_distinct_id() !== user.profile.sub) {
      posthog?.identify(user.profile.sub, {
        email: user.profile.email,
        name: user.profile.name,
      })
    }
    if (import.meta.env.PROD && config.pylonAppId && isAuthenticated && user) {
      initPylon(config.pylonAppId, {
        chat_settings: {
          app_id: config.pylonAppId,
          email: user.profile.email || '',
          name: user.profile.name || '',
          avatar_url: user.profile.picture,
          email_hash: user.profile?.email_hash as string | undefined,
        },
      })
    }
  }, [isAuthenticated, user, posthog, config.pylonAppId])

  // Hack for tracking PostHog pageviews in SPAs
  useEffect(() => {
    if (import.meta.env.PROD) {
      posthog?.capture('$pageview', {
        $current_url: window.location.href,
      })
    }
  }, [location, posthog])

  if (authError) {
    return (
      <Dialog open>
        <DialogContent className="[&>button]:hidden">
          <DialogHeader>
            <DialogTitle>Authentication Error</DialogTitle>
            <DialogDescription>{authError.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={async () => {
                await removeUser()
                window.location.assign(RoutePath.LANDING)
              }}
            >
              Go Back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Routes>
      <Route path={RoutePath.LANDING} element={<LandingPage />} />
      <Route path="/lander" element={<Navigate to={RoutePath.LANDING} replace />} />
      <Route path={RoutePath.LOGOUT} element={<Logout />} />
      <Route path={RoutePath.DOCS} element={<DocsRedirect />} />
      <Route path={RoutePath.SLACK} element={<SlackRedirect />} />
      <Route
        path={RoutePath.ACCOUNT_SETTINGS}
        element={<Navigate to={`${RoutePath.BOXES}${location.search}`} replace />}
      />
      <Route
        path={RoutePath.USER_INVITATIONS}
        element={<Navigate to={`${RoutePath.BOXES}${location.search}`} replace />}
      />
      <Route
        path={RoutePath.DASHBOARD}
        element={
          <Suspense fallback={<LoadingFallback />}>
            <ApiProvider>
              <OrganizationsProvider>
                <SelectedOrganizationProvider>
                  <RegionsProvider>
                    <NotificationSocketProvider>
                      <CommandPaletteProvider>
                        <BannerProvider>
                          <Dashboard />
                        </BannerProvider>
                      </CommandPaletteProvider>
                    </NotificationSocketProvider>
                  </RegionsProvider>
                </SelectedOrganizationProvider>
              </OrganizationsProvider>
            </ApiProvider>
          </Suspense>
        }
      >
        <Route index element={<Navigate to={boxesRedirect} replace />} />
        <Route path={getRouteSubPath(RoutePath.KEYS)} element={<Keys />} />
        <Route path={getRouteSubPath(RoutePath.BOXES)} element={<Boxes />} />
        <Route path={getRouteSubPath(RoutePath.BILLING)} element={<Billing />} />
        <Route path={getRouteSubPath(RoutePath.PRICING)} element={<Navigate to={RoutePath.BILLING} replace />} />
        <Route path={getRouteSubPath(RoutePath.ADMIN)} element={<Admin />} />
        <Route path={getRouteSubPath(RoutePath.LEGACY_BOXES)} element={<Navigate to={boxesRedirect} replace />} />
        {/* TODO(image-rewrite): legacy /dashboard/templates route removed with the templates page. */}
        {/* Pathless layout route: a single BoxSessionProvider fiber
            persists across the three box routes, so activation state
            (e.g. "terminal connected") survives navigation between the
            details view and its fullscreen siblings. Per-route providers
            held state in a useRef that died with each unmount. */}
        <Route
          element={
            <BoxSessionProvider>
              <Outlet />
            </BoxSessionProvider>
          }
        >
          <Route path={getRouteSubPath(RoutePath.BOX_TERMINAL)} element={<BoxTerminalFullscreen />} />
          <Route path={getRouteSubPath(RoutePath.BOX_VNC)} element={<BoxVncFeatureRoute enabled={vncEnabled} />} />
          <Route path={getRouteSubPath(RoutePath.BOX_DETAILS)} element={<BoxDetails />} />
          <Route
            path={getRouteSubPath(RoutePath.LEGACY_BOX_TERMINAL)}
            element={<LegacyBoxRedirect route={RoutePath.BOX_TERMINAL} />}
          />
          <Route
            path={getRouteSubPath(RoutePath.LEGACY_BOX_VNC)}
            element={<LegacyBoxRedirect route={vncEnabled ? RoutePath.BOX_VNC : RoutePath.BOX_DETAILS} />}
          />
          <Route
            path={getRouteSubPath(RoutePath.LEGACY_BOX_DETAILS)}
            element={<LegacyBoxRedirect route={RoutePath.BOX_DETAILS} />}
          />
        </Route>
        {HIDDEN_DASHBOARD_ROUTES.map((path) => (
          <Route key={path} path={getRouteSubPath(path)} element={<Navigate to={boxesRedirect} replace />} />
        ))}
        <Route path={getRouteSubPath(RoutePath.EMAIL_VERIFY)} element={<EmailVerify />} />
        <Route path={getRouteSubPath(RoutePath.SETTINGS)} element={<OrganizationSettings />} />
        <Route
          path={getRouteSubPath(RoutePath.ONBOARDING)}
          element={<Navigate to={`${RoutePath.BOXES}?onboarding=1`} replace />}
        />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

export default App
