#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appsBinPath = path.join(appsRoot, 'node_modules', '.bin')

const targets = {
  dev: {
    label: 'local dashboard + dev Auth0/dev API',
    env: {
      VITE_BASE_API_URL: 'https://dev.boxlite.ai',
    },
  },
  auth0: {
    label: 'local dashboard + dev Auth0/dev API',
    env: {
      VITE_BASE_API_URL: 'https://dev.boxlite.ai',
    },
  },
  mock: {
    label: 'local dashboard + dev Auth0/dev API + MSW billing mocks',
    env: {
      VITE_BASE_API_URL: 'https://dev.boxlite.ai',
      VITE_API_URL: 'https://dev.boxlite.ai/api',
      VITE_ENABLE_MOCKING: 'true',
    },
  },
  local: {
    label: 'local dashboard + local API via Vite /api proxy',
    env: {},
  },
  dex: {
    label: 'local dashboard + local API/Dex via Vite /api proxy',
    env: {},
  },
}

function parseArgs(argv) {
  let target = 'dev'
  let api
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

    forward.push(arg)
  }

  return { help: false, target, api, forward }
}

function printHelp() {
  console.log(`Usage:
  npm run start
  npm run start:dev
  npm run start:mock
  npm run start:local
  npm run start:dex
  npm run start:storybook
  npm run dev:dex
  npm run e2e:local

Targets:
  dev    local dashboard + dev Auth0/dev API (default)
  auth0  alias of dev
  mock   dev Auth0/dev API plus existing MSW billing mocks
  local  local dashboard + local API through /api proxy
  dex    alias of local; start local API/Dex separately

Local Dex:
  dev:dex    full local Dex development environment
  e2e:local  only supported local browser E2E entrypoint
`)
}

const { help, target, api, forward } = parseArgs(process.argv.slice(2))

if (help) {
  printHelp()
  process.exit(0)
}

const selected = targets[target]
if (!selected) {
  console.error(`Unknown target "${target}". Use --help to see supported targets.`)
  process.exit(1)
}

const env = {
  ...process.env,
  ...selected.env,
}

env.PATH = [appsBinPath, process.env.PATH].filter(Boolean).join(path.delimiter)

if (api) {
  env.VITE_BASE_API_URL = api.replace(/\/api\/?$/, '').replace(/\/$/, '')
}

const nxCommand = process.platform === 'win32' ? 'nx.cmd' : 'nx'
const args = ['serve', 'dashboard', ...forward]

console.log(`[dashboard] ${selected.label}`)
console.log(`[dashboard] API origin: ${env.VITE_BASE_API_URL || 'local /api proxy -> http://localhost:3001'}`)
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
