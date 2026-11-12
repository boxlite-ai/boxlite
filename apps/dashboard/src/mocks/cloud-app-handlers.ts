/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { http, HttpResponse } from 'msw'
import { nameProblem } from '@/lib/apps/format'
import type { AppDetail, AppRelease } from '@/lib/apps/types'
import { MOCK_ORGANIZATION_ID } from './fixtures'

function draftApp(name: string): AppDetail {
  return {
    id: name,
    appId: `app_mock_${name}`,
    name,
    slug: name,
    url: `https://${name}.apps.example`,
    visibility: 'private',
    status: 'draft',
    lastDeploy: null,
    resources: { database: false, storage: 0, users: null },
    createdAt: new Date().toISOString(),
    environment: 'main',
    createdFrom: null,
    runtime: null,
    box: null,
    services: [],
    activeRelease: null,
    releases: [],
    activity: [],
    database: null,
    storages: [],
    secrets: [],
    variables: null,
    platformVariables: [],
    problems: [],
    statusDetail: null,
    deploying: null,
    schedules: [],
    liveVariables: null,
    metrics: null,
    preview: null,
    previewAttempt: null,
    handoffPrompt: `Build ${name} with BoxLite Apps. Sign in to boxlite-app with an organization API key, then run boxlite-app init --app ${name}.`,
    accessSource: 'manifest',
    specVersion: null,
    auth: {
      declared: false,
      providers: [],
      protect: [],
      enforced: false,
      methods: [],
      loginUrl: `https://${name}.apps.example/__boxlite/auth/login`,
      users: 0,
      note: null,
    },
    domains: { supported: true, target: null, list: [] },
  }
}

export function cloudAppHandlers() {
  const live = draftApp('demo-shop')
  const deployedAt = new Date(Date.now() - 3_600_000).toISOString()
  const release: AppRelease = {
    id: '#1',
    number: 1,
    summary: 'Deploy the storefront',
    createdAt: deployedAt,
    startedAt: deployedAt,
    finishedAt: deployedAt,
    by: 'console',
    status: 'live',
    current: true,
    steps: ['Provision', 'Build', 'Start', 'Health check'].map((name) => ({ name, status: 'done', ms: 1200 })),
    changes: ['+ service.web', '+ database'],
    files: 12,
    bytes: 24576,
    buildSeconds: 8,
    hasSource: false,
    rollback: { possible: false, reason: 'This is the first deployment.' },
    restorePoint: null,
    running: null,
    cause: null,
  }
  Object.assign(live, {
    status: 'live',
    lastDeploy: { releaseId: release.id, at: deployedAt, by: release.by },
    resources: { database: true, storage: 0, users: 0 },
    runtime: { image: 'node:24-slim', size: 'small', cpus: 1, memoryMib: 1024 },
    box: { id: 'mock-box-running', state: 'started' },
    activeRelease: release.id,
    releases: [release],
    services: [
      {
        name: 'web',
        command: ['node', 'server.js'],
        exposed: true,
        port: 3000,
        healthPath: '/health',
        state: 'running',
        health: 'healthy',
        restarts: 0,
        memoryBytes: 52_428_800,
        recentErrors: [],
      },
    ],
    database: {
      status: 'ready',
      engine: 'PostgreSQL',
      host: 'demo.neon.example',
      name: 'neondb',
      user: 'app',
      branch: 'main',
      injectedAs: 'DATABASE_URL',
      injectedInto: ['web'],
    },
    variables: { NODE_ENV: 'production', LOG_LEVEL: 'info' },
    liveVariables: { NODE_ENV: 'production', LOG_LEVEL: 'info' },
    specVersion: 1,
  } satisfies Partial<AppDetail>)
  live.auth.methods = ['github', 'google'].map((provider) => ({
    provider,
    label: provider === 'github' ? 'GitHub' : 'Google',
    status: 'ready',
    declared: false,
    redirectUri: `https://api.example.test/internal/apps/auth/callback/${provider}`,
    keys: 'shared',
    clientId: null,
    managedAvailable: true,
  }))
  const apps = new Map([live, draftApp('starter')].map((app) => [app.id, app]))
  const base = `*/v1/${MOCK_ORGANIZATION_ID}/apps`
  const missing = () => HttpResponse.json({ error: { code: 'not_found', message: 'App not found.' } }, { status: 404 })

  return [
    http.get(base, () => HttpResponse.json([...apps.values()].map((app) => ({ ...app, environments: 1 })))),
    http.get(`${base}/deleted`, () => HttpResponse.json([])),
    http.post(base, async ({ request }) => {
      const { name } = (await request.json()) as { name: string }
      const problem = typeof name === 'string' ? nameProblem(name) : 'An App name is required.'
      if (problem) return HttpResponse.json({ error: { message: problem } }, { status: 400 })
      if (apps.has(name)) return HttpResponse.json({ error: { message: 'That App name is taken.' } }, { status: 409 })
      const app = draftApp(name)
      apps.set(app.id, app)
      return HttpResponse.json({ app, prompt: app.handoffPrompt }, { status: 201 })
    }),
    http.get(`${base}/:app/:section`, ({ params }) => {
      const app = apps.get(String(params.app))
      if (!app) return missing()
      switch (params.section) {
        case 'view':
          return HttpResponse.json(app)
        case 'environments':
          return HttpResponse.json([
            {
              name: 'main',
              status: app.status,
              url: app.url,
              box: app.box?.id ?? null,
              lastDeploy: app.lastDeploy,
              from: null,
            },
          ])
        case 'auth':
          return HttpResponse.json({ status: app.auth, users: [], events: [] })
        case 'database':
          return HttpResponse.json(
            app.database
              ? {
                  ...app.database,
                  sizeBytes: 65_536,
                  tables: [],
                  migrations: [],
                  backups: [],
                  restoreWindowHours: 24,
                  errors: [],
                }
              : { status: 'none' },
          )
        case 'logs':
          return HttpResponse.json(
            app.status === 'live'
              ? [
                  {
                    id: 'mock-log-1',
                    ts: deployedAt,
                    source: 'web',
                    level: 'info',
                    line: 'Storefront ready on port 3000',
                    deployment: 1,
                  },
                ]
              : [],
          )
        case 'secrets':
          return HttpResponse.json([])
        case 'handoff':
          return HttpResponse.json({ prompt: app.handoffPrompt })
        default:
          return new HttpResponse(null, { status: 404 })
      }
    }),
    http.get(`${base}/:app/deployments/:number`, ({ params }) => {
      const app = apps.get(String(params.app))
      const release = app?.releases.find((release) => release.number === Number(params.number))
      if (!release) return missing()
      return HttpResponse.json({
        ...release,
        message: release.summary,
        specVersion: 1,
        baseVersion: 0,
        snapshotId: null,
        rollbackTo: null,
        timeline: release.steps.map((step) => ({
          ...step,
          ms: step.ms ?? null,
          detail: null,
          startedAt: release.startedAt,
          finishedAt: release.finishedAt,
        })),
        log: [],
        logTruncated: false,
        changeSet: { infrastructure: release.changes, configuration: [], code: null },
        failure: null,
      })
    }),
    http.all(`${base}/*`, () =>
      HttpResponse.json(
        {
          error: {
            code: 'preview_read_only',
            message: 'This action requires a live Cloud Apps API.',
          },
        },
        { status: 501 },
      ),
    ),
  ]
}
