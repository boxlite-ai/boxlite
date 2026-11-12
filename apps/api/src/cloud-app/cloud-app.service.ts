import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common'
import { DataSource } from 'typeorm'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { TypedConfigService } from '../config/typed-config.service'
import { EncryptionService } from '../encryption/encryption.service'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { hasOrganizationResourcePermissions } from '../organization/guards/organization-resource-action.guard'
import { SystemRole } from '../user/enums/system-role.enum'
import { CloudAppResources } from './cloud-app-resources'
import { CloudAppSourceStore } from './cloud-app-source-store'
import { CloudAppCredentials } from './cloud-app-credentials'
import { CloudAppDomains } from './cloud-app-domains'
import { Store } from './engine/db'
import { buildCtx, createServer } from './engine/server'
import { defaultPools, PgAppDatabase } from './engine/appdb'
import { DbReaders } from './engine/dbreader'
import { HttpNeonClient } from './engine/neon'
import { HttpSupervisorClient } from './engine/supervisor'
import { Ctx } from './engine/ctx'
import { PlatformPrincipal } from './engine/platform-principal'
import { safeEqual, sha256hex } from './engine/auth'
import { serveAppOrigin } from './engine/proxy/app-origin'
import { handleUpgrade } from './engine/proxy/upgrade'
import { ensureSqlParser } from './engine/sqlguard'

@Injectable()
export class CloudAppService implements OnModuleInit {
  private readonly contexts = new Map<string, Ctx>()
  private readonly servers = new Map<string, Hono>()
  readonly artifactDirectory = join(process.cwd(), 'dist/apps/cloud-app-artifacts')

  constructor(
    private readonly config: TypedConfigService,
    readonly database: DataSource,
    private readonly encryption: EncryptionService,
    private readonly resources: CloudAppResources,
    private readonly sources: CloudAppSourceStore,
    private readonly credentials: CloudAppCredentials,
    private readonly domains: CloudAppDomains,
    private readonly organizations: OrganizationService,
  ) {}

  async onModuleInit() {
    if (this.config.get('cloudApps.publicUrl')) await ensureSqlParser()
  }

  context(organizationId: string): Ctx {
    const settings = this.config.get('cloudApps')
    if (!settings.publicUrl) throw new ServiceUnavailableException('Cloud Apps is not configured')
    const cached = this.contexts.get(organizationId)
    if (cached) return cached
    const managementUrl = `${new URL(settings.publicUrl).origin}/api/v1/${organizationId}`
    const artifactUrl = settings.artifactUrl || `${settings.publicUrl}/artifacts/${settings.artifactVersion}`
    const store = new Store(this.database, organizationId, this.encryption)
    const neon = new HttpNeonClient(
      settings.neon.apiKey || '',
      settings.neon.organizationId || '',
      settings.neon.region || '',
      settings.neon.apiUrl,
      settings.neon.pgVersion,
      settings.neon.database,
      settings.neon.role,
    )
    const appdb = new PgAppDatabase()
    const ctx = buildCtx(
      {
        publicUrl: settings.publicUrl,
        managementUrl,
        artifactUrl,
        sessionSecret: settings.sessionSecret!,
        identityPrivateKey: settings.identityPrivateKey!,
        runtimeImages: settings.runtimeImages,
        diskSizeGb: settings.diskSizeGb,
        autoStopSeconds: settings.autoStopSeconds,
        oauth: settings.oauth,
        domainsEnabled: true,
        svBinDir: this.artifactDirectory,
        cliTgzPath: join(this.artifactDirectory, 'boxlite-app.tgz'),
        agentMdPath: join(this.artifactDirectory, 'agent.md'),
        promptTemplatePath: join(this.artifactDirectory, 'prompt-template.md'),
      },
      {
        store,
        blobs: this.sources,
        credentials: this.credentials,
        domains: this.domains,
        volumes: this.resources.volumesForOrganization(organizationId),
        boxes: this.resources.boxesForOrganization(organizationId),
        boxlite: this.resources.forOrganization(organizationId),
        neon,
        appdb,
        supervisor: new HttpSupervisorClient((url) => this.resources.tunnelHeaders(url)),
        tunnelHeaders: (url) => this.resources.tunnelHeaders(url),
        origins: {
          apiUrl: settings.publicUrl,
          consoleUrl: () => this.config.get('dashboardUrl') || new URL(settings.publicUrl!).origin,
          envUrl: async (env) => {
            const app = await store.appById(env.app_id)
            if (!app) throw new NotFoundException('App not found')
            return this.domains.ensureEnvironment(app, env)
          },
        },
        organizationMember: async (org, provider, id) => {
          const rows = await this.database.query(
            'SELECT 1 FROM organization_user WHERE "organizationId" = $1 AND "userId" = $2',
            [org, `${provider}|${id}`],
          )
          return rows.length > 0
        },
      },
      {
        supervisorReadyMs: settings.startupTimeoutMs,
        buildMs: settings.buildTimeoutMs,
        activateMs: settings.startupTimeoutMs,
        pollMs: 2000,
      },
    )
    appdb.bindReaders(new DbReaders({ store, neon, connect: defaultPools.acquire }))
    this.contexts.set(organizationId, ctx)
    this.servers.set(organizationId, createServer(ctx))
    return ctx
  }

  principal(auth: OrganizationAuthContext, method: string, path: string): PlatformPrincipal {
    const { apiKey } = auth
    if (apiKey && apiKey.organizationId !== auth.organizationId) {
      throw new ForbiddenException('API key belongs to another organization')
    }
    this.organizations.assertOrganizationIsNotSuspended(auth.organization)
    const permission =
      method === 'GET' || method === 'HEAD'
        ? Permission.READ_APPS
        : method === 'DELETE' && /^\/apps\/[^/]+\/?$/.test(path)
          ? Permission.DELETE_APPS
          : Permission.WRITE_APPS
    const permissions = apiKey
      ? apiKey.permissions
      : Object.values(Permission).filter((value) => hasOrganizationResourcePermissions(auth, [value]))
    if (!permissions.includes(permission)) throw new ForbiddenException('App permission required')
    return {
      organizationId: auth.organizationId,
      userId: auth.userId,
      actor: apiKey ? `key:…${apiKey.keySuffix}` : `user:${auth.userId}`,
      permissions,
      admin: auth.role === SystemRole.ADMIN,
      email: auth.email,
    }
  }

  async management(request: Request, principal: PlatformPrincipal): Promise<Response> {
    this.context(principal.organizationId)
    return this.servers.get(principal.organizationId)!.fetch(request, { platformPrincipal: principal })
  }

  async internal(request: Request, organizationId: string): Promise<Response> {
    this.context(organizationId)
    return this.servers.get(organizationId)!.fetch(request)
  }

  async supervisorOrganization(token: string): Promise<string> {
    const [row] = await this.database.query(
      'SELECT a.org_id FROM cloud_app.box_tokens t JOIN cloud_app.envs e ON e.id = t.env_id JOIN cloud_app.apps a ON a.id = e.app_id WHERE t.hash = $1 AND t.revoked_at IS NULL AND a.deleted_at IS NULL',
      [sha256hex(token)],
    )
    if (!row) throw new ForbiddenException('Invalid Supervisor credential')
    return row.org_id
  }

  async ingressContext(environmentId: string, host: string | undefined, token: string | undefined): Promise<Ctx> {
    const expected = this.config.get('proxy.apiKey')
    if (!expected || !token || !safeEqual(expected, token))
      throw new ForbiddenException('Proxy authentication required')
    const [row] = await this.database.query(
      'SELECT a.org_id FROM domain d JOIN cloud_app.envs e ON e.id = d.environment_id JOIN cloud_app.apps a ON a.id = e.app_id WHERE d.environment_id = $1 AND d.hostname = $2 AND a.deleted_at IS NULL',
      [environmentId, host?.toLowerCase().split(':')[0]],
    )
    if (!row) throw new NotFoundException('App domain not found')
    const organization = await this.organizations.findOne(row.org_id)
    this.organizations.assertOrganizationIsNotSuspended(organization)
    return this.context(row.org_id)
  }

  async ingress(request: Request, environmentId: string, incoming: IncomingMessage): Promise<Response> {
    const ctx = await this.ingressContext(
      environmentId,
      incoming.headers.host,
      incoming.headers['x-boxlite-proxy-token'] as string,
    )
    request.headers.delete('x-boxlite-proxy-token')
    const env = await ctx.store.envById(environmentId)
    if (!env) throw new NotFoundException('App environment not found')
    const gateway = new Hono()
    gateway.all('*', (c) => serveAppOrigin(ctx, c, env))
    return gateway.fetch(request, { incoming })
  }

  async upgradeIngress(req: IncomingMessage, socket: Duplex, head: Buffer, environmentId: string): Promise<void> {
    const ctx = await this.ingressContext(
      environmentId,
      req.headers.host,
      req.headers['x-boxlite-proxy-token'] as string,
    )
    delete req.headers['x-boxlite-proxy-token']
    req.url = (req.url || '/').replace(/^\/api\/internal\/apps\/ingress\/[^/?]+/, '') || '/'
    await handleUpgrade(ctx, req, socket, head, environmentId)
  }
}
