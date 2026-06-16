#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appsBinPath = path.join(appsRoot, 'node_modules', '.bin')

// ── API environments ─────────────────────────────────────────────────────────
// Single source of truth: an API environment maps to a Vite `/api` proxy target.
// The dashboard always calls a SAME-ORIGIN `/api` path; Vite proxies it to the
// selected backend. The browser therefore never makes a cross-origin request, so
// CORS is out of the path (the proxy reaches the API server-to-server, where the
// browser's same-origin policy does not apply — so no backend has to allow-list
// localhost). Add an environment by adding a line here; `--api <url>` proxies to
// an arbitrary URL without touching this map.
const API_TARGETS = {
  local: 'http://localhost:3001',
  dev: 'https://dev.boxlite.ai',
  // prod: 'https://api.boxlite.ai', // placeholder — set the real prod API origin and
  //                                  // uncomment once the prod stage exists. Prod is
  //                                  // also guarded below (needs --yes-prod).
}

const targets = {
  dev: {
    label: `local dashboard + dev API via same-origin /api proxy → ${API_TARGETS.dev}`,
    proxyTarget: API_TARGETS.dev,
  },
  local: {
    label: `local dashboard + local API via /api proxy → ${API_TARGETS.local}`,
    proxyTarget: API_TARGETS.local,
  },
  dex: {
    label: `local dashboard + local API/Dex via /api proxy → ${API_TARGETS.local}`,
    proxyTarget: API_TARGETS.local,
  },
  prod: {
    label: 'local dashboard + PROD API (controlled)',
    proxyTarget: API_TARGETS.prod, // undefined until configured; guarded below
    prod: true,
  },
  mock: {
    label: 'local dashboard + MSW mocks (no backend, no login)',
    // MSW intercepts requests in the browser; keep the keys its handlers read.
    extraEnv: {
      VITE_BASE_API_URL: API_TARGETS.dev,
      VITE_API_URL: `${API_TARGETS.dev}/api`,
      VITE_ENABLE_MOCKING: 'true',
    },
  },
}

function parseArgs(argv) {
  let target = 'dev'
  let api
  let yesProd = false
  const forward = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      return { help: true, target, forward }
    }

    if (arg === '--target' || arg === '--env') {
      target = argv[i + 1] || target
      i += 1
      continue
    }

    if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length)
      continue
    }

    if (arg.startsWith('--env=')) {
      target = arg.slice('--env='.length)
      continue
    }

    if (arg === '--api') {
      api = argv[i + 1]
      i += 1
      continue
    }

    if (arg.startsWith('--api=')) {
      api = arg.slice('--api='.length)
      continue
    }

    if (arg === '--yes-prod') {
      yesProd = true
      continue
    }

    forward.push(arg)
  }

  return { help: false, target, api, yesProd, forward }
}

function printHelp() {
  console.log(`Usage:
  npm run start            # default → dev API (via same-origin /api proxy)
  npm run start:dev        # dev API
  npm run start:local      # local API (localhost:3001)
  npm run start:prod       # PROD API — controlled, requires --yes-prod
  npm run start:mock       # MSW mocks, no backend, no login
  npm run start:dex        # local API/Dex
  npm run start -- --api=https://any.example.com   # proxy to ANY API URL

How it works:
  The dashboard always calls a same-origin /api path. Vite proxies /api to the
  selected backend (server-to-server), so the browser never goes cross-origin and
  the backend never has to allow-list localhost — there is no CORS to configure.

Auth follows the API: login uses whatever OIDC issuer the selected API's
/api/config reports (dev → dev Auth0, prod → prod Auth0, …).`)
}

const { help, target, api, yesProd, forward } = parseArgs(process.argv.slice(2))

if (help) {
  printHelp()
  process.exit(0)
}

const selected = targets[target]
if (!selected) {
  console.error(`Unknown target "${target}". Use --help to see supported targets.`)
  process.exit(1)
}

// Resolve the proxy target: --api wins (arbitrary URL), else the env's mapping.
// Strip a trailing /api or / so it isn't doubled (Vite already mounts on /api).
const rawTarget = api || selected.proxyTarget
const proxyTarget = rawTarget ? rawTarget.replace(/\/api\/?$/, '').replace(/\/$/, '') : undefined

// PROD guard: real user data, and prod Auth0 would have to allow http://localhost:3000.
// Runs for ANY prod-target invocation — including `--api=<prod-url>`, which would
// otherwise bypass the confirmation. Only the "unconfigured" check depends on the
// built-in mapping (an explicit --api always supplies a target).
if (selected.prod) {
  if (!proxyTarget) {
    console.error('The "prod" API environment is not configured yet (no prod stage).')
    console.error('Set API_TARGETS.prod in apps/scripts/start-dashboard.mjs once prod exists.')
    process.exit(1)
  }
  if (!yesProd) {
    console.error('Refusing to connect to PROD by default.')
    console.error('PROD = real user data, and its Auth0 app must allow http://localhost:3000 (do not leave that on).')
    console.error('Re-run with --yes-prod if you really intend to.')
    process.exit(1)
  }
}

const env = {
  ...process.env,
  ...(selected.extraEnv || {}),
}

if (proxyTarget) {
  env.DASHBOARD_API_PROXY_TARGET = proxyTarget
  // Force a same-origin `/api` path: clear any inherited/exported VITE_BASE_API_URL
  // so ConfigProvider can't build a cross-origin apiUrl and bypass the proxy (which
  // would re-introduce the very CORS failure this proxy exists to avoid).
  env.VITE_BASE_API_URL = ''
}

env.PATH = [appsBinPath, process.env.PATH].filter(Boolean).join(path.delimiter)

const nxCommand = process.platform === 'win32' ? 'nx.cmd' : 'nx'
const args = ['serve', 'dashboard', ...forward]

console.log(`[dashboard] ${selected.label}`)
console.log(`[dashboard] /api proxied to: ${proxyTarget || '(none — MSW mocks / no backend)'}`)
console.log(`[dashboard] Command: ${nxCommand} ${args.join(' ')}`)

const child = spawn(nxCommand, args, {
  cwd: appsRoot,
  env,
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
