import 'reflect-metadata'
import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common'
import { AuthGuard, PassportModule } from '@nestjs/passport'
import { Test } from '@nestjs/testing'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { ThrottlerModule } from '@nestjs/throttler'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import Redis from 'ioredis'
import { DataSource } from 'typeorm'
import { OrganizationController } from '../../organization/controllers/organization.controller'
import { OrganizationUserController } from '../../organization/controllers/organization-user.controller'
import { OrganizationService } from '../../organization/services/organization.service'
import { OrganizationUserService } from '../../organization/services/organization-user.service'
import { Organization } from '../../organization/entities/organization.entity'
import { OrganizationUser } from '../../organization/entities/organization-user.entity'
import { Region } from '../../region/entities/region.entity'
import { User } from '../../user/user.entity'
import { UserService } from '../../user/user.service'
import { UserRegistrationService } from '../../user/user-registration.service'
import { UserEvents } from '../../user/constants/user-events.constant'
import { BusinessEventOutboxService } from '../../business-events/business-event-outbox.service'
import { OrganizationReferralService } from '../organization-referral.service'
import { JwtStrategy } from '../../auth/jwt.strategy'
import { ApiKeyStrategy } from '../../auth/api-key.strategy'
import { ApiKey } from '../../api-key/api-key.entity'
import { ApiKeyService } from '../../api-key/api-key.service'
import { TypedConfigService } from '../../config/typed-config.service'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'

export async function startTestIdentity() {
  const keys = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'referral-test', alg: 'RS256', use: 'sig' }
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const issuer = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  return {
    issuer,
    async token(subject: string, verified = true, claims: Record<string, unknown> = {}) {
      return new SignJWT({
        name: 'Referral test',
        email: subject + '@test.invalid',
        email_verified: verified,
        ...claims,
      })
        .setSubject(subject)
        .setIssuer(issuer)
        .setAudience('referral-test')
        .setIssuedAt()
        .setExpirationTime('10m')
        .setProtectedHeader({ alg: 'RS256', kid: 'referral-test' })
        .sign(keys.privateKey)
    },
    close: () => closeServer(server),
  }
}

export function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

export async function startReferralApi(database: DataSource, issuer: string, prefix: string) {
  if (!process.env.REDIS_HOST || !process.env.REDIS_PORT || !process.env.REDIS_PASSWORD) {
    throw new Error('Referral integration requires the configured remote Redis')
  }
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    keyPrefix: prefix + ':',
    connectTimeout: 10000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  })
  await redis.connect()
  let app: INestApplication
  try {
    const events = new EventEmitter2()
    const referrals = new OrganizationReferralService(database)
    const outbox = new BusinessEventOutboxService()
    const registrations = new UserRegistrationService(referrals, outbox)
    const users = new UserService(database.getRepository(User), events, database, registrations, referrals)
    const settings: Record<string, unknown> = {
      'defaultRegion.id': 'referral-test',
      organizationBoxDefaultLimitedNetworkEgress: false,
      skipUserEmailVerification: false,
      requirePaymentMethod: false,
      'proxy.apiKey': 'referral-fixture-proxy',
      'apiKey.prefix': 'blk',
      'apiKey.validationCacheTtlSeconds': 10,
      'apiKey.userCacheTtlSeconds': 10,
    }
    const config = {
      get: (key: string) => settings[key],
      getOrThrow: (key: string) => {
        if (settings[key] === undefined) throw new Error('Missing fixture configuration: ' + key)
        return settings[key]
      },
    } as TypedConfigService
    const organizations = new OrganizationService(
      database.getRepository(Organization),
      undefined,
      events,
      config,
      undefined,
      database.getRepository(Region),
      { findOne: (id: string) => database.getRepository(Region).findOneBy({ id }) } as never,
      undefined,
    )
    const memberships = new OrganizationUserService(
      database.getRepository(OrganizationUser),
      undefined,
      users,
      events,
      database,
    )
    events.on(UserEvents.CREATED, organizations.handleUserCreatedEvent.bind(organizations))
    events.on(UserEvents.EMAIL_VERIFIED, organizations.handleUserEmailVerifiedEvent.bind(organizations))
    events.on(UserEvents.DELETED, organizations.handleUserDeletedEvent.bind(organizations))
    const production = new OrganizationController(organizations, memberships, undefined, users, config, referrals)
    const apiKeys = new ApiKeyService(database.getRepository(ApiKey), new RedisLockProvider(redis), redis, config)

    // Mount the exact production handlers and their route/guard/parameter metadata.
    // Other controllers and VM lifecycle jobs are outside this focused HTTP fixture.
    @Controller(Reflect.getMetadata('path', OrganizationController))
    class ReferralHttpController {
      constructor() {
        Object.assign(this, production)
      }
    }
    for (const method of ['findAll', 'getReferralCode']) {
      Object.defineProperty(ReferralHttpController.prototype, method, {
        value: OrganizationController.prototype[method],
      })
      for (const key of Reflect.getMetadataKeys(OrganizationController, method)) {
        Reflect.defineMetadata(
          key,
          Reflect.getMetadata(key, OrganizationController, method),
          ReferralHttpController,
          method,
        )
      }
    }
    @Controller('probe')
    class ProbeController {
      @Get()
      @UseGuards(AuthGuard('jwt'))
      probe() {
        return { ok: true }
      }
    }

    const module = await Test.createTestingModule({
      imports: [PassportModule, ThrottlerModule.forRoot([{ name: 'authenticated', ttl: 60000, limit: 10000 }])],
      controllers: [ReferralHttpController, OrganizationUserController, ProbeController],
      providers: [
        {
          provide: OrganizationService,
          useValue: {
            findOne: organizations.findOne.bind(organizations),
            findByUserWithDefaultFlag: organizations.findByUserWithDefaultFlag.bind(organizations),
          },
        },
        { provide: OrganizationUserService, useValue: memberships },
        { provide: getRedisConnectionToken(), useValue: redis },
        { provide: getRedisConnectionToken('throttler'), useValue: redis },
        { provide: TypedConfigService, useValue: config },
        {
          provide: JwtStrategy,
          useFactory: () =>
            new JwtStrategy({ issuer, audience: 'referral-test', jwksUri: issuer + '/jwks' }, users, config),
        },
        {
          provide: ApiKeyStrategy,
          useFactory: () => new ApiKeyStrategy(redis, apiKeys, users, config, undefined, undefined),
        },
      ],
    }).compile()
    app = module.createNestApplication({ logger: false })
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    return {
      app,
      apiKeys,
      users,
      organizations,
      memberships,
      referrals,
      outbox,
      events,
      config,
      redis,
      url: await app.getUrl(),
      async close() {
        try {
          await app.close()
          let cursor = '0'
          do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', prefix + ':*', 'COUNT', 1000)
            cursor = next
            if (keys.length) await redis.del(...keys.map((key) => key.slice(prefix.length + 1)))
          } while (cursor !== '0')
        } finally {
          await redis.quit()
        }
      },
    }
  } catch (error) {
    try {
      await app?.close()
    } finally {
      redis.disconnect()
    }
    throw error
  }
}
