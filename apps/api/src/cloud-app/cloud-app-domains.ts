import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { DomainService } from '../box/services/domain.service'
import type { AppRow, EnvRow } from './engine/db'
import type { AppDomains, DomainView } from './engine/services/domains'

/** App environments share the platform's domain ownership, quota and proxy routing. */
@Injectable()
export class CloudAppDomains implements AppDomains {
  constructor(
    private readonly domains: DomainService,
    private readonly database: DataSource,
  ) {}

  async ensureEnvironment(app: AppRow, env: EnvRow): Promise<string> {
    if (env.public_url) return env.public_url
    const held = await this.domains.claim(app.org_id, `app-${env.id.replaceAll('_', '')}`)
    const bound = await this.domains.bindApp(app.org_id, app.id, env.id, held.hostname)
    await this.database.query('UPDATE cloud_app.envs SET public_url = $1 WHERE id = $2 AND app_id = $3', [
      bound.url,
      env.id,
      app.id,
    ])
    env.public_url = bound.url
    return bound.url
  }

  async releaseEnvironment(app: AppRow, env: EnvRow): Promise<void> {
    const label = `app-${env.id.replaceAll('_', '')}`
    const primary = env.public_url
      ? new URL(env.public_url).hostname
      : this.domains.appDomain()?.appHost
        ? `${label}.${this.domains.appDomain()!.appHost}`
        : null
    await this.database.transaction(async (manager) => {
      if (primary?.startsWith(`${label}.`)) {
        await manager.query(
          'DELETE FROM "domain" WHERE hostname = $1 AND organization_id = $2 AND target_type = \'app\' AND app_id = $3 AND environment_id = $4',
          [primary, app.org_id, app.id, env.id],
        )
      }
      await manager.query(
        'UPDATE "domain" SET app_id = NULL, environment_id = NULL, box_id = NULL, port = NULL, updated_at = now() WHERE organization_id = $1 AND target_type = \'app\' AND app_id = $2 AND environment_id = $3',
        [app.org_id, app.id, env.id],
      )
    })
  }

  async list(app: AppRow, env: EnvRow): Promise<DomainView[]> {
    const held = await this.domains.listHeld(app.org_id)
    return held.domains
      .filter(
        (domain) =>
          domain.target?.type === 'app' &&
          domain.target.app === app.id &&
          domain.target.environment === env.id &&
          domain.url !== env.public_url,
      )
      .map((domain) => this.view(env, domain.hostname))
  }

  async add(app: AppRow, env: EnvRow, rawHost: string, actor: string): Promise<DomainView> {
    const host = this.platformHost(rawHost)
    const held = await this.domains.owned(app.org_id, host)
    if (
      held.target &&
      (held.target.type !== 'app' || held.target.app !== app.id || held.target.environment !== env.id)
    ) {
      throw new ConflictException(
        'Unbind this domain from its current target in Dashboard > Domains before binding it here',
      )
    }
    await this.domains.bindApp(app.org_id, app.id, env.id, host)
    await this.activity(app, env, actor, 'domain.add', host)
    return this.view(env, host)
  }

  async verify(app: AppRow, env: EnvRow, rawHost: string, _actor: string): Promise<DomainView> {
    const host = this.platformHost(rawHost)
    const held = await this.domains.listHeld(app.org_id)
    if (
      !held.domains.some(
        (domain) =>
          domain.hostname === host &&
          domain.target?.type === 'app' &&
          domain.target.app === app.id &&
          domain.target.environment === env.id,
      )
    ) {
      throw new NotFoundException('Domain is not bound to this App environment')
    }
    return this.view(env, host)
  }

  async remove(app: AppRow, env: EnvRow, rawHost: string, actor: string): Promise<{ removed: string }> {
    const host = this.platformHost(rawHost)
    if (env.public_url && new URL(env.public_url).hostname === host) {
      throw new BadRequestException('The environment keeps its default platform domain')
    }
    await this.verify(app, env, host, actor)
    await this.domains.unbind(app.org_id, host)
    await this.activity(app, env, actor, 'domain.remove', host)
    return { removed: host }
  }

  async verifiedHost(env: EnvRow, rawHost: string | null | undefined): Promise<string | null> {
    if (!rawHost) return null
    const host = rawHost.trim().toLowerCase().split(':')[0]!.replace(/\.$/, '')
    const target = await this.domains.resolve(host)
    return target?.type === 'app' && target.app === env.app_id && target.environment === env.id ? host : null
  }

  private platformHost(rawHost: string): string {
    const host = rawHost.trim().toLowerCase().replace(/\.$/, '')
    const suffix = this.domains.appDomain()?.appHost
    if (!suffix || !host.endsWith(`.${suffix}`)) {
      throw new BadRequestException(
        'Bind a platform domain held by your organization; request one in Dashboard > Domains',
      )
    }
    return host
  }

  private view(env: EnvRow, host: string): DomainView {
    return { host, env: env.name, status: 'active', records: [], verified_at: null }
  }

  private async activity(app: AppRow, env: EnvRow, actor: string, action: string, host: string): Promise<void> {
    await this.database.query(
      'INSERT INTO cloud_app.activity (app_id, env, actor, action, detail, ts) VALUES ($1, $2, $3, $4, $5::jsonb, now())',
      [app.id, env.name, actor, action, JSON.stringify({ host })],
    )
  }
}
