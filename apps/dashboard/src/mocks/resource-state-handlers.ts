/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { delay, http, HttpResponse, type JsonBodyType } from 'msw'
import type { CiRunners, CiSettings } from '@/api/ci-types'

/** Opt-in desktop review scenarios; registered only by the existing mock worker. */
export function resourceStateHandlers(apiUrl: string) {
  const ciLimits = { available: true, max_concurrent_jobs: 3, commerce_limit: 5, effective_limit: 3 }
  const endpoints: [string, JsonBodyType][] = [
    [`${apiUrl}/images`, []],
    [`${apiUrl}/images/usage`, { count: 0, limit: 20, knownBytes: 0 }],
    [`${apiUrl}/images/registries`, []],
    [`${apiUrl}/volumes`, []],
    [`${apiUrl}/api-keys`, []],
    [`${apiUrl}/box/paginated`, { items: [], total: 0, totalPages: 0, page: 1, pageSize: 25 }],
    ['*/v1/config', { capabilities: { checkpoints_enabled: true, private_tunnels_enabled: true } }],
    ['*/v1/:organizationId/checkpoints', { checkpoints: [] }],
    [
      '*/v1/:organizationId/domains',
      { domains: [], limit: 5, used: 0, remaining: 5, min_length: 5, domain_suffix: 'apps.example' },
    ],
    [
      '*/v1/:organizationId/ci/runners',
      { items: [], total: 0, page: 1, totalPages: 0, capacity: { ...ciLimits, used: 0 } } satisfies CiRunners,
    ],
    ['*/v1/:organizationId/ci/settings', { ...ciLimits, connections: [] } satisfies CiSettings],
  ]
  return endpoints.map(([path, empty]) =>
    http.get(path, async () => {
      const preview = new URLSearchParams(window.location.search).get('preview')
      if (preview === 'resource-loading') await delay('infinite')
      if (preview === 'resource-error')
        return HttpResponse.json({ message: 'Preview service unavailable' }, { status: 503 })
      if (preview === 'resource-empty') return HttpResponse.json(empty)
      return undefined
    }),
  )
}
