/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MODULE_METADATA } from '@nestjs/common/constants'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { RedisLockProvider } from '../box/common/redis-lock.provider'
import { Runner } from '../box/entities/runner.entity'
import { RedisHealthIndicator } from '../health/redis.health'
import { Region } from '../region/entities/region.entity'
import { IncidentIoClient } from './services/incident-io.client'
import { StatusSyncService } from './services/status-sync.service'
import { StatusSyncModule } from './status-sync.module'

// Everything the module reaches for outside its own providers — the
// DataSource, the ioredis connection, the global TypedConfigService — is
// stubbed, and useMocker fills in any token the module forgot to provide. A
// compile proves the wiring it *does* declare is constructible; the metadata
// test below covers what a compile would let through. `duplicate` is here
// because RedisHealthIndicator clones the connection in its constructor.
const externalStub = () => ({
  entityMetadatas: [],
  options: { type: 'postgres' },
  getRepository: () => ({}),
  duplicate() {
    return this
  },
})

describe('StatusSyncModule', () => {
  it('resolves the sync service and its collaborators', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [StatusSyncModule] })
      .useMocker(externalStub)
      .compile()

    expect(moduleRef.get(StatusSyncService)).toBeInstanceOf(StatusSyncService)
    expect(moduleRef.get(IncidentIoClient)).toBeInstanceOf(IncidentIoClient)
    expect(moduleRef.get(RedisLockProvider)).toBeInstanceOf(RedisLockProvider)
    expect(moduleRef.get(RedisHealthIndicator)).toBeInstanceOf(RedisHealthIndicator)
  })

  // Dropping any of these leaves every service-level test green while the
  // sync silently stops running (or stops observing a component).
  it('registers both entity repositories and all four providers', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, StatusSyncModule) as Array<any>
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StatusSyncModule) as Array<any>
    const importedTokens = imports.flatMap((imported) => imported?.providers ?? []).map((provider) => provider?.provide)

    expect(importedTokens).toEqual(expect.arrayContaining([getRepositoryToken(Runner), getRepositoryToken(Region)]))
    expect(providers).toEqual(
      expect.arrayContaining([StatusSyncService, IncidentIoClient, RedisLockProvider, RedisHealthIndicator]),
    )
  })
})
