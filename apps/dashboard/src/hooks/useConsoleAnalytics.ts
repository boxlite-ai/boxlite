import { useLayoutEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from 'react-oidc-context'
import { consolePage, currentVisit } from '@/lib/console-visit'
import { useConfig } from './useConfig'
import { analyticsAllowed, usePrivacyConsent, usePrivacyConsentStore } from './usePrivacyConsent'

export function useConsoleAnalytics() {
  const { posthog } = useConfig()
  const { isAuthenticated, user } = useAuth()
  const { preferences } = usePrivacyConsent()
  const owner = usePrivacyConsentStore((state) => state.currentUserSub)
  const { pathname, key } = useLocation()
  const sub = isAuthenticated ? user?.profile.sub : undefined
  const lastView = useRef<string | undefined>(undefined)

  useLayoutEffect(() => {
    const page = consolePage(pathname)
    if (
      !sub ||
      owner !== sub ||
      !preferences.analytics ||
      !posthog?.host ||
      !posthog.apiKey ||
      !page ||
      !analyticsAllowed(sub)
    ) {
      lastView.current = undefined
      return
    }
    const host = posthog.host.trim().replace(/\/$/, '')
    const endpoint = (host === 'https://app.posthog.com' ? 'https://us.i.posthog.com' : host) + '/i/v0/e/'
    const source = currentVisit()
    const send = (event: string, properties: Record<string, string> = {}) => {
      if (!analyticsAllowed(sub)) return
      // Submit immediately without an application queue or a retry after revocation.
      void fetch(endpoint, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        referrerPolicy: 'no-referrer',
        keepalive: true,
        body: JSON.stringify({
          api_key: posthog.apiKey,
          distinct_id: sub,
          event,
          properties: {
            $current_url: window.location.origin + page,
            $pathname: page,
            ...source,
            ...properties,
            $set_once: { first_console_referring_domain: source.referring_domain },
          },
        }),
      }).catch(() => {})
    }
    const view = JSON.stringify([sub, key, pathname])
    if (lastView.current !== view) {
      lastView.current = view
      send('$pageview')
    }
    const click = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return
      const control = event.target.closest('button,a[href],[role="button"],[role="menuitem"],[role="tab"]')
      if (!control || control.closest('.xterm,[contenteditable="true"]')) return
      const kind = control.getAttribute('role') ?? control.tagName.toLowerCase()
      const action = control.getAttribute('data-console-action')
      const destination =
        control instanceof HTMLAnchorElement && control.origin === window.location.origin
          ? consolePage(control.pathname)
          : undefined
      send('console_control_click', { control: kind, ...(action && { action }), ...(destination && { destination }) })
    }
    document.addEventListener('click', click, true)
    return () => document.removeEventListener('click', click, true)
  }, [sub, owner, preferences.analytics, posthog, key, pathname])
}
