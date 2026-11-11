/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { otelSdk } from './tracing'
import { installCiWebhookBodyParser } from './ci/ci-webhook-body'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'
import { SwaggerModule } from '@nestjs/swagger'
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common'
import { Context } from './common/context/context'
import { PlatformReason } from './common/context/platform-reason.enum'
import { AllExceptionsFilter } from './filters/all-exceptions.filter'
import { MetricsInterceptor } from './interceptors/metrics.interceptor'
import { AnalyticsService } from './analytics/services/analytics.service'
import { HttpsOptions } from '@nestjs/common/interfaces/external/https-options.interface'
import { TypedConfigService } from './config/typed-config.service'
import { FailedAuthTrackerService } from './auth/failed-auth-tracker.service'
import { DataSource, MigrationExecutor } from 'typeorm'
import { getOpenApiConfig } from './openapi.config'
import { AuditInterceptor } from './audit/interceptors/audit.interceptor'
import { extname, join } from 'node:path'
import { ApiKeyService } from './api-key/api-key.service'
import { BOXLITE_ADMIN_USER_ID } from './app.service'
import { OrganizationService } from './organization/services/organization.service'
import { MicroserviceOptions, Transport } from '@nestjs/microservices'
import { Partitioners } from 'kafkajs'
import { isApiEnabled, isWorkerEnabled } from './common/utils/app-mode'
import cluster from 'node:cluster'
import type { IncomingMessage } from 'http'
import type { Socket } from 'net'
import { Logger as PinoLogger, LoggerErrorInterceptor } from 'nestjs-pino'
import { BoxliteWsProxyService } from './boxlite-rest/boxlite-ws-proxy.service'
import { parse as parseYaml } from 'yaml'
import { MCP_ROOT_ROUTES } from './mcp/mcp-auth-metadata'
import { mcpStrategy } from './mcp/mcp.controller'
import { useApiBodyParsers } from './mcp/mcp-body'
import { McpTools } from './mcp/mcp-tools'
import { servedOperations } from './mcp/mcp-routes'

// https options
const httpsEnabled = process.env.CERT_PATH && process.env.CERT_KEY_PATH
const httpsOptions: HttpsOptions = {
  cert: process.env.CERT_PATH ? readFileSync(process.env.CERT_PATH) : undefined,
  key: process.env.CERT_KEY_PATH ? readFileSync(process.env.CERT_KEY_PATH) : undefined,
}

async function bootstrap() {
  if (process.env.OTEL_ENABLED === 'true') {
    await otelSdk.start()
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    httpsOptions: httpsEnabled ? httpsOptions : undefined,
    // `useApiBodyParsers` registers the parsers, so `/mcp` reads its body only
    // after authentication.
    bodyParser: false,
  })
  installCiWebhookBodyParser(app)
  app.useLogger(app.get(PinoLogger))
  app.flushLogs()
  useApiBodyParsers(app)
  // Pin CORS to known first-party origins rather than reflecting any origin.
  // With `credentials: true`, `origin: true` would let any site make
  // credentialed cross-origin calls to the API. The dashboard SPA (served at
  // DASHBOARD_URL) is the only legitimate cross-origin caller; CORS_ALLOWED_ORIGINS
  // (comma-separated) adds extras (e.g. local dev). If nothing is configured we
  // fall back to reflecting the origin and warn — so an unconfigured deployment
  // is never silently broken, while configured stacks (SST sets DASHBOARD_URL)
  // are locked down.
  // Gather configured origins, trim them, drop unset/empty entries (the
  // `is string` guard also narrows the array to string[]), then dedupe.
  const allowedOrigins = [
    process.env.DASHBOARD_URL,
    process.env.APP_URL,
    ...(process.env.CORS_ALLOWED_ORIGINS?.split(',') ?? []),
  ]
    .map((origin) => origin?.trim())
    .filter((origin): origin is string => !!origin)
  const uniqueAllowedOrigins = [...new Set(allowedOrigins)]
  if (uniqueAllowedOrigins.length === 0) {
    Logger.warn(
      'CORS: no DASHBOARD_URL / APP_URL / CORS_ALLOWED_ORIGINS set; reflecting request origin. Set one to restrict cross-origin access.',
      'Bootstrap',
    )
  }
  app.enableCors({
    origin: uniqueAllowedOrigins.length > 0 ? uniqueAllowedOrigins : true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  })

  const configService = app.get(TypedConfigService)
  const failedAuthTracker = app.get(FailedAuthTrackerService)
  app.set('trust proxy', true)
  app.useGlobalFilters(new AllExceptionsFilter(failedAuthTracker))
  app.useGlobalInterceptors(new LoggerErrorInterceptor())
  app.useGlobalInterceptors(new MetricsInterceptor(configService, app.get(AnalyticsService)))
  app.useGlobalInterceptors(app.get(AuditInterceptor))
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
    }),
  )

  // Runtime flags for migrations for run and revert migrations
  if (process.argv.length > 2) {
    if (process.argv[2].startsWith('--migration-')) {
      const dataSource = app.get(DataSource)
      dataSource.setOptions({ logging: true })
      const migrationExecutor = new MigrationExecutor(dataSource)

      switch (process.argv[2]) {
        case '--migration-run':
          await migrationExecutor.executePendingMigrations()
          break
        case '--migration-revert':
          await migrationExecutor.undoLastMigration()
          break
        default:
          Logger.error('Invalid migration flag')
          process.exit(1)
      }
    } else if (process.argv[2] === '--create-admin-api-key') {
      if (process.argv.length < 4) {
        Logger.error('Invalid flag. API key name is required.')
        process.exit(1)
      }
      await createAdminApiKey(app, process.argv[3])
    } else {
      Logger.error('Invalid flag')
      process.exit(1)
    }

    process.exit(0)
  }

  const globalPrefix = 'api'
  app.setGlobalPrefix(globalPrefix, { exclude: MCP_ROOT_ROUTES })

  // Built once: the Swagger UI serves it, and the MCP catalog reads the dashboard routes from it.
  const document = SwaggerModule.createDocument(app, getOpenApiConfig(configService.get('oidc.issuer')))
  SwaggerModule.setup('api', app, () => document, {
    swaggerOptions: {
      initOAuth: {
        clientId: configService.get('oidc.clientId'),
        appName: 'BoxLite AI',
        scopes: ['openid', 'profile', 'email'],
        additionalQueryStringParams: {
          audience: configService.get('oidc.audience'),
        },
      },
    },
  })

  // Replace dashboard api url before serving
  if (configService.get('production')) {
    const dashboardDir = join(__dirname, '..', 'dashboard')
    const dashboardTextExtensions = new Set(['.html', '.js', '.css'])
    const replaceInDirectory = (dir: string) => {
      for (const file of readdirSync(dir)) {
        const filePath = join(dir, file)
        if (statSync(filePath).isDirectory()) {
          replaceInDirectory(filePath)
          continue
        }
        if (!dashboardTextExtensions.has(extname(filePath))) {
          continue
        }
        Logger.log(`Replacing %BOXLITE_BASE_API_URL% in ${filePath}`)
        const fileContent = readFileSync(filePath, 'utf8')
        const newFileContent = fileContent.replaceAll(
          '%BOXLITE_BASE_API_URL%',
          configService.get('dashboardBaseApiUrl'),
        )
        writeFileSync(filePath, newFileContent)
      }
    }
    replaceInDirectory(dashboardDir)
  }

  // Starts listening for shutdown hooks
  app.enableShutdownHooks()

  const host = process.env.BOXLITE_LISTEN_HOST || '0.0.0.0'
  const port = configService.get('port')

  if (isApiEnabled()) {
    // MCP tools come from the v1 specs (bundled as assets) and the dashboard document,
    // limited to the routes this app registered, so init() runs first.
    await app.init()
    const specDirectory = process.env.BOXLITE_OPENAPI_DIR || join(__dirname, 'assets', 'openapi')
    const openapi = (name: string) => parseYaml(readFileSync(join(specDirectory, name), 'utf8'))
    const wsProxy = app.get(BoxliteWsProxyService)
    app.get(McpTools).register({
      box: openapi('box.openapi.yaml'),
      admin: openapi('admin.openapi.yaml'),
      dashboard: document,
      served: servedOperations(app.getHttpAdapter().getInstance(), (path) => !!wsProxy.matchAttachPath(path)),
    })
    // Started on its own, before listen(), so `/mcp` is ready with the first
    // request; Kafka below keeps its own start and cannot delay this one.
    await app.connectMicroservice({ strategy: mcpStrategy }).listen()

    await app.listen(port, host)
    Logger.log(`🚀 BoxLite API is running on: http://${host}:${port}/${globalPrefix}`)

    // Node's http.Server keep-alive must outlast the ALB's idle_timeout. Per
    // AWS ALB User Guide HTTP 502 troubleshooting: "Check whether the keep-alive
    // duration of the target is shorter than the idle timeout value of the load
    // balancer." Node 18+ defaults keepAliveTimeout to 5s; we set ALB idle to
    // "1 hour" (apps/infra/stack/api.ts Api service.loadBalancer). 65 min keepalive and
    // 66 min headersTimeout (which must be >= keepAliveTimeout) cover the gap.
    const httpServer = app.getHttpServer()
    httpServer.keepAliveTimeout = 65 * 60 * 1000
    httpServer.headersTimeout = 66 * 60 * 1000
    // File uploads can legitimately exceed Node's default five-minute request
    // body deadline. Node exposes this setting only at the server level.
    httpServer.requestTimeout = 0

    // WebSocket upgrade routing for the BoxLite REST `/attach` endpoint.
    // NestJS controllers only fire on Express's `request` event; WS upgrades
    // arrive as `upgrade` events on the underlying Node http server and
    // bypass middleware/guards. http-proxy-middleware's `ws: true` per-request
    // pattern in BoxliteProxyController doesn't catch these — http-proxy
    // requires `server.on('upgrade', proxy.upgrade)` to be wired at bootstrap
    // (see its README "External WebSocket upgrade" section). Without this,
    // Node defaults to closing the socket and the upstream ALB returns 502.
    //
    // The notification gateway (apps/api/src/notification/gateways/notification.gateway.ts)
    // registers `@WebSocketGateway({ path: '/api/socket.io/' })` and attaches
    // its own upgrade listener to the same http.Server. We must let those
    // paths fall through to socket.io rather than destroying the socket out
    // from under it; everything else is unauthenticated traffic and gets
    // closed here.
    httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      if (wsProxy.matchAttachPath(req.url)) {
        void wsProxy.upgrade(req, socket, head)
        return
      }
      if (req.url?.startsWith('/api/socket.io/')) {
        // Handled by NotificationGateway's socket.io upgrade listener.
        return
      }
      socket.destroy()
    })
  } else {
    await app.init()
    app.flushLogs()
  }

  if (isWorkerEnabled() && configService.get('kafka.enabled')) {
    const kafka = app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.KAFKA,
      options: {
        client: configService.getKafkaClientConfig(),
        producer: {
          allowAutoTopicCreation: true,
          createPartitioner: Partitioners.DefaultPartitioner,
          idempotent: true,
        },
        consumer: {
          allowAutoTopicCreation: true,
          groupId: 'boxlite',
        },
        run: {
          autoCommit: false,
        },
        subscribe: {
          fromBeginning: true,
        },
      },
    })
    // Only this one: startAllMicroservices() would start the MCP strategy a second time.
    await kafka.listen()
  }

  // If app running in cluster mode, send ready signal
  if (cluster.isWorker) {
    process.send('ready')
  }
}

async function createAdminApiKey(app: INestApplication, apiKeyName: string) {
  const apiKeyService = app.get(ApiKeyService)
  const organizationService = app.get(OrganizationService)

  const defaultOrg = await organizationService.findDefaultForUser(BOXLITE_ADMIN_USER_ID)
  const { value } = await apiKeyService.createApiKey(
    defaultOrg.id,
    BOXLITE_ADMIN_USER_ID,
    apiKeyName,
    [],
    Context.platform(PlatformReason.BOOTSTRAP),
  )
  Logger.log(
    `
=========================================
=========================================
Admin API key created: ${value}
=========================================
=========================================`,
  )
}

bootstrap()
