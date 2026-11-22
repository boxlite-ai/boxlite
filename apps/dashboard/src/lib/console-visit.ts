import { RoutePath } from '@/enums/RoutePath'
import { matchPath } from 'react-router-dom'
import { v4 as uuid, validate as isUuid } from 'uuid'
import { z } from 'zod'

const campaignTag = z.string().regex(/^[a-z0-9_.-]{1,80}$/i)
const visitSchema = z.object({
  referring_domain: z.string().refine((value) => {
    if (value === 'direct/unknown') return true
    try {
      return new URL('https://' + value).hostname === value
    } catch {
      return false
    }
  }),
  visit_id: z.string().refine(isUuid),
  utm_source: campaignTag.optional(),
  utm_medium: campaignTag.optional(),
  utm_campaign: campaignTag.optional(),
})

const routes = Object.values(RoutePath).filter((path) => path.startsWith('/dashboard/'))
const orderedRoutes = [...routes.filter((path) => !path.includes(':')), ...routes.filter((path) => path.includes(':'))]

export function consolePage(pathname: string) {
  return orderedRoutes.find((path) => matchPath(path, pathname))
}

export function incomingVisit(referrer: string, href: string) {
  const landing = new URL(href)
  let source = 'direct/unknown'
  try {
    const previous = new URL(referrer)
    if (['http:', 'https:'].includes(previous.protocol) && previous.origin !== landing.origin)
      source = previous.hostname
  } catch {
    // A browser may omit the referrer even for an external link.
  }
  const campaign: Record<string, string> = {}
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
    const value = landing.searchParams.get(key)
    if (value && campaignTag.safeParse(value).success) campaign[key] = value
  }
  return { referring_domain: source, visit_id: uuid(), ...campaign }
}

export type ConsoleVisit = z.infer<typeof visitSchema>
let visit: ConsoleVisit | undefined

export function currentVisit(): ConsoleVisit | undefined {
  if (visit) return visit
  try {
    const navigation = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined
    const sameOrigin = document.referrer && new URL(document.referrer).origin === location.origin
    const saved = (navigation?.type === 'reload' || sameOrigin) && sessionStorage.getItem('boxlite-console-visit')
    if (saved) {
      const previous = visitSchema.safeParse(JSON.parse(saved))
      if (previous.success) {
        visit = previous.data
        return previous.data
      }
    }
  } catch {
    // Storage and navigation timing are optional.
  }
  try {
    restoreVisit(incomingVisit(document.referrer, window.location.href))
    return visit
  } catch {
    return undefined
  }
}

export function restoreVisit(source?: unknown) {
  visit = undefined
  try {
    const parsed = visitSchema.safeParse(source)
    visit = parsed.success ? parsed.data : incomingVisit('', window.location.origin)
    sessionStorage.setItem('boxlite-console-visit', JSON.stringify(visit))
  } catch {
    // In-memory attribution still spans client-side navigation.
  }
}

export function registrationSourceHeaders(): Record<string, string> | undefined {
  const source = currentVisit()
  if (!source) return undefined
  const { referring_domain, utm_source, utm_medium, utm_campaign } = source
  return { 'X-BoxLite-Registration-Source': JSON.stringify({ referring_domain, utm_source, utm_medium, utm_campaign }) }
}
