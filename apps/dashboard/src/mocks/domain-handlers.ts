/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { http, HttpResponse } from 'msw'
import type { HeldDomain } from '@/api/domain-types'

export function domainHandlers() {
  const byOrganization = new Map<string, HeldDomain[]>()
  const domainsFor = (organizationId: string) => {
    if (!byOrganization.has(organizationId))
      byOrganization.set(organizationId, [
        {
          hostname: 'demo-web.apps.example',
          url: 'https://demo-web.apps.example',
          target: { type: 'box', box: 'mock-box-running', port: 3000 },
        },
        {
          hostname: 'demo-shop.apps.example',
          url: 'https://demo-shop.apps.example',
          target: { type: 'app', app: 'demo-shop' },
        },
        { hostname: 'spare-name.apps.example', url: 'https://spare-name.apps.example', target: null },
      ])
    return byOrganization.get(organizationId)!
  }
  return [
    http.get('*/v1/:organizationId/domains', ({ params }) => {
      const domains =
        globalThis.localStorage?.getItem('desktop-review-empty') === '1'
          ? []
          : domainsFor(String(params.organizationId))
      return HttpResponse.json({
        domains,
        limit: 5,
        used: domains.length,
        remaining: Math.max(0, 5 - domains.length),
        min_length: 5,
        domain_suffix: 'apps.example',
      })
    }),
    http.post('*/v1/:organizationId/domains', async ({ params, request }) => {
      const { name } = (await request.json()) as { name: string }
      const label = name.trim().toLowerCase()
      if (label.length < 5 || label.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))
        return HttpResponse.json({ message: 'Use a short name with 5–63 letters, digits or hyphens.' }, { status: 400 })
      const hostname = `${label}.apps.example`
      const domains = domainsFor(String(params.organizationId))
      const existing = domains.find((domain) => domain.hostname === hostname)
      if (existing) return HttpResponse.json(existing, { status: 201 })
      if (domains.length >= 5) return HttpResponse.json({ message: 'Domain limit reached.' }, { status: 400 })
      const domain = { hostname, url: `https://${hostname}`, target: null }
      domains.push(domain)
      return HttpResponse.json(domain, { status: 201 })
    }),
  ]
}
