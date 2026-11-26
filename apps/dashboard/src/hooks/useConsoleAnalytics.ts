import { useLayoutEffect, useRef } from 'react'
import { matchPath, useLocation } from 'react-router-dom'
import {
  consoleActions,
  consoleControls,
  consolePages,
  type ConsoleInteraction,
} from '../../../shared/console-analytics'
import { billingTab } from '@/lib/billing-tab'
import { RoutePath } from '@/enums/RoutePath'
import { useConfig } from './useConfig'
import { useApi } from './useApi'

const tabSelections = new EventTarget()
const routes = [
  ...consolePages.filter((route) => !route.includes(':')),
  ...consolePages.filter((route) => route.includes(':')),
]
const consolePage = (path: string) => routes.find((route) => matchPath(route, path))

export function recordConsoleTabSelection(action: string) {
  tabSelections.dispatchEvent(new CustomEvent('select', { detail: action }))
}

/** Record only transitions and interactions that occur during an active grant. */
export function useConsoleAnalytics(organizationId: string, enabledFrom: string | null | undefined) {
  const api = useApi()
  const { billingApiUrl } = useConfig()
  const { pathname, search, key } = useLocation()
  const pending = useRef(0)
  const waiting = useRef<Array<() => void>>([])
  const lastView = useRef<{ key: string; at: Date; sent: boolean } | undefined>(undefined)

  // Navigation shares the backlog, but queued events belong to one consent grant.
  useLayoutEffect(() => {
    const queue = waiting.current
    return () => {
      queue.length = 0
    }
  }, [organizationId, enabledFrom])

  useLayoutEffect(() => {
    const viewKey = JSON.stringify([organizationId, key, pathname])
    if (lastView.current?.key !== viewKey) lastView.current = { key: viewKey, at: new Date(), sent: false }
    const view = lastView.current
    if (enabledFrom === null) view.sent = true
    const page = consolePage(pathname)
    if (!page || !enabledFrom || !organizationId) return
    const send = (event: ConsoleInteraction['event'], at: Date, properties: Partial<ConsoleInteraction> = {}) => {
      const body: ConsoleInteraction = {
        event,
        page,
        occurredAt: at.toISOString(),
        ...(page === RoutePath.BILLING && billingApiUrl && { billingTab: billingTab(new URLSearchParams(search)) }),
        ...properties,
      }
      const post = () => {
        pending.current++
        void api.axiosInstance
          .post('/analytics/organizations/' + encodeURIComponent(organizationId) + '/console-events', body, {
            timeout: 2000,
          })
          .catch(() => {})
          .finally(() => {
            pending.current--
            waiting.current.shift()?.()
          })
      }
      if (pending.current < 2) post()
      else if (waiting.current.length < 16) waiting.current.push(post)
    }
    if (!view.sent && view.at.getTime() >= Date.parse(enabledFrom)) {
      view.sent = true
      send('$pageview', view.at)
    }
    const click = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest('[data-analytics-preferences],.xterm,[contenteditable="true"]')
      )
        return
      const target = event.target.closest('button,a[href],[role="button"],[role="menuitem"],[role="tab"]')
      if (!target) return
      const control = target.getAttribute('role') ?? target.tagName.toLowerCase()
      if (!consoleControls.includes(control) || (control === 'tab' && target.closest('[data-console-tab-selections]')))
        return
      const action = target.getAttribute('data-console-action')
      const destination =
        target instanceof HTMLAnchorElement && target.origin === window.location.origin
          ? consolePage(target.pathname)
          : undefined
      send('console_control_click', new Date(), {
        control,
        ...(action && consoleActions.includes(action) && { action }),
        destination,
      })
    }
    const select = (event: Event) => {
      const action = (event as CustomEvent<string>).detail
      if (consoleActions.includes(action)) send('console_control_click', new Date(), { control: 'tab', action })
    }
    tabSelections.addEventListener('select', select)
    document.addEventListener('click', click, true)
    return () => {
      tabSelections.removeEventListener('select', select)
      document.removeEventListener('click', click, true)
    }
  }, [api, enabledFrom, billingApiUrl, key, organizationId, pathname, search])
}
