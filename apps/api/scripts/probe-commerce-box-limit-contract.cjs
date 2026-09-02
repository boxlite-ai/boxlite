/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

const { resolve } = require('node:path')

async function main() {
  const { PlansController } = require(resolve('src/plans/api/plans.controller.ts'))
  const { SubscriptionsController } = require(resolve('src/subscriptions/api/subscriptions.controller.ts'))
  const plans = [
    {
      id: 'starter',
      name: 'Starter',
      priceMonthlyCents: 1_000,
      includedQuotaCents: 1_000,
      concurrencyLimit: 2,
      selfServe: true,
      rank: 0,
    },
    {
      id: 'pro',
      name: 'Pro',
      priceMonthlyCents: 5_000,
      includedQuotaCents: 5_000,
      concurrencyLimit: 8,
      selfServe: true,
      rank: 1,
    },
  ]
  const catalog = await new PlansController({ catalog: async () => plans }).listPlans()
  const noSubscription = await new SubscriptionsController({ current: async () => null }).getOrganizationPlan('org-1')

  process.stdout.write(JSON.stringify({ catalog, noSubscription }))
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
