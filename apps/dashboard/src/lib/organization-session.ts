/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { RoutePath } from '@/enums/RoutePath'

export const ORGANIZATION_SESSION_KEY = 'boxlite-organization-session'
export const ORGANIZATION_SESSION_EVENT = 'boxlite-organization-selected'

export function readOrganizationSession(userId: string | undefined): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ORGANIZATION_SESSION_KEY) || 'null')
    return userId && saved?.userId === userId && typeof saved.organizationId === 'string' ? saved.organizationId : null
  } catch {
    return null
  }
}

export function saveOrganizationSession(userId: string, organizationId: string) {
  // Storage must succeed before navigation; otherwise reload would restore the previous context.
  sessionStorage.setItem(ORGANIZATION_SESSION_KEY, JSON.stringify({ userId, organizationId }))
}

export function organizationSwitchPath(pathname: string): string {
  const lists = [
    RoutePath.BOXES,
    RoutePath.IMAGES,
    RoutePath.CHECKPOINTS,
    RoutePath.VOLUMES,
    RoutePath.DOMAINS,
    RoutePath.CI,
    RoutePath.CI_CONNECTS,
    RoutePath.IMAGE_REGISTRIES,
    RoutePath.KEYS,
  ]
  if (lists.includes(pathname as RoutePath)) return pathname
  if (pathname.startsWith(RoutePath.IMAGES + '/')) return RoutePath.IMAGES
  if (pathname.startsWith(RoutePath.CI + '/')) return RoutePath.CI
  return RoutePath.BOXES
}
