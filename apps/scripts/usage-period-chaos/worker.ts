/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/*
 * Chaos worker — a real, killable process holding the same object graph the API
 * holds: EventEmitter2 -> BoxRepository -> UsageModule -> UsageService, over a
 * real Postgres and Redis. run.mjs drives it over stdin and kills it mid-flight;
 * nothing here simulates a crash, the process really dies.
 *
 * Protocol: one JSON command per stdin line, one JSON reply per stdout line.
 */
// Reaches into apps/api on purpose: the point of this harness is to hold the
// API's own object graph in a process it can kill, so a published boundary
// would defeat it. Dev tooling only — nothing here ships.
/* eslint-disable @nx/enforce-module-boundaries */
import { RedisModule, getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { EventEmitterModule } from '@nestjs/event-emitter'
import { Test } from '@nestjs/testing'
import { TypeOrmModule } from '@nestjs/typeorm'
import type { Redis } from 'ioredis'
import * as readline from 'readline'
import { DataSource } from 'typeorm'
import { BoxLastActivity } from '../../api/src/box/entities/box-last-activity.entity'
import { Box } from '../../api/src/box/entities/box.entity'
import { BoxDesiredState } from '../../api/src/box/enums/box-desired-state.enum'
import { BoxState } from '../../api/src/box/enums/box-state.enum'
import { BoxRepository } from '../../api/src/box/repositories/box.repository'
import { CustomNamingStrategy } from '../../api/src/common/utils/naming-strategy.util'
import { AddBoxUsagePeriods1785250000000 } from '../../api/src/migrations/pre-deploy/1785250000000-add-box-usage-periods-migration'
import { BoxUsagePeriod } from '../../api/src/usage/entities/box-usage-period.entity'
import { BoxUsagePeriodArchive } from '../../api/src/usage/entities/box-usage-period-archive.entity'
import { UsageService } from '../../api/src/usage/services/usage.service'
import { UsageModule } from '../../api/src/usage/usage.module'

const connection = {
  type: 'postgres' as const,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  namingStrategy: new CustomNamingStrategy(),
}

const say = (payload: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(payload)}\n`)

// Surfaces what an unhandled rejection would otherwise do silently inside the
// API: an event handler that throws has no owner to catch it.
process.on('unhandledRejection', (reason) => {
  say({ event: 'unhandledRejection', reason: String(reason) })
})

async function setup() {
  const source = await new DataSource({
    ...connection,
    entities: [Box, BoxLastActivity],
    synchronize: true,
  }).initialize()
  await source.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
  await source.query(`DROP TABLE IF EXISTS "box_usage_periods", "box_usage_periods_archive"`)
  const runner = source.createQueryRunner()
  try {
    await new AddBoxUsagePeriods1785250000000().up(runner)
  } finally {
    await runner.release()
    await source.destroy()
  }
  say({ event: 'setup-done' })
}

async function serve() {
  const moduleRef = await Test.createTestingModule({
    imports: [
      EventEmitterModule.forRoot({ maxListeners: 100 }),
      RedisModule.forRoot({
        type: 'single',
        options: {
          host: process.env.REDIS_HOST,
          port: Number(process.env.REDIS_PORT),
          db: Number(process.env.REDIS_DB),
          maxRetriesPerRequest: 2,
        },
      }),
      TypeOrmModule.forRoot({
        ...connection,
        entities: [Box, BoxLastActivity, BoxUsagePeriod, BoxUsagePeriodArchive],
        synchronize: false,
      }),
      UsageModule,
    ],
  }).compile()
  await moduleRef.init()

  // main.ts calls app.enableShutdownHooks(), so a real SIGTERM reaches
  // UsageService.onApplicationShutdown and drains in-flight handlers. The same
  // path is taken here, closed explicitly rather than through Nest's signal
  // listener only because stdin holds this process's event loop open, so it
  // would never actually exit afterwards.
  let closing = false
  process.on('SIGTERM', () => {
    if (closing) {
      return
    }
    closing = true
    const startedAt = Date.now()
    moduleRef
      .close()
      .then(() => {
        say({ event: 'closed', drainMs: Date.now() - startedAt })
        process.exit(0)
      })
      .catch((error) => {
        say({ event: 'close-failed', error: String(error) })
        process.exit(1)
      })
  })

  const boxRepository = moduleRef.get(BoxRepository)
  const usageService = moduleRef.get(UsageService)
  const redis: Redis = moduleRef.get(getRedisConnectionToken())

  const ops: Record<string, (cmd: any) => Promise<unknown>> = {
    ping: async () => ({ pid: process.pid }),

    createBox: async (cmd) => {
      const box = new Box('us')
      box.organizationId = cmd.organizationId
      box.osUser = 'boxlite'
      box.state = BoxState.CREATING
      box.desiredState = BoxDesiredState.STARTED
      box.cpu = cmd.cpu ?? 2
      box.gpu = cmd.gpu ?? 1
      box.mem = cmd.mem ?? 4
      box.disk = cmd.disk ?? 10
      box.autoPause = 0
      box.autoDelete = 0
      await boxRepository.insert(box)
      return { boxId: box.id }
    },

    // Resolves as soon as BoxRepository.update() does — the box row is
    // committed and the event emitted, but the usage handler may still be in
    // flight. That is precisely the window run.mjs kills in.
    transition: async (cmd) => {
      await boxRepository.update(cmd.boxId, { updateData: cmd.updateData })
      return { inFlight: [...usageService.activeJobs] }
    },

    settle: async () => {
      const deadline = Date.now() + 30_000
      while (usageService.activeJobs.size > 0) {
        if (Date.now() > deadline) {
          throw new Error('handlers did not settle in 30s')
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return {}
    },

    cron: async (cmd) => {
      if (cmd.name === 'rollover') {
        await usageService.closeAndReopenUsagePeriods()
      } else if (cmd.name === 'archive') {
        await usageService.archiveUsagePeriods()
      } else {
        throw new Error(`unknown cron ${cmd.name}`)
      }
      return {}
    },

    // Cuts this process off from Redis without touching the shared server, so
    // other clients (the live API) keep working.
    killRedis: async () => {
      redis.disconnect()
      return {}
    },
  }

  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) {
      return
    }
    const cmd = JSON.parse(line)
    Promise.resolve()
      .then(() => ops[cmd.op](cmd))
      .then((result) => say({ id: cmd.id, ok: true, ...(result as object) }))
      .catch((error) => say({ id: cmd.id, ok: false, error: String(error?.message ?? error) }))
  })

  say({ event: 'ready', pid: process.pid })
}

const main = process.argv.includes('--setup') ? setup : serve
main().catch((error) => {
  say({ event: 'fatal', error: String(error?.stack ?? error) })
  process.exit(1)
})
