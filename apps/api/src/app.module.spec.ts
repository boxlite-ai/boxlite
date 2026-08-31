// http-proxy-middleware is ESM-only and sits in AppModule's import graph via
// the boxlite-rest proxy controller; nothing here exercises it.
jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: () => () => undefined,
  fixRequestBody: () => undefined,
}))

/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MODULE_METADATA } from '@nestjs/common/constants'
import { AppModule } from './app.module'
import { UsageModule } from './usage/usage.module'
import { StatusSyncModule } from './status-sync/status-sync.module'

// The usage ledger is driven entirely by events and cron jobs — nothing imports
// it and no request path touches it — so dropping this registration disables
// billing silently. It was in fact lost once in a convergence merge (#715).
describe('AppModule registrations', () => {
  it('registers the usage ledger', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as Array<unknown>

    expect(imports).toContain(UsageModule)
  })

  // Same failure mode as the usage ledger: the status sync is cron-only, so
  // dropping this registration silently freezes the public status page.
  it('registers the status sync', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as Array<unknown>

    expect(imports).toContain(StatusSyncModule)
  })
})
