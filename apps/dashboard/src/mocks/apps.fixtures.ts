/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Mock data for the Apps surface (product_design/PRD/AgentCloud/FullStack/02).
// Five apps cover the states the list renders differently: live behind a
// login, live and public, a draft nothing has been deployed to, one asleep,
// and one whose service keeps crashing. Mutations below edit this array in
// place so the pages behave across a session.

import type {
  AppDetail,
  AppSummary,
  AppVisibility,
  CreateAppInput,
  AppRelease,
  AppActivity,
  AppStatus,
  AppAuth,
  UpdateAuthInput,
  EnvironmentSummary,
  AppActionInput,
  PendingChange,
} from '@/lib/apps/types'
import { describeChange, methodId } from '@/lib/apps/types'

const nowDate = new Date()
const iso = (d: Date) => d.toISOString()
const minutesAgo = (m: number) => iso(new Date(nowDate.getTime() - m * 60_000))
const hoursAgo = (h: number) => iso(new Date(nowDate.getTime() - h * 3_600_000))
const daysAgo = (d: number) => iso(new Date(nowDate.getTime() - d * 86_400_000))

const ORG_SLUG = 'acme'
const APP_DOMAIN = 'boxlite.app'

const urlFor = (slug: string, visibility: AppVisibility, primary: string | null = null) =>
  visibility === 'private' ? null : `https://${primary ?? `${slug}.${APP_DOMAIN}`}`

function handoffPrompt(name: string, env = 'production') {
  const flag = env === 'production' ? '' : ` --env ${env}`
  return [
    `Continue working on the BoxLite app "${name}" (org ${ORG_SLUG}${env === 'production' ? '' : `, environment ${env}`}). Read https://boxlite.ai/agent.md first.`,
    `Deploy with \`boxlite deploy ./ --app ${name}${flag}\`, then confirm with \`boxlite app inspect ${name}${flag} --json\`.`,
    `BOXLITE_REST_URL=https://api.boxlite.ai`,
    `BOXLITE_API_KEY=bxl_sk_mock_••••••••••••••••`,
  ].join('\n')
}

/** Every app starts with Google and GitHub sign-in on BoxLite's shared keys. */
function defaultAuth(domain: string): AppAuth {
  const base = `https://${domain}/.boxlite/auth`
  return {
    methods: [
      { provider: 'google', keys: 'shared' },
      { provider: 'github', keys: 'shared' },
    ],
    sessionTtl: '24h',
    loginUrl: `${base}/login`,
    callbackUrl: `${base}/callback`,
    allowedEmails: [],
    allowSignups: true,
    requireVerifiedEmail: true,
    smtp: null,
    users: [],
    events: [],
  }
}
function release(
  id: string,
  overrides: Partial<AppRelease> & Pick<AppRelease, 'createdAt' | 'by' | 'status'>,
): AppRelease {
  return {
    id,
    files: 128,
    bytes: 6_700_000,
    prepareSeconds: 41,
    log: [
      `> stage ${id}: 128 files, 6.7 MB uploaded`,
      '> commit: manifest sha256 verified (128/128)',
      '> prepare: npm ci',
      'added 312 packages in 28s',
      '> prepare: npm run build',
      'vite v6.0.3 building for production...',
      '✓ 41 modules transformed. dist/ written in 9.8s',
      `> activate: /home/boxlite/app -> .boxlite/releases/${id}`,
      '> restart web: pid 412 (exit 0 -> start)',
      '> health: GET /healthz 200 after 1.2 s',
    ],
    ...overrides,
  }
}

function activity(entries: [string, string, string, string?][]): AppActivity[] {
  return entries.map(([at, actor, action, detail], i) => ({ id: `act-${i}`, at, actor, action, detail }))
}

const okCheck = (summary: string, detail: string) => ({ ok: true, summary, detail })

// Hourly series for the last 24 h, oldest first. Deterministic so screenshots
// are stable between reloads.
function series(base: number, swing: number, seed: number, spikeAt?: number, spike = 0): number[] {
  return Array.from({ length: 24 }, (_, i) => {
    const wave = Math.sin((i + seed) / 3.1) * swing + Math.cos((i * 7 + seed) / 5) * (swing / 3)
    return Math.max(0, Math.round(base + wave + (spikeAt === i ? spike : 0)))
  })
}

const NO_TRAFFIC = { requests: [], errors: [], p95Ms: [], activeUsers: [] }

export const MOCK_APPS: AppDetail[] = [
  {
    id: 'app-7f3k2m',
    environment: 'production',
    name: 'crm',
    slug: 'crm-acme',
    url: urlFor('crm-acme', 'users'),
    visibility: 'users',
    status: 'live',
    lastDeploy: { releaseId: '#42', at: minutesAgo(3), by: 'ci-key' },
    resources: { database: true, storage: 1, users: 17 },
    createdAt: daysAgo(3),
    image: 'node',
    region: 'us',
    activeRelease: '#42',
    preview: { src: '/mock/app-shots/crm.jpg', capturedAt: minutesAgo(2), releaseId: '#42' },
    services: [
      {
        name: 'web',
        command: ['node', 'server.js'],
        port: 3000,
        healthPath: '/healthz',
        restart: 'always',
        state: 'running',
        pid: 412,
        restarts: 0,
        lastExitCode: 0,
        health: 'healthy',
      },
      {
        name: 'worker',
        command: ['node', 'worker.js'],
        restart: 'on-failure',
        state: 'running',
        pid: 418,
        restarts: 2,
        lastExitCode: 1,
        health: 'none',
      },
    ],
    releases: [
      release('#42', {
        summary: 'Drag deals between pipeline stages',
        createdAt: minutesAgo(3),
        by: 'ci-key',
        status: 'active',
      }),
      release('#41', {
        summary: 'Import contacts from CSV',
        createdAt: daysAgo(2),
        by: 'claude-key',
        status: 'previous',
        files: 127,
        bytes: 6_600_000,
      }),
      release('#40', {
        summary: 'Upgrade to Vite 6',
        createdAt: daysAgo(3),
        by: 'claude-key',
        status: 'failed',
        files: 120,
        bytes: 6_100_000,
        prepareSeconds: undefined,
        error: 'prepare failed: npm ci exited 1 (ERESOLVE unable to resolve dependency tree)',
        log: [
          '> stage #40: 120 files, 6.1 MB uploaded',
          '> commit: manifest sha256 verified (120/120)',
          '> prepare: npm ci',
          'npm ERR! code ERESOLVE',
          'npm ERR! ERESOLVE unable to resolve dependency tree',
          'npm ERR! peer react@"^18" from react-dom@18.3.1',
          '> prepare failed (exit 1) — release not activated; #39 still serves',
        ],
      }),
    ],
    activity: activity([
      [minutesAgo(3), 'ci-key', 'deploy', '#42 activated, web restarted'],
      [hoursAgo(5), 'claude-key', 'secrets', 'referenced org/stripe-live as STRIPE_KEY (env)'],
      [daysAgo(1), 'markov', 'publish', 'visibility org → users'],
      [daysAgo(2), 'claude-key', 'deploy', '#41 activated'],
      [daysAgo(2), 'claude-key', 'auth', 'enabled google, github'],
      [daysAgo(3), 'claude-key', 'add volume', 'uploads (private)'],
      [daysAgo(3), 'claude-key', 'add database', 'app_7f3k2m on db.us'],
      [daysAgo(3), 'claude-key', 'create', 'image node, 2 cpu / 4 GiB'],
    ]),
    database: {
      status: 'ready',
      engine: 'postgres 16',
      region: 'us',
      sizeBytes: 38_000_000,
      host: 'db.us.boxlite.ai',
      name: 'app_7f3k2m',
      user: 'crm_owner',
      injectedAs: 'DATABASE_URL',
      injectedInto: ['web', 'worker'],
      tables: [
        { schema: 'boxlite', name: 'users', rows: 17 },
        { schema: 'public', name: 'accounts', rows: 240 },
        { schema: 'public', name: 'contacts', rows: 1_203 },
        { schema: 'public', name: 'deals', rows: 318 },
        { schema: 'public', name: 'notes', rows: 2_940 },
        { schema: 'public', name: 'schema_migrations', rows: 3 },
      ],
      migrations: [
        { file: '0003_add_deals.sql', appliedIn: '#42', at: minutesAgo(3) },
        { file: '0002_contacts.sql', appliedIn: '#41', at: daysAgo(2) },
        { file: '0001_init.sql', appliedIn: '#39', at: daysAgo(3) },
      ],
      backups: [
        { at: hoursAgo(9), bytes: 38_000_000 },
        { at: hoursAgo(33), bytes: 37_000_000 },
        { at: hoursAgo(57), bytes: 36_000_000 },
      ],
    },
    storages: [
      {
        name: 'uploads',
        public: false,
        sizeBytes: 1_288_000_000,
        objects: 2_418,
        envPrefix: 'STORAGE_UPLOADS',
        mountPath: '/data/uploads',
        keys: [{ id: 'bak_crm_uploads_01', createdAt: daysAgo(3), lastUsedAt: minutesAgo(12) }],
      },
    ],
    auth: {
      methods: [
        { provider: 'google', keys: 'shared' },
        { provider: 'github', keys: 'own', clientId: 'Iv1.8a61f9b3c2d4e5f6' },
      ],
      sessionTtl: '24h',
      loginUrl: 'https://crm-acme.boxlite.app/.boxlite/auth/login',
      callbackUrl: 'https://crm-acme.boxlite.app/.boxlite/auth/callback',
      allowedEmails: ['*@acme.com'],
      allowSignups: true,
      requireVerifiedEmail: true,
      smtp: null,
      events: [
        {
          at: minutesAgo(40),
          kind: 'login',
          provider: 'github',
          email: 'b.ortiz@acme.com',
          detail: 'session issued (24h)',
        },
        { at: hoursAgo(1), kind: 'login', provider: 'google', email: 'a.lin@acme.com', detail: 'session issued (24h)' },
        {
          at: hoursAgo(6),
          kind: 'signup',
          provider: 'github',
          email: 'e.moss@acme.com',
          detail: 'first sign-in, mirrored to boxlite.users',
        },
        {
          at: hoursAgo(9),
          kind: 'blocked',
          provider: 'google',
          email: 'x.wang@gmail.com',
          detail: 'not in allowed emails (*@acme.com)',
        },
        {
          at: daysAgo(1),
          kind: 'callback_mismatch',
          provider: 'google',
          detail:
            'provider sent https://crm.acme.com/.boxlite/auth/callback; registered callback is https://crm-acme.boxlite.app/.boxlite/auth/callback',
        },
      ],
      users: [
        { email: 'a.lin@acme.com', provider: 'google', firstSeen: daysAgo(2), lastSeen: hoursAgo(1), sessions: 2 },
        { email: 'b.ortiz@acme.com', provider: 'github', firstSeen: daysAgo(2), lastSeen: minutesAgo(40), sessions: 1 },
        { email: 'c.wu@acme.com', provider: 'google', firstSeen: daysAgo(1), lastSeen: daysAgo(1), sessions: 0 },
        { email: 'd.kaur@acme.com', provider: 'google', firstSeen: hoursAgo(20), lastSeen: hoursAgo(3), sessions: 1 },
        { email: 'e.moss@acme.com', provider: 'github', firstSeen: hoursAgo(6), lastSeen: hoursAgo(6), sessions: 1 },
      ],
    },
    secrets: [
      { name: 'STRIPE_KEY', from: 'org/stripe-live', version: 3, inject: 'env', usedBy: ['web', 'worker'] },
      {
        name: 'OPENAI_KEY',
        from: 'org/openai',
        version: 1,
        inject: 'placeholder',
        hosts: ['api.openai.com'],
        usedBy: ['worker'],
      },
    ],
    domains: {
      slug: 'crm-acme',
      defaultDomain: 'crm-acme.boxlite.app',
      custom: [
        {
          domain: 'crm.acme.com',
          status: 'pending',
          tls: 'pending',
          cname: 'crm-acme.boxlite.app',
          addedAt: daysAgo(1),
          lastCheckedAt: minutesAgo(4),
          lastCheck: 'NXDOMAIN at the authoritative nameserver (ns1.acme.com)',
        },
      ],
      primary: null,
    },
    workspace: {
      boxId: 'mock-box-running',
      boxName: 'web-api',
      boxState: 'running',
      image: 'ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0',
      cpu: 2,
      memory: 4,
      disk: 10,
      region: 'us',
      ports: [
        { port: 3000, visibility: 'users', url: 'https://crm-acme.boxlite.app', service: 'web' },
        { port: 5173, visibility: 'private', url: 'https://5173-d-6d6f636b.proxy.boxlite.ai' },
      ],
      env: { NODE_ENV: 'production', DATA_DIR: '/data/uploads', LOG_LEVEL: 'info' },
    },
    reachability: {
      published: okCheck('users', 'Signed-in users reach it; everyone else gets the login page.'),
      listening: okCheck('web :3000', 'GET /healthz → 200 (1.2 s ago)'),
      routed: okCheck('crm-acme.boxlite.app → web-api', 'Route propagated to 2 proxies.'),
    },
    metrics: {
      previousRequests: 11800,
      requests: series(420, 160, 2),
      errors: series(2, 2, 5),
      p95Ms: series(180, 40, 9),
      activeUsers: series(6, 3, 1),
    },
    logs: {
      web: [
        `${minutesAgo(1)} GET /api/deals 200 41ms user=a.lin@acme.com`,
        `${minutesAgo(2)} GET /api/contacts?page=3 200 88ms user=b.ortiz@acme.com`,
        `${minutesAgo(3)} [boot] listening on :3000 (release #42)`,
        `${minutesAgo(3)} [boot] DATABASE_URL ok, 6 tables`,
      ],
      worker: [
        `${minutesAgo(5)} sync: 12 deals updated`,
        `${hoursAgo(2)} worker exited 1 (ECONNRESET api.openai.com) — restarted in 40 ms (restart 2/10)`,
        `${hoursAgo(2)} sync: started`,
      ],
      deploy: [
        `${minutesAgo(3)} #42 activated by ci-key (41 s prepare)`,
        `${daysAgo(2)} #41 activated by claude-key (39 s prepare)`,
        `${daysAgo(3)} #40 FAILED: npm ci exited 1`,
      ],
      auth: [
        `${minutesAgo(40)} login ok provider=github sub=gh:88213 email=b.ortiz@acme.com`,
        `${hoursAgo(1)} login ok provider=google email=a.lin@acme.com`,
        `${daysAgo(1)} callback mismatch: provider sent https://crm.acme.com/.boxlite/auth/callback, registered callback is https://crm-acme.boxlite.app/.boxlite/auth/callback`,
      ],
      db: [
        `${minutesAgo(3)} migration 0003_add_deals.sql applied in 120 ms`,
        `${hoursAgo(9)} backup completed (38 MB)`,
      ],
      system: [`${minutesAgo(3)} release #42 activated`, `${daysAgo(1)} visibility changed org → users by markov`],
    },
    handoffPrompt: handoffPrompt('crm'),
  },
  {
    id: 'app-2q9x1c',
    environment: 'production',
    name: 'fleet-board',
    slug: 'fleet',
    url: urlFor('fleet', 'public', 'board.fleetco.io'),
    visibility: 'public',
    status: 'live',
    lastDeploy: { releaseId: '#7', at: daysAgo(2), by: 'codex-key' },
    resources: { database: true, storage: 0, users: 0 },
    createdAt: daysAgo(12),
    image: 'node',
    region: 'us',
    activeRelease: '#7',
    preview: { src: '/mock/app-shots/fleet-board.jpg', capturedAt: daysAgo(2), releaseId: '#7' },
    services: [
      {
        name: 'web',
        command: ['node', '.next/standalone/server.js'],
        port: 3000,
        healthPath: '/api/health',
        restart: 'always',
        state: 'running',
        pid: 388,
        restarts: 0,
        lastExitCode: 0,
        health: 'healthy',
      },
    ],
    releases: [
      release('#7', {
        summary: 'Live map with vehicle status',
        createdAt: daysAgo(2),
        by: 'codex-key',
        status: 'active',
        files: 412,
        bytes: 24_000_000,
      }),
      release('#6', {
        summary: 'Vehicle list with delay badges',
        createdAt: daysAgo(6),
        by: 'codex-key',
        status: 'previous',
        files: 409,
        bytes: 23_800_000,
      }),
    ],
    activity: activity([
      [daysAgo(2), 'codex-key', 'deploy', '#7 activated'],
      [daysAgo(6), 'codex-key', 'deploy', '#6 activated'],
      [daysAgo(11), 'markov', 'publish', 'visibility org → public'],
      [daysAgo(12), 'codex-key', 'create', 'image node'],
    ]),
    database: {
      status: 'ready',
      engine: 'postgres 16',
      region: 'us',
      sizeBytes: 12_000_000,
      host: 'db.us.boxlite.ai',
      name: 'app_2q9x1c',
      user: 'fleet_owner',
      injectedAs: 'DATABASE_URL',
      injectedInto: ['web'],
      tables: [
        { schema: 'public', name: 'snapshots', rows: 96 },
        { schema: 'public', name: 'issues', rows: 1_840 },
      ],
      migrations: [{ file: '0001_init.sql', appliedIn: '#1', at: daysAgo(12) }],
      backups: [{ at: hoursAgo(10), bytes: 12_000_000 }],
    },
    storages: [],
    auth: defaultAuth('fleet.boxlite.app'),
    secrets: [{ name: 'LINEAR_CLIENT_SECRET', from: 'org/linear', version: 1, inject: 'env', usedBy: ['web'] }],
    domains: {
      slug: 'fleet',
      defaultDomain: 'fleet.boxlite.app',
      custom: [
        {
          domain: 'board.fleetco.io',
          status: 'verified',
          tls: 'issued',
          cname: 'fleet.boxlite.app',
          addedAt: daysAgo(6),
          lastCheckedAt: hoursAgo(2),
          lastCheck: 'CNAME board.fleetco.io → fleet.boxlite.app · certificate issued',
        },
      ],
      primary: 'board.fleetco.io',
    },
    workspace: {
      boxId: 'mock-box-agent-1',
      boxName: 'agile-otter',
      boxState: 'running',
      image: 'ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0',
      cpu: 1,
      memory: 2,
      disk: 10,
      region: 'us',
      ports: [{ port: 3000, visibility: 'public', url: 'https://fleet.boxlite.app', service: 'web' }],
      env: { NODE_ENV: 'production' },
    },
    reachability: {
      published: okCheck('public', 'Anyone can open it.'),
      listening: okCheck('web :3000', 'GET /api/health → 200 (0.4 s ago)'),
      routed: okCheck('fleet.boxlite.app → agile-otter', 'Route propagated.'),
    },
    metrics: {
      previousRequests: 2050,
      requests: series(90, 40, 4),
      errors: series(0, 1, 2),
      p95Ms: series(120, 30, 3),
      activeUsers: [],
    },
    logs: {
      web: [`${minutesAgo(1)} GET / 200 22ms`, `${daysAgo(2)} [boot] listening on :3000 (release #7)`],
      deploy: [`${daysAgo(2)} #7 activated by codex-key`],
      system: [`${daysAgo(11)} visibility changed org → public by markov`],
    },
    handoffPrompt: handoffPrompt('fleet-board'),
  },
  {
    id: 'app-9z0p4d',
    environment: 'production',
    name: 'scratch',
    slug: 'scratch-acme',
    url: null,
    visibility: 'private',
    status: 'draft',
    lastDeploy: null,
    resources: { database: false, storage: 0, users: 0 },
    createdAt: minutesAgo(25),
    image: 'python',
    region: 'us',
    activeRelease: null,
    preview: null,
    services: [],
    releases: [],
    activity: activity([[minutesAgo(25), 'markov', 'create', 'image python, 1 cpu / 1 GiB']]),
    database: null,
    storages: [],
    auth: defaultAuth('scratch-acme.boxlite.app'),
    secrets: [],
    domains: { slug: 'scratch-acme', defaultDomain: 'scratch-acme.boxlite.app', custom: [], primary: null },
    workspace: {
      boxId: 'mock-box-pulling',
      boxName: 'eager-lynx',
      boxState: 'starting',
      image: 'ghcr.io/boxlite-ai/boxlite-agent-python:v0.1.0',
      cpu: 1,
      memory: 1,
      disk: 10,
      region: 'us',
      ports: [],
      env: {},
    },
    reachability: {
      published: {
        ok: false,
        summary: 'not published',
        detail: 'The URL is reserved but nothing is exposed yet.',
        fixPrompt: `Deploy BoxLite app "scratch" and publish it: \`boxlite deploy ./ --app scratch\` then \`boxlite app publish scratch --visibility org\`.`,
      },
      listening: {
        ok: false,
        summary: 'no service declared',
        detail: 'boxlite.toml has no [service.*] section, so nothing listens on a port.',
        fixPrompt: `Add a [service.web] section (command, port, health) to boxlite.toml for BoxLite app "scratch" and deploy.`,
      },
      routed: { ok: false, summary: 'no route', detail: 'Routes are created on first publish.' },
    },
    metrics: NO_TRAFFIC,
    logs: { system: [`${minutesAgo(25)} app created by markov`] },
    handoffPrompt: handoffPrompt('scratch'),
  },
  {
    id: 'app-5h8v2n',
    environment: 'production',
    name: 'reports',
    slug: 'reports-acme',
    url: urlFor('reports-acme', 'org'),
    visibility: 'org',
    status: 'sleeping',
    lastDeploy: { releaseId: '#3', at: daysAgo(9), by: 'claude-key' },
    resources: { database: true, storage: 1, users: 0 },
    createdAt: daysAgo(20),
    image: 'python',
    region: 'us',
    activeRelease: '#3',
    preview: { src: '/mock/app-shots/reports.jpg', capturedAt: daysAgo(9), releaseId: '#3' },
    services: [
      {
        name: 'web',
        command: ['uvicorn', 'app:api', '--port', '8000'],
        port: 8000,
        healthPath: '/health',
        restart: 'always',
        state: 'stopped',
        restarts: 0,
        lastExitCode: 0,
        health: 'none',
      },
    ],
    releases: [
      release('#3', {
        summary: 'Weekly report: regions table',
        createdAt: daysAgo(9),
        by: 'claude-key',
        status: 'active',
        files: 64,
        bytes: 2_100_000,
      }),
      release('#2', {
        summary: 'First weekly report',
        createdAt: daysAgo(14),
        by: 'claude-key',
        status: 'previous',
        files: 60,
        bytes: 2_000_000,
      }),
    ],
    activity: activity([
      [daysAgo(1), 'system', 'sleep', 'idle 30 min, box stopped'],
      [daysAgo(9), 'claude-key', 'deploy', '#3 activated'],
      [daysAgo(20), 'claude-key', 'create', 'image python'],
    ]),
    database: {
      status: 'ready',
      engine: 'postgres 16',
      region: 'us',
      sizeBytes: 210_000_000,
      host: 'db.us.boxlite.ai',
      name: 'app_5h8v2n',
      user: 'reports_owner',
      injectedAs: 'DATABASE_URL',
      injectedInto: ['web'],
      tables: [
        { schema: 'public', name: 'runs', rows: 14_200 },
        { schema: 'public', name: 'metrics', rows: 1_980_000 },
      ],
      migrations: [{ file: '0001_init.sql', appliedIn: '#1', at: daysAgo(20) }],
      backups: [{ at: hoursAgo(8), bytes: 210_000_000 }],
    },
    storages: [
      {
        name: 'exports',
        public: true,
        sizeBytes: 5_400_000_000,
        objects: 912,
        envPrefix: 'STORAGE_EXPORTS',
        publicUrlBase: 'https://reports-acme.boxlite.app/_storage/exports/',
        keys: [{ id: 'bak_reports_exports_01', createdAt: daysAgo(20), lastUsedAt: daysAgo(1) }],
      },
    ],
    auth: defaultAuth('reports-acme.boxlite.app'),
    secrets: [],
    domains: { slug: 'reports-acme', defaultDomain: 'reports-acme.boxlite.app', custom: [], primary: null },
    workspace: {
      boxId: 'mock-box-stopped',
      boxName: 'batch-worker',
      boxState: 'stopped',
      image: 'ghcr.io/boxlite-ai/boxlite-agent-python:v0.1.0',
      cpu: 2,
      memory: 4,
      disk: 20,
      region: 'us',
      ports: [{ port: 8000, visibility: 'org', url: 'https://reports-acme.boxlite.app', service: 'web' }],
      env: { PYTHONUNBUFFERED: '1' },
    },
    reachability: {
      published: okCheck('org members', 'Teammates sign in with BoxLite; others get the login page.'),
      listening: {
        ok: true,
        summary: 'asleep',
        detail: 'Box stopped after 30 min idle. The first request wakes it and restarts web (≈3 s).',
      },
      routed: okCheck('reports-acme.boxlite.app → batch-worker', 'Route kept while asleep.'),
    },
    metrics: {
      previousRequests: 98,
      requests: series(8, 6, 7),
      errors: series(0, 0, 0),
      p95Ms: series(260, 60, 2),
      activeUsers: [],
    },
    logs: {
      web: [`${daysAgo(1)} [stop] SIGTERM (box auto-stop)`, `${daysAgo(9)} [boot] uvicorn on :8000 (release #3)`],
      deploy: [`${daysAgo(9)} #3 activated by claude-key`],
      system: [`${daysAgo(1)} box stopped: idle 30 min`],
    },
    handoffPrompt: handoffPrompt('reports'),
  },
  {
    id: 'app-3c6r8t',
    environment: 'production',
    name: 'ops-bot',
    slug: 'ops-bot',
    url: urlFor('ops-bot', 'org'),
    visibility: 'org',
    status: 'failed',
    lastDeploy: { releaseId: '#5', at: hoursAgo(1), by: 'claude-key' },
    resources: { database: false, storage: 0, users: 0 },
    createdAt: daysAgo(4),
    image: 'node',
    region: 'us',
    activeRelease: '#5',
    preview: null,
    services: [
      {
        name: 'web',
        command: ['node', 'bot.js'],
        port: 8080,
        healthPath: '/healthz',
        restart: 'on-failure',
        state: 'failed',
        restarts: 10,
        lastExitCode: 1,
        health: 'unhealthy',
      },
    ],
    releases: [
      release('#5', {
        summary: 'Post deploy alerts to #ops',
        createdAt: hoursAgo(1),
        by: 'claude-key',
        status: 'active',
        files: 31,
        bytes: 480_000,
        log: [
          '> stage #5: 31 files, 480 KB uploaded',
          '> commit: manifest sha256 verified (31/31)',
          '> prepare: npm ci — added 48 packages in 6s',
          '> activate: /home/boxlite/app -> .boxlite/releases/#5',
          '> restart web: pid 501',
          'web exited 1: Error: SLACK_TOKEN is not set',
          '> health: GET /healthz connection refused (10/10 retries) — restart budget exhausted',
        ],
      }),
      release('#4', {
        summary: 'Slack bot answers /status',
        createdAt: daysAgo(1),
        by: 'claude-key',
        status: 'previous',
        files: 30,
        bytes: 470_000,
      }),
    ],
    activity: activity([
      [hoursAgo(1), 'system', 'failed', 'web restart budget exhausted (10 in 5 min), last exit 1'],
      [hoursAgo(1), 'claude-key', 'deploy', '#5 activated'],
      [daysAgo(1), 'claude-key', 'deploy', '#4 activated'],
      [daysAgo(4), 'claude-key', 'create', 'image node'],
    ]),
    database: null,
    storages: [],
    auth: defaultAuth('ops-bot.boxlite.app'),
    secrets: [],
    domains: {
      slug: 'ops-bot',
      defaultDomain: 'ops-bot.boxlite.app',
      custom: [],
      primary: null,
    },
    workspace: {
      boxId: 'mock-box-error',
      boxName: 'flaky-job',
      boxState: 'running',
      image: 'ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0',
      cpu: 1,
      memory: 1,
      disk: 10,
      region: 'us',
      ports: [{ port: 8080, visibility: 'org', url: 'https://ops-bot.boxlite.app', service: 'web' }],
      env: { NODE_ENV: 'production' },
    },
    reachability: {
      published: okCheck('share link', 'Holders of the signed link reach it until it expires (6 d left).'),
      listening: {
        ok: false,
        summary: 'web failed',
        detail: 'web exited 1 ten times in 5 min: "SLACK_TOKEN is not set". Restart budget exhausted.',
        fixPrompt: `BoxLite app "ops-bot" fails to start: web exits with "SLACK_TOKEN is not set" (see \`boxlite app logs ops-bot --source web\`). Reference the org secret slack-bot as SLACK_TOKEN in boxlite.toml [secrets] and redeploy, or roll back with \`boxlite app rollback ops-bot\`.`,
      },
      routed: okCheck(
        'ops-bot.boxlite.app → flaky-job',
        'Route exists; visitors get 503 Retry-After while web is down.',
      ),
    },
    metrics: {
      previousRequests: 1400,
      requests: series(60, 20, 3, 22, 140),
      errors: series(1, 1, 1, 22, 130),
      p95Ms: series(90, 20, 6, 22, 900),
      activeUsers: [],
    },
    logs: {
      web: [
        `${hoursAgo(1)} web exited 1: Error: SLACK_TOKEN is not set`,
        `${hoursAgo(1)} restart 10/10 in window — giving up (state: failed)`,
        `${hoursAgo(1)} [boot] release #5`,
      ],
      deploy: [`${hoursAgo(1)} #5 activated by claude-key — web did not become healthy`],
      system: [`${hoursAgo(1)} app marked FAILED`],
    },
    handoffPrompt: handoffPrompt('ops-bot'),
  },
]

// ── accessors and mutations used by the MSW handlers ───────────────────────

// Every other environment is a full record of its own (box, database, user
// pool, volumes, domains, variables, deployments) for an app in MOCK_APPS.
// The mock addresses one by "<appId>@<env>"; production is the bare app id.
const ENV_SEP = '@'

export function envKey(appId: string, env: string | null | undefined): string {
  return !env || env === 'production' ? appId : `${appId}${ENV_SEP}${env}`
}

function stagingOf(appId: string): AppDetail {
  const prod = MOCK_APPS.find((app) => app.id === appId) as AppDetail
  const env: AppDetail = structuredClone(prod)
  const slug = `${prod.name}-staging-${ORG_SLUG}`
  env.environment = 'staging'
  env.createdFrom = 'production'
  env.slug = slug
  env.visibility = 'org'
  env.url = `https://${slug}.${APP_DOMAIN}`
  env.domains = { slug, defaultDomain: `${slug}.${APP_DOMAIN}`, custom: [], primary: null }
  env.releases = [
    release('#12', {
      summary: 'New survey editor',
      createdAt: minutesAgo(20),
      by: 'claude-key',
      status: 'active',
    }),
    release('#11', {
      summary: 'Editor: autosave drafts',
      createdAt: hoursAgo(5),
      by: 'claude-key',
      status: 'previous',
    }),
  ]
  env.activeRelease = '#12'
  env.lastDeploy = { releaseId: '#12', at: minutesAgo(20), by: 'claude-key' }
  env.preview = prod.preview && { ...prod.preview, releaseId: '#12', capturedAt: minutesAgo(19) }
  env.workspace = { ...env.workspace, boxId: 'mock-box-agent-2', boxName: 'quiet-heron', boxState: 'running' }
  env.auth.users = [
    { email: 'qa@acme.com', provider: 'google', firstSeen: daysAgo(1), lastSeen: minutesAgo(15), sessions: 1 },
    { email: 'a.lin@acme.com', provider: 'github', firstSeen: hoursAgo(4), lastSeen: hoursAgo(4), sessions: 0 },
  ]
  env.auth.events = []
  env.resources = { ...env.resources, users: env.auth.users.length }
  if (env.database) {
    env.database.tables = env.database.tables.map((t) => ({ ...t, rows: Math.min(t.rows, 12) }))
    env.database.backups = []
  }
  env.storages = env.storages.map((b) => ({ ...b, sizeBytes: 4_200_000, objects: 18 }))
  env.metrics = {
    previousRequests: Math.round((prod.metrics.previousRequests ?? 0) / 40),
    requests: prod.metrics.requests.map((n) => Math.round(n / 40)),
    errors: prod.metrics.errors.map(() => 0),
    p95Ms: prod.metrics.p95Ms,
    activeUsers: prod.metrics.activeUsers.map((n) => Math.min(n, 2)),
  }
  env.activity = [
    { id: 'st-2', at: minutesAgo(20), actor: 'claude-key', action: 'deploy', detail: '#12 · new survey editor' },
    {
      id: 'st-1',
      at: daysAgo(1),
      actor: 'markov',
      action: 'create environment',
      detail: 'from production · config and schema',
    },
  ]
  env.handoffPrompt = handoffPrompt(prod.name, 'staging')
  return env
}

export const MOCK_ENVS: AppDetail[] = [stagingOf('app-7f3k2m')]

function envsOf(appId: string): AppDetail[] {
  return MOCK_ENVS.filter((env) => env.id === appId)
}

export function listEnvironments(idOrSlug: string): EnvironmentSummary[] | undefined {
  const prod = findApp(idOrSlug)
  if (!prod) return undefined
  return [prod, ...envsOf(prod.id)].map((env) => ({
    name: env.environment,
    status: env.status,
    url: env.url,
    box: env.workspace.boxName,
    lastDeploy: env.lastDeploy,
    from: env.createdFrom ?? null,
  }))
}

/**
 * A new environment is a new set of resources. Copying takes configuration and
 * structure (variables, secrets, sign-in methods, database schema, volume
 * names) from the source; data (rows, users, files) is never copied.
 */
export function createEnvironment(
  idOrSlug: string,
  input: { name: string; from: string | null },
): AppDetail | { error: string } {
  const prod = findApp(idOrSlug)
  if (!prod) return { error: 'App not found' }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.name)) return { error: 'Use lowercase letters, digits and dashes.' }
  if (input.name === 'production' || envsOf(prod.id).some((e) => e.environment === input.name)) {
    return { error: `${prod.name} already has an environment named ${input.name}.` }
  }
  const source = input.from ? findApp(envKey(prod.id, input.from)) : null
  const base: AppDetail = structuredClone(source ?? prod)
  const slug = `${prod.name}-${input.name}-${ORG_SLUG}`
  const env: AppDetail = {
    ...base,
    environment: input.name,
    createdFrom: input.from,
    slug,
    url: null,
    visibility: 'private',
    status: 'draft',
    lastDeploy: null,
    createdAt: new Date().toISOString(),
    services: [],
    activeRelease: null,
    preview: null,
    releases: [],
    activity: [
      {
        id: 'act-0',
        at: new Date().toISOString(),
        actor: 'markov',
        action: 'create environment',
        detail: input.from ? `from ${input.from} · config and schema` : 'empty',
      },
    ],
    database: source?.database
      ? {
          ...source.database,
          status: 'provisioning',
          sizeBytes: 0,
          name: `app_${prod.id.slice(4)}_${input.name}`,
          tables: source.database.tables.map((t) => ({ ...t, rows: 0 })),
          backups: [],
        }
      : null,
    storages: source ? source.storages.map((b) => ({ ...b, sizeBytes: 0, objects: 0, keys: [] })) : [],
    auth: { ...defaultAuth(`${slug}.${APP_DOMAIN}`), ...(source ? { methods: source.auth.methods } : {}) },
    secrets: source ? source.secrets : [],
    domains: { slug, defaultDomain: `${slug}.${APP_DOMAIN}`, custom: [], primary: null },
    workspace: {
      ...base.workspace,
      boxId: 'mock-box-pulling',
      boxName: `${prod.name}-${input.name}`,
      boxState: 'starting',
      ports: [],
      env: source ? source.workspace.env : {},
    },
    reachability: {
      published: { ok: false, summary: 'not published', detail: 'Nothing is deployed to this environment yet.' },
      listening: { ok: false, summary: 'no service running', detail: 'The first deployment starts the services.' },
      routed: { ok: false, summary: 'no route', detail: 'Routes are created on first publish.' },
    },
    metrics: NO_TRAFFIC,
    logs: {},
    handoffPrompt: handoffPrompt(prod.name, input.name),
  }
  env.resources = { database: !!env.database, storage: env.storages.length, users: 0 }
  MOCK_ENVS.push(env)
  pushActivity(prod, 'markov', 'create environment', `${input.name}${input.from ? ` from ${input.from}` : ''}`)
  return env
}

export function deleteEnvironment(idOrSlug: string, name: string): boolean {
  const prod = findApp(idOrSlug)
  if (!prod || name === 'production') return false
  const at = MOCK_ENVS.findIndex((e) => e.id === prod.id && e.environment === name)
  if (at === -1) return false
  MOCK_ENVS.splice(at, 1)
  pushActivity(prod, 'markov', 'delete environment', name)
  return true
}

/** Variables and secret references only; values stay what the source has. */
export function copyVariables(key: string, from: string): AppDetail | undefined {
  const target = findApp(key)
  if (!target) return undefined
  const source = findApp(envKey(target.id, from))
  if (!source) return target
  baseline(target)
  target.workspace.env = { ...source.workspace.env }
  target.secrets = structuredClone(source.secrets)
  pushActivity(target, 'markov', 'variables', `copied from ${from}`)
  restage(target)
  return target
}

export function toSummary(app: AppDetail): AppSummary {
  const { id, name, slug, url, visibility, status, lastDeploy, resources, createdAt } = app
  const broken = (['listening', 'published', 'routed'] as const).find((k) => !app.reachability[k].ok)
  const attention =
    app.status === 'failed' && broken
      ? `${app.reachability[broken].summary}: ${app.reachability[broken].detail}`
      : undefined
  return {
    id,
    name,
    slug,
    url,
    visibility,
    status,
    lastDeploy,
    resources,
    createdAt,
    environments: 1 + envsOf(id).length,
    attention,
  }
}

export function listAppSummaries(): AppSummary[] {
  return MOCK_APPS.map(toSummary)
}

export function findApp(idOrSlug: string): AppDetail | undefined {
  const [app, env] = idOrSlug.split(ENV_SEP)
  const prod = MOCK_APPS.find((a) => a.id === app || a.slug === app || a.name === app)
  if (!env || !prod) return prod
  return MOCK_ENVS.find((e) => e.id === prod.id && e.environment === env)
}

function pushActivity(app: AppDetail, actor: string, action: string, detail?: string) {
  app.activity.unshift({ id: `act-${Date.now()}`, at: new Date().toISOString(), actor, action, detail })
}

export function publishApp(idOrSlug: string, visibility: AppVisibility): AppDetail | undefined {
  const app = findApp(idOrSlug)
  if (!app) return undefined
  const previous = app.visibility
  app.visibility = visibility
  app.url = urlFor(app.domains.slug, visibility, app.domains.primary)
  app.workspace.ports = app.workspace.ports.map((port) => (port.service ? { ...port, visibility } : port))
  if (app.status !== 'draft') {
    app.reachability.published =
      visibility === 'private'
        ? { ok: false, summary: 'not published', detail: 'The app is reachable only with an API key or preview token.' }
        : okCheck(
            visibility,
            visibility === 'public'
              ? 'Anyone can open it.'
              : visibility === 'users'
                ? 'Signed-in users reach it; everyone else gets the login page.'
                : visibility === 'org'
                  ? 'Teammates sign in with BoxLite; others get the login page.'
                  : 'Holders of the signed link reach it until it expires.',
          )
  }
  pushActivity(app, 'markov', 'publish', `visibility ${previous} → ${visibility}`)
  return app
}

export function activateRelease(idOrSlug: string, releaseId: string): AppDetail | undefined {
  const app = findApp(idOrSlug)
  if (!app) return undefined
  const target = app.releases.find((r) => r.id === releaseId)
  if (!target || target.status === 'failed') return app
  for (const r of app.releases) {
    if (r.status === 'active') r.status = 'previous'
  }
  target.status = 'active'
  app.activeRelease = releaseId
  // The proxy recaptures the page once the release serves; the mock reuses the image.
  if (app.preview) app.preview = { ...app.preview, releaseId, capturedAt: new Date().toISOString() }
  app.lastDeploy = { releaseId, at: new Date().toISOString(), by: 'markov' }
  for (const service of app.services) {
    service.state = 'running'
    service.health = service.port ? 'healthy' : 'none'
    service.pid = 400 + Math.floor(Math.random() * 200)
  }
  if (app.status === 'failed') {
    app.status = 'live'
    app.reachability.listening = okCheck(
      `${app.services[0]?.name ?? 'web'} :${app.services[0]?.port ?? ''}`,
      'Healthy after rollback.',
    )
  }
  pushActivity(app, 'markov', 'rollback', `${releaseId} activated, services restarted`)
  return app
}

export function restartApp(idOrSlug: string, service?: string): AppDetail | undefined {
  const app = findApp(idOrSlug)
  if (!app) return undefined
  for (const s of app.services) {
    if (service && s.name !== service) continue
    s.restarts += 1
    s.state = 'running'
    s.pid = 400 + Math.floor(Math.random() * 200)
  }
  pushActivity(app, 'markov', 'restart', service ?? 'all services')
  return app
}

export function setAppStatus(idOrSlug: string, status: AppStatus, actor = 'markov'): AppDetail | undefined {
  const app = findApp(idOrSlug)
  if (!app) return undefined
  app.status = status
  pushActivity(app, actor, status === 'sleeping' ? 'sleep' : status, undefined)
  return app
}

export function updateAuth(idOrSlug: string, input: UpdateAuthInput): AppDetail | undefined {
  const app = findApp(idOrSlug)
  if (!app) return undefined
  const auth = app.auth
  if (input.upsertMethod) {
    const id = methodId(input.upsertMethod)
    const at = auth.methods.findIndex((m) => methodId(m) === id)
    if (at >= 0) auth.methods[at] = input.upsertMethod
    else auth.methods.push(input.upsertMethod)
    pushActivity(app, 'markov', 'auth', `${at >= 0 ? 'updated' : 'added'} ${id} (${input.upsertMethod.keys} keys)`)
  }
  // Login is always on, so the last method cannot go.
  if (input.removeMethod && auth.methods.length > 1) {
    auth.methods = auth.methods.filter((m) => methodId(m) !== input.removeMethod)
    pushActivity(app, 'markov', 'auth', `removed ${input.removeMethod}`)
  }
  if (input.allowedEmails) auth.allowedEmails = input.allowedEmails
  if (input.sessionTtl) auth.sessionTtl = input.sessionTtl
  if (input.allowSignups !== undefined) auth.allowSignups = input.allowSignups
  if (input.requireVerifiedEmail !== undefined) auth.requireVerifiedEmail = input.requireVerifiedEmail
  if (input.smtp !== undefined) auth.smtp = input.smtp
  if (!input.upsertMethod && !input.removeMethod) pushActivity(app, 'markov', 'auth', 'login settings changed')
  return app
}

export function updateDomains(
  idOrSlug: string,
  input: {
    slug?: string
    addDomain?: string
    removeDomain?: string
    verifyDomain?: string
    makePrimary?: string | null
  },
): AppDetail | undefined {
  const app = findApp(idOrSlug)
  if (!app) return undefined
  const d = app.domains
  if (input.slug && input.slug !== d.slug) {
    const old = d.defaultDomain
    d.slug = input.slug
    d.defaultDomain = `${input.slug}.${APP_DOMAIN}`
    for (const c of d.custom) c.cname = d.defaultDomain
    pushActivity(app, 'markov', 'domain', `${old} → ${d.defaultDomain}`)
  }
  if (input.addDomain) {
    d.custom.push({
      domain: input.addDomain,
      status: 'pending',
      tls: 'none',
      cname: d.defaultDomain,
      addedAt: new Date().toISOString(),
    })
    pushActivity(app, 'markov', 'domain', `added ${input.addDomain}, waiting for CNAME`)
  }
  if (input.removeDomain) {
    d.custom = d.custom.filter((c) => c.domain !== input.removeDomain)
    if (d.primary === input.removeDomain) d.primary = null
    pushActivity(app, 'markov', 'domain', `removed ${input.removeDomain}`)
  }
  if (input.makePrimary !== undefined) {
    d.primary = input.makePrimary
    pushActivity(app, 'markov', 'domain', `primary domain → ${input.makePrimary ?? d.defaultDomain}`)
  }
  if (input.verifyDomain) {
    const c = d.custom.find((x) => x.domain === input.verifyDomain)
    if (c) {
      c.lastCheckedAt = new Date().toISOString()
      // The mock verifies on the second check so the pending → verified transition is visible.
      if (c.lastCheck) {
        c.status = 'verified'
        c.tls = 'issued'
        c.lastCheck = `CNAME ${c.domain} → ${c.cname} · certificate issued`
        pushActivity(app, 'system', 'domain', `${c.domain} verified, certificate issued`)
        // The first domain the customer brings becomes the one the app is presented under.
        if (!d.primary) d.primary = c.domain
      } else {
        c.lastCheck = 'NXDOMAIN at the authoritative nameserver'
      }
    }
  }
  // The app's URL follows the primary domain; an unpublished app stays without one.
  if (app.url) app.url = urlFor(d.slug, app.visibility, d.primary)
  return app
}

/** The operations behind the App screens' buttons. Each edits one environment in place. */
// Variable edits are saved at once but only reach the running app with the next
// deployment. The values the running deployment uses are kept per environment;
// what is pending is always the net difference from them.
const deployedVars = new Map<string, Record<string, string>>()
const SECRET_MARK = '\u0000secret:'

function varsOf(app: AppDetail): Record<string, string> {
  return {
    ...app.workspace.env,
    ...Object.fromEntries(app.secrets.map((s) => [s.name, `${SECRET_MARK}${s.from} · v${s.version}`])),
  }
}

/** Call before changing variables, so the first edit has something to differ from. */
function baseline(app: AppDetail) {
  const key = envKey(app.id, app.environment)
  if (!deployedVars.has(key)) deployedVars.set(key, varsOf(app))
}

function restage(app: AppDetail) {
  const live = deployedVars.get(envKey(app.id, app.environment)) ?? varsOf(app)
  const saved = varsOf(app)
  const show = (value: string) => (value.startsWith(SECRET_MARK) ? value.slice(SECRET_MARK.length) : value)
  const changes: PendingChange[] = []
  for (const [name, value] of Object.entries(saved)) {
    if (!(name in live)) changes.push({ name, change: 'added', secret: value.startsWith(SECRET_MARK) })
    else if (live[name] !== value)
      changes.push({ name, change: 'changed', live: show(live[name]), secret: live[name].startsWith(SECRET_MARK) })
  }
  for (const [name, value] of Object.entries(live)) {
    if (!(name in saved))
      changes.push({ name, change: 'removed', live: show(value), secret: value.startsWith(SECRET_MARK) })
  }
  app.pendingChanges = changes
}

function deployChanges(app: AppDetail) {
  const changes = app.pendingChanges ?? []
  const active = app.releases.find((r) => r.status === 'active')
  const next = `#${Math.max(0, ...app.releases.map((r) => Number(r.id.slice(1)) || 0)) + 1}`
  for (const r of app.releases) if (r.status === 'active') r.status = 'previous'
  const at = new Date().toISOString()
  app.releases = [
    {
      id: next,
      summary: `Apply ${changes.length} variable ${changes.length === 1 ? 'change' : 'changes'}`,
      createdAt: at,
      by: 'markov',
      files: active?.files ?? 0,
      bytes: active?.bytes ?? 0,
      prepareSeconds: 4,
      status: 'active',
      envChanges: changes,
      log: [
        `[deploy] same source as ${active?.id ?? 'previous'}`,
        ...changes.map((c) => `[env] ${describeChange(c)}`),
        '[deploy] services restarted, health check passed',
      ],
    },
    ...app.releases,
  ]
  app.activeRelease = next
  app.lastDeploy = { releaseId: next, at, by: 'markov' }
  if (app.preview) app.preview = { ...app.preview, releaseId: next, capturedAt: at }
  deployedVars.set(envKey(app.id, app.environment), varsOf(app))
  app.pendingChanges = []
  pushActivity(app, 'markov', 'deploy', `${next}: ${changes.map(describeChange).join(', ')}`)
}

export function runAction(key: string, action: AppActionInput): AppDetail | { error: string } {
  const app = findApp(key)
  if (!app) return { error: 'App not found' }
  const now = new Date().toISOString()
  const touchesVariables = ['setVariable', 'removeVariable', 'importVariables', 'referenceSecret'].includes(action.type)
  if (touchesVariables) baseline(app)
  const result = applyAction(app, action, now)
  if (touchesVariables && !('error' in result)) restage(app)
  return result
}

function applyAction(app: AppDetail, action: AppActionInput, now: string): AppDetail | { error: string } {
  switch (action.type) {
    case 'setVariable': {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(action.name)) return { error: 'Use UPPER_SNAKE_CASE for variable names.' }
      const existed = action.name in app.workspace.env
      app.workspace.env = { ...app.workspace.env, [action.name]: action.value }
      pushActivity(app, 'markov', 'variables', `${existed ? 'changed' : 'added'} ${action.name}`)
      return app
    }
    case 'removeVariable': {
      const { [action.name]: _removed, ...rest } = app.workspace.env
      void _removed
      app.workspace.env = rest
      app.secrets = app.secrets.filter((secret) => secret.name !== action.name)
      pushActivity(app, 'markov', 'variables', `removed ${action.name}`)
      return app
    }
    case 'importVariables': {
      app.workspace.env = { ...app.workspace.env, ...action.values }
      // A pasted plain value replaces a secret reference of the same name.
      app.secrets = app.secrets.filter((secret) => !(secret.name in action.values))
      pushActivity(app, 'markov', 'variables', `imported ${Object.keys(action.values).length} from .env`)
      return app
    }
    case 'referenceSecret': {
      app.secrets = [
        ...app.secrets.filter((secret) => secret.name !== action.name),
        {
          name: action.name,
          from: action.from,
          version: 1,
          inject: action.inject,
          hosts: action.hosts,
          usedBy: ['web'],
        },
      ]
      pushActivity(app, 'markov', 'variables', `referenced ${action.from} as ${action.name}`)
      return app
    }
    case 'createBackup': {
      if (!app.database) return { error: 'No database to back up.' }
      app.database.backups = [
        { at: now, bytes: app.database.sizeBytes || 4_000_000, manual: true },
        ...app.database.backups,
      ]
      pushActivity(app, 'markov', 'backup', 'manual backup taken')
      return app
    }
    case 'attachDatabase': {
      if (app.database) return app
      app.database = {
        status: 'ready',
        engine: 'postgres 16',
        region: app.region,
        sizeBytes: 0,
        host: `db.${app.region}.boxlite.ai`,
        name: `app_${app.id.slice(4)}`,
        user: `${app.name}_owner`,
        injectedAs: 'DATABASE_URL',
        injectedInto: app.services.map((service) => service.name),
        tables: [{ schema: 'boxlite', name: 'users', rows: app.auth.users.length }],
        migrations: [],
        backups: [],
      }
      app.resources = { ...app.resources, database: true }
      pushActivity(app, 'markov', 'database', 'attached postgres 16')
      return app
    }
    case 'rotateDatabasePassword': {
      pushActivity(app, 'markov', 'database', 'password rotated; the old one stays valid for 10 minutes')
      return app
    }
    case 'signOutUser': {
      const user = app.auth.users.find((u) => u.email === action.email)
      if (user) user.sessions = 0
      pushActivity(app, 'markov', 'auth', `signed out ${action.email} everywhere`)
      return app
    }
    case 'blockUser': {
      const user = app.auth.users.find((u) => u.email === action.email)
      if (user) {
        user.blocked = action.blocked
        if (action.blocked) user.sessions = 0
      }
      pushActivity(app, 'markov', 'auth', `${action.blocked ? 'blocked' : 'unblocked'} ${action.email}`)
      return app
    }
    case 'rotateVolumeKey': {
      const bucket = app.storages.find((b) => b.name === action.bucket)
      if (bucket) {
        const n = bucket.keys.length + 1
        bucket.keys = [{ id: `bak_${app.name}_${bucket.name}_${String(n).padStart(2, '0')}`, createdAt: now }]
      }
      pushActivity(app, 'markov', 'volume', `rotated the access key for ${action.bucket}`)
      return app
    }
    case 'setVolumePublic': {
      const bucket = app.storages.find((b) => b.name === action.bucket)
      if (bucket) bucket.public = action.public
      pushActivity(app, 'markov', 'volume', `${action.bucket} is now ${action.public ? 'public read' : 'private'}`)
      return app
    }
    case 'deployChanges': {
      if (!app.pendingChanges?.length) return app
      deployChanges(app)
      return app
    }
  }
}

/** Renaming keeps the id and the URL; the slug is changed separately, in Domains. */
export function renameApp(idOrSlug: string, name: string): AppDetail | undefined {
  const app = findApp(idOrSlug)
  if (!app || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return app
  pushActivity(app, 'markov', 'rename', `${app.name} → ${name}`)
  // The name belongs to the app, so every environment carries it.
  for (const env of [app, ...envsOf(app.id)]) env.name = name
  return app
}

export function deleteApp(idOrSlug: string): boolean {
  const index = MOCK_APPS.findIndex((app) => app.id === idOrSlug || app.slug === idOrSlug)
  if (index === -1) return false
  const [app] = MOCK_APPS.splice(index, 1)
  // Deleting the app deletes every environment it has.
  for (const env of envsOf(app.id)) MOCK_ENVS.splice(MOCK_ENVS.indexOf(env), 1)
  return true
}

export function createApp(input: CreateAppInput): AppDetail {
  // A new app is only a name and a reserved URL. No box, database or bucket exists until the
  // agent's first deploy creates what its boxlite.toml declares, so nothing runs or bills yet.
  const [cpu, memory, disk] = [0, 0, 0]
  const slug = `${input.name}-${ORG_SLUG}`
  const id = `app-${Math.random().toString(36).slice(2, 8)}`
  // The draft app is the template for a new one: same empty shape, new identity.
  const draft = MOCK_APPS.find((app) => app.status === 'draft') ?? MOCK_APPS[0]
  const app: AppDetail = {
    ...draft,
    id,
    environment: 'production',
    name: input.name,
    slug,
    url: null,
    visibility: 'private',
    status: 'draft',
    lastDeploy: null,
    resources: { database: false, storage: 0, users: 0 },
    createdAt: new Date().toISOString(),
    image: 'set on first deploy',
    auth: defaultAuth(`${slug}.${APP_DOMAIN}`),
    services: [],
    releases: [],
    activity: [
      {
        id: 'act-0',
        at: new Date().toISOString(),
        actor: 'markov',
        action: 'create',
        detail: `${input.name}; URL reserved, nothing provisioned yet`,
      },
    ],
    database: null,
    storages: [],
    secrets: [],
    domains: { slug, defaultDomain: `${slug}.${APP_DOMAIN}`, custom: [], primary: null },
    workspace: {
      ...draft.workspace,
      boxId: '',
      boxName: input.name,
      boxState: 'stopped',
      image: 'set on first deploy',
      cpu,
      memory,
      disk,
      ports: [],
      env: {},
    },
    reachability: {
      published: {
        ok: false,
        summary: 'not published',
        detail: 'The URL is reserved but nothing is exposed yet.',
        fixPrompt: `Deploy BoxLite app "${input.name}" and publish it: \`boxlite deploy ./ --app ${input.name}\` then \`boxlite app publish ${input.name} --visibility org\`.`,
      },
      listening: {
        ok: false,
        summary: 'no service declared',
        detail: 'boxlite.toml has no [service.*] section, so nothing listens on a port.',
        fixPrompt: `Add a [service.web] section (command, port, health) to boxlite.toml for BoxLite app "${input.name}" and deploy.`,
      },
      routed: { ok: false, summary: 'no route', detail: 'Routes are created on first publish.' },
    },
    metrics: NO_TRAFFIC,
    logs: { system: [`${new Date().toISOString()} app created by markov`] },
    handoffPrompt: handoffPrompt(input.name),
  }
  MOCK_APPS.unshift(app)
  return app
}

/** Plausible rows for browsing a table in the mock. */
function sampleRows(table: string, count: number): { columns: string[]; rows: (string | number)[][] } {
  const people = ['a.lin', 'b.ortiz', 'c.wu', 'd.kaur', 'e.moss', 'f.ng', 'g.silva', 'h.berg']
  const companies = [
    'Northwind',
    'Globex',
    'Initech',
    'Umbrella',
    'Stark Logistics',
    'Wayne Retail',
    'Hooli',
    'Soylent',
  ]
  const at = (i: number) => new Date(Date.now() - i * 3_600_000 * 7).toISOString().slice(0, 16).replace('T', ' ')
  const n = Array.from({ length: count }, (_, i) => i)
  switch (table) {
    case 'users':
      return {
        columns: ['id', 'email', 'provider', 'created_at'],
        rows: n.map((i) => [`u_${1000 + i}`, `${people[i % 8]}@acme.com`, i % 2 ? 'github' : 'google', at(i)]),
      }
    case 'contacts':
      return {
        columns: ['id', 'name', 'email', 'company', 'created_at'],
        rows: n.map((i) => [
          i + 1,
          people[i % 8],
          `${people[i % 8]}@${companies[i % 8].toLowerCase().replace(/ /g, '')}.com`,
          companies[i % 8],
          at(i),
        ]),
      }
    case 'deals':
      return {
        columns: ['id', 'title', 'stage', 'amount', 'owner'],
        rows: n.map((i) => [
          i + 1,
          `${companies[i % 8]} renewal`,
          ['lead', 'qualified', 'proposal', 'won'][i % 4],
          (i + 3) * 1250,
          people[i % 8],
        ]),
      }
    case 'accounts':
      return {
        columns: ['id', 'name', 'plan', 'seats'],
        rows: n.map((i) => [i + 1, companies[i % 8], i % 3 ? 'team' : 'enterprise', 5 + i * 3]),
      }
    case 'notes':
      return {
        columns: ['id', 'deal_id', 'author', 'body'],
        rows: n.map((i) => [i + 1, (i % 7) + 1, people[i % 8], 'Followed up on pricing; sending a revised quote.']),
      }
    default:
      return { columns: ['version', 'applied_at'], rows: n.map((i) => [`000${i + 1}`, at(i * 10)]) }
  }
}

export function runSql(
  idOrSlug: string,
  query: string,
): { columns: string[]; rows: (string | number)[][]; total?: number } {
  const app = findApp(idOrSlug)
  const q = query.trim().toLowerCase()
  if (!app?.database) return { columns: ['error'], rows: [['no database attached']] }
  if (q.startsWith('explain')) {
    const table = app.database.tables.find((t) => q.includes(t.name))
    return {
      columns: ['QUERY PLAN'],
      rows: [
        [
          `Seq Scan on ${table?.name ?? 'users'}  (cost=0.00..${((table?.rows ?? 20) / 10).toFixed(2)} rows=${table?.rows ?? 20} width=64)`,
        ],
        ['Planning Time: 0.081 ms'],
        ['Execution Time: 0.214 ms'],
      ],
    }
  }
  const browse = q.match(/^select\s+\*\s+from\s+(?:(\w+)\.)?(\w+)/)
  if (browse) {
    const table = app.database.tables.find((t) => t.name === browse[2])
    if (table) {
      const limit = Number(q.match(/limit\s+(\d+)/)?.[1] ?? 20)
      const offset = Number(q.match(/offset\s+(\d+)/)?.[1] ?? 0)
      const needle = q.match(/ilike\s+'%(.*?)%'/)?.[1]
      const all = sampleRows(table.name, Math.min(table.rows, 2000))
      const rows = needle ? all.rows.filter((row) => row.join(' ').toLowerCase().includes(needle)) : all.rows
      return { columns: all.columns, rows: rows.slice(offset, offset + limit), total: rows.length }
    }
  }
  if (q.startsWith('select count')) {
    const table = app.database.tables.find((t) => q.includes(t.name))
    return { columns: ['count'], rows: [[table?.rows ?? 0]] }
  }
  if (q.includes('boxlite.users')) {
    return {
      columns: ['id', 'email', 'provider', 'last_seen'],
      rows: app.auth.users.slice(0, 5).map((u, i) => [`u_${1000 + i}`, u.email, u.provider, u.lastSeen]),
    }
  }
  return {
    columns: ['schema', 'table', 'rows'],
    rows: app.database.tables.map((t) => [t.schema, t.name, t.rows]),
  }
}
