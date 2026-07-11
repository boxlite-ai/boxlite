#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url))
const appsRoot = path.resolve(scriptsRoot, '..')
const yarn = process.platform === 'win32' ? 'yarn.cmd' : 'yarn'

const apiSpecs = [
  'api/src/usage/usage.service.spec.ts',
  'api/src/billing/billing-read.service.spec.ts',
  'api/src/billing/billing.controller.spec.ts',
  'api/src/billing/payment/payment-provider.spec.ts',
  'api/src/billing/payment/payment.controller.spec.ts',
  'api/src/billing/payment/payment.service.spec.ts',
  'api/src/billing/rating/rate-math.spec.ts',
  'api/src/billing/rating/rating.service.spec.ts',
  'api/src/billing/settlement.service.spec.ts',
  'api/src/billing/wallet.service.spec.ts',
]

const prerequisiteSpecs = ['api/src/organization/services/organization.service.regions.spec.ts']

const dashboardSpecs = [
  'dashboard/src/billing-api/billingApiClient.test.ts',
  'dashboard/src/components/Box/CreateBoxDialog.test.tsx',
  'dashboard/src/components/billing/BillingPaymentMethodSection.test.tsx',
  'dashboard/src/components/billing/BillingPaymentPanel.test.tsx',
  'dashboard/src/components/billing/cost.spec.ts',
  'dashboard/src/components/boxes/BoxDetails.test.tsx',
  'dashboard/src/hooks/mutations/billingPaymentMutations.test.tsx',
  'dashboard/src/pages/Billing.test.tsx',
]

const jest = (label, specs) => ({
  label,
  args: ['jest', '--config', 'api/jest.config.ts', '--runInBand', ...specs],
})

const stages = {
  apiUnit: jest('API unit and local prerequisites', [...apiSpecs, ...prerequisiteSpecs]),
  prereq: jest('Local Billing prerequisites', prerequisiteSpecs),
  usage: jest('Usage', ['api/src/usage/usage.service.spec.ts']),
  rating: jest('Rating', ['api/src/billing/rating/rate-math.spec.ts', 'api/src/billing/rating/rating.service.spec.ts']),
  wallet: jest('Wallet and settlement', [
    'api/src/billing/wallet.service.spec.ts',
    'api/src/billing/settlement.service.spec.ts',
  ]),
  payment: jest('Payment', [
    'api/src/billing/payment/payment-provider.spec.ts',
    'api/src/billing/payment/payment.controller.spec.ts',
    'api/src/billing/payment/payment.service.spec.ts',
  ]),
  stripe: {
    label: 'Stripe Sandbox configuration',
    args: ['test:billing:stripe'],
  },
  read: jest('Billing read API', [
    'api/src/billing/billing-read.service.spec.ts',
    'api/src/billing/billing.controller.spec.ts',
  ]),
  ui: {
    label: 'Dashboard UI',
    args: ['vitest', 'run', '--config', 'dashboard/vite.config.mts', ...dashboardSpecs],
  },
  db: {
    label: 'PostgreSQL edge cases',
    args: ['test:billing-edge'],
  },
  lint: {
    label: 'Billing scoped ESLint',
    args: [
      'eslint',
      'api/src/usage',
      'api/src/billing',
      'dashboard/src/pages/Billing.tsx',
      'dashboard/src/components/billing',
      'dashboard/src/components/Box/CreateBoxDialog.tsx',
      'dashboard/src/components/boxes/BoxDetails.tsx',
      'dashboard/src/billing-api',
      'dashboard/src/hooks/mutations',
      'scripts/billing-local-e2e.mjs',
      'scripts/billing-stripe-sandbox-config.mjs',
      'scripts/billing-stripe-sandbox-e2e.mjs',
      'scripts/billing-stripe-sandbox-listener.mjs',
      'scripts/billing-test-suite.mjs',
    ],
  },
  apiBuild: {
    label: 'API build',
    args: ['nx', 'run', 'api:build', '--configuration=development', '--skip-nx-cache'],
  },
  dashboardBuild: {
    label: 'Dashboard build',
    args: ['nx', 'run', 'dashboard:build', '--configuration=development', '--skip-nx-cache'],
  },
}

const suites = {
  prereq: { description: 'Organization and Region prerequisites for local Billing', stages: [stages.prereq] },
  usage: { description: 'PR1 usage lifecycle tests', stages: [stages.usage] },
  rating: { description: 'PR2 rating and price snapshots', stages: [stages.rating] },
  wallet: { description: 'PR3 wallet and settlement', stages: [stages.wallet] },
  payment: { description: 'PR5 providers, webhooks, and top-ups', stages: [stages.payment, stages.stripe] },
  stripe: { description: 'PR6 Stripe Sandbox configuration', stages: [stages.stripe] },
  read: { description: 'PR4 billing read API', stages: [stages.read] },
  ui: { description: 'PR4/PR5 dashboard behavior', stages: [stages.ui] },
  db: { description: 'Real PostgreSQL concurrency and recovery', stages: [stages.db] },
  quick: {
    description: 'Fast deterministic API and UI regression suite',
    stages: [stages.apiUnit, stages.stripe, stages.ui],
  },
  all: {
    description: 'Complete deterministic Billing collection',
    stages: [stages.apiUnit, stages.stripe, stages.db, stages.ui],
  },
  verify: {
    description: 'Complete collection plus lint and builds',
    stages: [stages.apiUnit, stages.stripe, stages.db, stages.ui, stages.lint, stages.apiBuild, stages.dashboardBuild],
  },
}

const requestedSuite = process.argv[2] ?? 'quick'
if (requestedSuite === '--list' || requestedSuite === 'list') {
  for (const [name, suite] of Object.entries(suites)) {
    console.log(`${name.padEnd(8)} ${suite.description}`)
  }
  process.exit(0)
}

const suite = suites[requestedSuite]
if (!suite) {
  console.error(`Unknown Billing test suite: ${requestedSuite}`)
  console.error(`Available suites: ${Object.keys(suites).join(', ')}`)
  process.exit(2)
}

const suiteStartedAt = Date.now()
console.log(`[billing-test] ${requestedSuite}: ${suite.description}`)

for (const [index, stage] of suite.stages.entries()) {
  const startedAt = Date.now()
  console.log(`\n[billing-test] ${index + 1}/${suite.stages.length} ${stage.label}`)
  await run(stage.args)
  console.log(`[billing-test] PASS ${stage.label} (${formatDuration(Date.now() - startedAt)})`)
}

console.log(`\n[billing-test] PASS ${requestedSuite} (${formatDuration(Date.now() - suiteStartedAt)})`)

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(yarn, args, { cwd: appsRoot, env: process.env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${yarn} ${args.join(' ')} failed with ${signal ?? `exit ${code}`}`))
    })
  })
}

function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`
}
