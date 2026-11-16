/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { http, HttpResponse } from 'msw'
import { BoxState } from '@boxlite-ai/api-client'
import type { CiSettings } from '@/api/ci-types'
import { buildBox, MOCK_BOXES, MOCK_PAGINATED_BOXES, MOCK_ORGANIZATION } from './fixtures'

export function ciHandlers() {
  const runners = [
    buildBox({
      id: 'mock-ci-jit-running',
      name: 'ci-jit-a01d14f3b3c843e19cf01accc01e8412',
      state: BoxState.STARTED,
      image: 'ghcr.io/actions/actions-runner:latest',
      cpu: 2,
      memory: 2,
    }),
    buildBox({
      id: 'mock-ci-jit-stopped',
      name: 'ci-jit-ef319e6cc54f479098aaea43d8e09315',
      state: BoxState.STOPPED,
      image: 'ghcr.io/actions/actions-runner:latest',
      cpu: 2,
      memory: 2,
    }),
  ]
  MOCK_BOXES.push(...runners)
  MOCK_PAGINATED_BOXES.total = MOCK_BOXES.length
  const settings: CiSettings = {
    available: true,
    commerce_limit: 5,
    effective_limit: 3,
    max_concurrent_jobs: 3,
    connections: [
      {
        binding_id: '7a71466e-cfaa-432a-95a5-c257114d9a05',
        installation_id: 11,
        installation_settings_url: 'https://github.com/settings/installations/11',
        github_account: 'demo-developer',
        account_type: 'User',
        listener_status: 'ready',
        allow_private_repositories: false,
      },
      {
        binding_id: '6811d928-552b-4583-8766-44fcba0a3749',
        installation_id: 11,
        installation_settings_url: 'https://github.com/settings/installations/11',
        github_account: 'demo-organization',
        account_type: 'Organization',
        listener_status: 'provisioning',
        allow_private_repositories: false,
      },
    ],
  }
  const base = '*/v1/:organizationId/ci'
  const own = (organizationId: unknown) =>
    organizationId === MOCK_ORGANIZATION.id ||
    (import.meta.env.VITE_MOCK_MULTIPLE_ORGANIZATIONS === 'true' &&
      ['demo-acme', 'demo-research'].includes(String(organizationId)))
  const missing = () => new HttpResponse(null, { status: 404 })
  const preview = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview')
  const emptyPreview = () =>
    globalThis.localStorage?.getItem('desktop-review-empty') === '1' || preview() === 'ci-empty'
  return [
    http.get(`${base}/settings`, ({ params }) =>
      own(params.organizationId)
        ? HttpResponse.json({ ...settings, connections: emptyPreview() ? [] : settings.connections })
        : missing(),
    ),
    http.get(`${base}/runners`, ({ params, request }) => {
      if (!own(params.organizationId)) return missing()
      const query = new URL(request.url).searchParams
      const page = Math.max(1, Number(query.get('page')) || 1),
        limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 25))
      const name = (query.get('name') ?? '').trim().toLowerCase()
      const visible = emptyPreview() ? [] : runners
      const filtered = visible.filter((runner) => runner.name.toLowerCase().includes(name))
      return HttpResponse.json({
        items: filtered.slice((page - 1) * limit, page * limit),
        total: filtered.length,
        page,
        totalPages: Math.ceil(filtered.length / limit),
        capacity: {
          available: settings.available,
          used: visible.length,
          max_concurrent_jobs: settings.max_concurrent_jobs,
          commerce_limit: settings.commerce_limit,
          effective_limit: settings.effective_limit,
        },
      })
    }),
    http.get(`${base}/connections/:bindingId/repositories`, ({ params, request }) => {
      if (!own(params.organizationId)) return missing()
      const connection = settings.connections.find((row) => row.binding_id === params.bindingId)
      if (!connection) return missing()
      const query = new URL(request.url).searchParams
      const page = Math.max(1, Number(query.get('page')) || 1)
      const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 25))
      const names =
        preview() === 'ci-repositories'
          ? Array.from({ length: 30 }, (_, index) => `release-validation-integration-pipeline-${index + 1}`)
          : ['web-app', 'agent-runtime', 'internal-tools']
      const repositories = names.map((name, index) => ({
        id: connection.account_type === 'User' ? index + 1 : index + 101,
        name,
        private: index === 2,
        owner: { id: connection.account_type === 'User' ? 1 : 2, login: connection.github_account },
      }))
      return HttpResponse.json({
        repositories: repositories.slice((page - 1) * limit, page * limit),
        total: repositories.length,
        page,
        next_page: page * limit < repositories.length ? page + 1 : null,
        repository_selection: 'selected',
        installation_settings_url: connection.installation_settings_url,
      })
    }),
    http.get(`${base}/connect/configuration`, ({ params }) =>
      own(params.organizationId)
        ? HttpResponse.json({
            apps: [
              { account_type: 'User', web_connect_available: false },
              { account_type: 'Organization', web_connect_available: false },
            ],
          })
        : missing(),
    ),
    http.patch(`${base}/settings`, async ({ params, request }) => {
      if (!own(params.organizationId)) return missing()
      const { max_concurrent_jobs: maximum } = (await request.json()) as { max_concurrent_jobs: number | null }
      if (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 5))
        return HttpResponse.json({ message: 'Invalid account capacity' }, { status: 400 })
      settings.max_concurrent_jobs = maximum
      settings.effective_limit = maximum ?? settings.commerce_limit
      return HttpResponse.json(settings)
    }),
    http.patch(`${base}/connections/:bindingId`, async ({ params, request }) => {
      if (!own(params.organizationId)) return missing()
      const row = settings.connections.find((connection) => connection.binding_id === params.bindingId)
      if (!row) return missing()
      const body = (await request.json()) as { allow_private_repositories: boolean }
      if (typeof body.allow_private_repositories !== 'boolean') return new HttpResponse(null, { status: 400 })
      if (row.allow_private_repositories !== body.allow_private_repositories) {
        row.allow_private_repositories = body.allow_private_repositories
        row.listener_status = 'provisioning'
      }
      return new HttpResponse(null, { status: 204 })
    }),
    http.delete(`${base}/connections/:bindingId`, ({ params }) => {
      if (!own(params.organizationId)) return missing()
      settings.connections = settings.connections.filter((row) => row.binding_id !== params.bindingId)
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}
