import { useLayoutEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from 'react-oidc-context'
import { consolePage, currentVisit } from '@/lib/console-visit'
import { billingTab } from '@/lib/billing-tab'
import { RoutePath } from '@/enums/RoutePath'
import { useConfig } from './useConfig'

export function useConsoleAnalytics() {
  const { posthog, billingApiUrl } = useConfig()
  const { isAuthenticated, user } = useAuth()
  const { pathname, search, key } = useLocation()
  const sub = isAuthenticated ? user?.profile.sub : undefined
  const lastView = useRef<string | undefined>(undefined)

  useLayoutEffect(() => {
    const page = consolePage(pathname)
    if (!sub || !posthog?.host || !posthog.apiKey || !page) {
      lastView.current = undefined
      return
    }
    const host = posthog.host.trim().replace(/\/$/, '')
    const endpoint = (host === 'https://app.posthog.com' ? 'https://us.i.posthog.com' : host) + '/i/v0/e/'
    const source = currentVisit()
    const send = (event: string, properties: Record<string, string> = {}) => {
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
            ...(page === RoutePath.BILLING &&
              billingApiUrl && { billing_tab: billingTab(new URLSearchParams(search)) }),
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
  }, [sub, posthog, billingApiUrl, key, pathname, search])
}
