// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { createHash, randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { ExecutionContext, INestApplication, Type } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Reflector } from '@nestjs/core'
import { DataSource } from 'typeorm'
import { CustomNamingStrategy } from '../src/common/utils/naming-strategy.util'
import { CombinedAuthGuard } from '../src/auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../src/organization/guards/organization-resource-action.guard'
import { AuthenticatedRateLimitGuard } from '../src/common/guards/authenticated-rate-limit.guard'
import { VolumeAccessGuard } from '../src/box/guards/volume-access.guard'
import { BoxRequestReplayService } from '../src/boxlite-rest/box-request-replay.service'
import { RequestReplayInterceptor } from '../src/boxlite-rest/request-replay.interceptor'
import { AuditInterceptor } from '../src/audit/interceptors/audit.interceptor'
import { AuditService } from '../src/audit/services/audit.service'
import { AuditLog } from '../src/audit/entities/audit-log.entity'
import { AuditLogSubscriber } from '../src/audit/subscribers/audit-log.subscriber'
import { Organization } from '../src/organization/entities/organization.entity'
import { Box } from '../src/box/entities/box.entity'
import { BoxLastActivity } from '../src/box/entities/box-last-activity.entity'
import { BoxMigration } from '../src/box/entities/box-migration.entity'
import { BoxCheckpointState } from '../src/box/entities/box-checkpoint-state.entity'
import { Checkpoint } from '../src/box/entities/checkpoint.entity'
import { CheckpointOperation } from '../src/box/entities/checkpoint-operation.entity'
import { Job } from '../src/box/entities/job.entity'
import { Runner } from '../src/box/entities/runner.entity'
import { Volume } from '../src/box/entities/volume.entity'
import { Domain } from '../src/box/entities/domain.entity'
import { Tunnel } from '../src/box/entities/tunnel.entity'
import { RegistryCredential } from '../src/registry/entities/registry-credential.entity'
import { Image } from '../src/image/entities/image.entity'
import { ImageVersion } from '../src/image/entities/image-version.entity'
import { ImageAlias } from '../src/image/entities/image-alias.entity'
import { ImageAliasEvent } from '../src/image/entities/image-alias-event.entity'
import { subscribeBusinessEvents } from '../src/common/utils/business-event.util'
import { AddCustomDomainConfig1793764800000 } from '../src/migrations/pre-deploy/1793764800000-add-custom-domain-config-migration'
import { RequestDrivenCustomDomains1794398400000 } from '../src/migrations/pre-deploy/1794398400000-request-driven-custom-domains-migration'

export interface ReplayBusinessResponse {
  status: number
  text: string
  body: Record<string, unknown> | undefined
}

/** Real HTTP, Redis and isolated PostgreSQL; only external boundaries are supplied by each suite. */
export class ReplayBusinessFixture {
  readonly organization = { id: randomUUID(), imageCountLimit: 20 } as Organization
  readonly userId = randomUUID()
  readonly schema = `replay_business_${randomUUID().replaceAll('-', '')}`
  readonly events: Readonly<Record<string, string>>[] = []

  db: DataSource
  redis: Redis
  app: INestApplication
  private disposeEvents: () => void

  async open() {
    this.db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: this.schema,
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      extra: { options: `-c search_path=${this.schema},public` },
      entities: [
        Box,
        BoxLastActivity,
        BoxMigration,
        BoxCheckpointState,
        Checkpoint,
        CheckpointOperation,
        Job,
        Runner,
        Volume,
        Domain,
        Tunnel,
        RegistryCredential,
        Image,
        ImageVersion,
        ImageAlias,
        ImageAliasEvent,
        AuditLog,
      ],
    }).initialize()
    await this.db.query(`CREATE SCHEMA "${this.schema}"`)
    await this.db.synchronize()
    const migrationRunner = this.db.createQueryRunner()
    try {
      await new AddCustomDomainConfig1793764800000().up(migrationRunner)
      await new RequestDrivenCustomDomains1794398400000().up(migrationRunner)
    } finally {
      await migrationRunner.release()
    }
    await this.db.query(
      'CREATE TABLE organization (id uuid PRIMARY KEY, image_count_limit integer NOT NULL DEFAULT 20, domain_count_limit integer NOT NULL DEFAULT 20)',
    )
    await this.db.query('INSERT INTO organization (id) VALUES ($1)', [this.organization.id])
    new AuditLogSubscriber(this.db)
    this.redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 0,
      retryStrategy: null,
    })
    await this.redis.ping()
    this.disposeEvents = subscribeBusinessEvents((event) => this.events.push(event))
  }

  async serve(controllers: Type<unknown>[], providers: { provide: unknown; useValue: unknown }[]) {
    const audit = new AuditService(
      this.db.getRepository(AuditLog),
      {
        get: () => false,
        getOrThrow: () => 500,
      } as never,
      {} as never,
      {} as never,
      {} as never,
      { write: async () => undefined },
    )
    const builder = Test.createTestingModule({
      controllers,
      providers: [
        BoxRequestReplayService,
        { provide: getRedisConnectionToken(), useValue: this.redis },
        ...providers,
      ] as never,
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = {
            userId: this.userId,
            email: 'replay@example.test',
            role: 'user',
            organizationId: this.organization.id,
            organization: this.organization,
          }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(VolumeAccessGuard)
      .useValue({ canActivate: () => true })
    const module = await builder.compile()
    this.app = module.createNestApplication()
    this.app.setGlobalPrefix('api')
    this.app.useGlobalInterceptors(
      new AuditInterceptor(new Reflector(), audit),
      new RequestReplayInterceptor(module.get(BoxRequestReplayService)),
    )
    await this.app.listen(0, '127.0.0.1')
  }

  async request(method: string, path: string, key: string, body?: unknown) {
    const response = await fetch(`${await this.app.getUrl()}/api/v1/${path}`, {
      method,
      headers: { 'Idempotency-Key': key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    expect(response.status).toBeLessThan(300)
    expect(response.status).toBeGreaterThanOrEqual(200)
    return { status: response.status, text, body: text ? JSON.parse(text) : undefined }
  }

  /** Completion is asynchronous after end; await the persisted fence rather than sleeping before retry. */
  async completed(key: string) {
    const deadline = Date.now() + 3000
    const digest = createHash('sha256').update(key).digest('hex')
    do {
      const keys = await this.redis.keys(`replay:${this.organization.id}:${this.userId}:*`)
      for (const stored of keys) {
        if (stored.endsWith(digest) && (await this.redis.hget(stored, 'state')) === 'complete') return
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    } while (Date.now() < deadline)
    throw new Error('Successful HTTP request did not persist a completed replay record')
  }

  async replay(method: string, path: string, key: string, original: ReplayBusinessResponse, body?: unknown) {
    await this.completed(key)
    expect(await this.request(method, path, key, body)).toEqual(original)
  }

  async close() {
    this.disposeEvents?.()
    await this.app?.close()
    if (this.redis) {
      const keys = await this.redis.keys(`replay:${this.organization.id}:${this.userId}:*`)
      if (keys.length) await this.redis.del(...keys)
      await this.redis.quit()
    }
    if (this.db?.isInitialized) {
      await this.db.query(`DROP SCHEMA "${this.schema}" CASCADE`)
      await this.db.destroy()
    }
  }
}
