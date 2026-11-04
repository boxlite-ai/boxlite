/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { DNS_LABEL_MAX_LENGTH } from '../../config/configuration'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { RegionService } from '../../region/services/region.service'
import { Box } from '../entities/box.entity'
import { Domain, DomainTarget } from '../entities/domain.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import {
  DomainCountLimitReachedError,
  DomainNotOwnedError,
  PlatformDomainNotConfiguredError,
  RegionNotSupportedError,
  SubdomainTakenError,
  SubdomainTooShortError,
} from '../errors/domain.error'

/**
 * REST collection names remain reserved alongside the platform's own labels.
 * The controller spec derives this list from registered routes to keep that
 * naming policy consistent when a collection is added.
 */
export const REST_COLLECTION_NAMES: readonly string[] = ['apps', 'boxes', 'checkpoints', 'domains', 'images', 'volumes']

/**
 * Names under the app domain that would read as the platform's own or whose
 * shape collides with another kind of host. `^\d+-` is refused because
 * `3000-abc.<appDomain>` is also the shape of a legacy port-box host.
 */
export const RESERVED_PLATFORM_SUBDOMAINS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'console',
  'dashboard',
  'docs',
  'login',
  'mail',
  'proxy',
  'status',
  'www',
  ...REST_COLLECTION_NAMES,
])
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const LEGACY_PORT_PREFIX = /^\d+-/

/** A hostname the organization holds and its target, if any. */
export type HeldDomain = {
  hostname: string
  url: string
  target: DomainTarget | null
}

type StoredTarget = Pick<Domain, 'targetType' | 'boxId' | 'appId' | 'port'> & { environmentId?: string | null }

export type HeldDomains = {
  domains: HeldDomain[]
  limit: number
  used: number
  remaining: number
  /** The shortest platform subdomain a new claim may use. */
  minLength: number
  domainSuffix: string | null
}

/**
 * Organization-owned hostnames route to Box ports or App environments.
 *
 * A name and a tunnel are separate resources. Binding records which box port
 * a name routes to. Claiming separately holds the organization row lock to enforce
 * `domainCountLimit`; binding neither declares the port public nor
 * needs it to be, and several names may route to one port. Unbinding is by
 * full hostname and keeps it held. Box destruction and tunnel revocation preserve
 * bindings while the organization exists; organization deletion releases its
 * names. Otherwise only explicit unbind or rebind changes the stored target. Resolution
 * returns that target; the preview controller applies the port's public access policy.
 */
@Injectable()
export class DomainService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly regionService: RegionService,
    private readonly configService: TypedConfigService,
  ) {}

  /**
   * The parent of every platform subdomain, or undefined where this deployment
   * has none. `appHost` is the hostname names are stored and resolved under;
   * `appDomain` may add the port a local proxy listens on, for the URL only.
   */
  appDomain(): { appDomain: string; appHost: string } | undefined {
    const appDomain = this.configService.get('domain.appDomain')
    const appHost = this.configService.get('domain.appHost')
    return appDomain && appHost ? { appDomain, appHost } : undefined
  }

  /**
   * Lowercase and validate the name a caller picked. Length against the
   * configured minimum is a claim-time rule, checked by `claim` for new names
   * only, so a name held before the minimum rose stays bindable.
   */
  parseSubdomain(raw: string): string {
    const subdomain = raw.trim().toLowerCase()
    if (subdomain.length > DNS_LABEL_MAX_LENGTH || !SUBDOMAIN_PATTERN.test(subdomain)) {
      throw new BadRequestError(
        `Invalid subdomain "${raw}": use 1-${DNS_LABEL_MAX_LENGTH} lowercase letters, digits and hyphens, not starting or ending with a hyphen`,
      )
    }
    if (LEGACY_PORT_PREFIX.test(subdomain) || RESERVED_PLATFORM_SUBDOMAINS.has(subdomain)) {
      throw new BadRequestError(`Subdomain "${subdomain}" is reserved`)
    }
    return subdomain
  }

  /** Claim a short platform name without binding it or changing an existing target. */
  async claim(organizationId: string, rawName: string): Promise<HeldDomain> {
    const platform = this.appDomain()
    if (!platform) {
      throw new PlatformDomainNotConfiguredError()
    }
    const subdomain = this.parseSubdomain(rawName)
    const hostname = this.fullHostname(`${subdomain}.${platform.appHost}`, 'Claim')
    return this.dataSource.transaction(async (manager) => {
      const limit = await this.lockOrganizationLimit(manager, organizationId)
      const held = await manager.findOne(Domain, { where: { hostname } })
      if (held) {
        if (held.organizationId !== organizationId) {
          throw new SubdomainTakenError(hostname)
        }
        return { hostname, url: this.urlFor(hostname), target: this.targetOf(held) }
      }
      const minLength = this.configService.getOrThrow('domain.platformSubdomainMinLength')
      if (subdomain.length < minLength) {
        throw new SubdomainTooShortError(subdomain, minLength)
      }
      const used = await manager.count(Domain, { where: { organizationId } })
      if (used >= limit) {
        throw new DomainCountLimitReachedError(limit, used)
      }
      // Organizations lock different rows. The unique hostname resolves their
      // race without overwriting the winner's ownership or target.
      const claimed: { id: string }[] = await manager.query(
        `INSERT INTO "domain" ("hostname", "kind", "organization_id")
         VALUES ($1, 'platform', $2)
         ON CONFLICT ("hostname") DO NOTHING RETURNING "id"`,
        [hostname, organizationId],
      )
      if (claimed.length === 0) {
        throw new SubdomainTakenError(hostname)
      }
      return { hostname, url: this.urlFor(hostname), target: null }
    })
  }

  /** Route an already owned full hostname to a Box port; never allocate a name. */
  async bind(box: Box, port: number, rawDomain: string): Promise<HeldDomain> {
    const hostname = this.fullHostname(rawDomain, 'Bind')
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '5s'`)
      // Serialize target admission with destroy requests and physical deletion;
      // the controller's earlier Box lookup may already be stale.
      const current = await manager.findOne(Box, {
        where: { id: box.id, organizationId: box.organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!current || current.state === BoxState.DESTROYED || current.desiredState === BoxDesiredState.DESTROYED) {
        throw new NotFoundException(`Box ${box.id} not found`)
      }
      await this.assertManagedDomain(manager, current.organizationId, hostname)
      await this.assertReachableFromPlatformProxy(current)
      const [, bound]: [unknown[], number] = await manager.query(
        `UPDATE "domain" SET "box_id" = $3, "port" = $4, "target_type" = 'box', "app_id" = NULL, "environment_id" = NULL, "updated_at" = now()
         WHERE "hostname" = $1 AND "organization_id" = $2`,
        [hostname, current.organizationId, current.id, port],
      )
      if (bound === 0) {
        throw new DomainNotOwnedError(hostname)
      }
      return { hostname, url: this.urlFor(hostname), target: { type: 'box', box: current.id, port } }
    })
  }

  async bindApp(
    organizationId: string,
    appIdOrName: string,
    environment: string,
    rawDomain: string,
  ): Promise<HeldDomain> {
    const hostname = this.fullHostname(rawDomain, 'Bind')
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '5s'`)
      const [target] = await manager.query(
        `SELECT a.id AS app_id, e.id AS env_id FROM cloud_app.apps a
         JOIN cloud_app.envs e ON e.app_id = a.id
         WHERE a.org_id = $1 AND (a.id = $2 OR a.name = $2) AND a.deleted_at IS NULL
           AND (e.id = $3 OR e.name = $3) FOR UPDATE OF a, e`,
        [organizationId, appIdOrName, environment],
      )
      if (!target) throw new NotFoundException('App environment not found')
      await this.assertManagedDomain(manager, organizationId, hostname, target.app_id, target.env_id)
      const [, bound]: [unknown[], number] = await manager.query(
        `UPDATE "domain" SET target_type = 'app', app_id = $3, environment_id = $4,
         box_id = NULL, port = NULL, updated_at = now()
         WHERE hostname = $1 AND organization_id = $2`,
        [hostname, organizationId, target.app_id, target.env_id],
      )
      if (bound === 0) throw new DomainNotOwnedError(hostname)
      return {
        hostname,
        url: this.urlFor(hostname),
        target: { type: 'app', app: target.app_id, environment: target.env_id },
      }
    })
  }

  async resolveAppEnvironment(appId: string, environmentId: string): Promise<string> {
    const [env] = await this.dataSource.query(
      `SELECT e.id FROM cloud_app.envs e JOIN cloud_app.apps a ON a.id = e.app_id
       WHERE e.id = $1 AND a.id = $2 AND a.deleted_at IS NULL`,
      [environmentId, appId],
    )
    if (!env) throw new NotFoundException('App environment not found')
    return env.id
  }

  /**
   * Release an exact hostname from its target, keeping the name
   * for the organization. A name the organization does not hold is a 404; one
   * already released is left as it is. The port's own declaration is untouched.
   */
  async unbind(organizationId: string, rawDomain: string): Promise<string> {
    const hostname = this.fullHostname(rawDomain, 'Unbind')
    await this.dataSource.transaction(async (manager) => {
      await this.assertManagedDomain(manager, organizationId, hostname)
      // TypeORM returns an UPDATE's rows and row count, including when the name was already unbound.
      const [, released]: [unknown[], number] = await manager.query(
        `UPDATE "domain" SET "box_id" = NULL, "app_id" = NULL, "environment_id" = NULL, "port" = NULL, "updated_at" = now()
         WHERE "hostname" = $1 AND "organization_id" = $2`,
        [hostname, organizationId],
      )
      if (released === 0) throw new NotFoundException(`This organization holds no domain ${hostname}`)
    })
    return hostname
  }

  /**
   * The stored typed target, or null for an unknown or unbound name.
   * Lookup is uncached and independent of the target's publication or access
   * policy. Callers admitting traffic must authorize the returned target.
   */
  async resolve(rawHostname: string): Promise<DomainTarget | null> {
    const hostname = rawHostname.trim().toLowerCase()
    const rows: StoredTarget[] = await this.dataSource.query(
      `SELECT "target_type" AS "targetType", "box_id" AS "boxId", "app_id" AS "appId", "environment_id" AS "environmentId", "port"
       FROM "domain" WHERE "hostname" = $1`,
      [hostname],
    )
    if (rows.length === 0) {
      return null
    }
    return this.targetOf(rows[0])
  }

  async owned(organizationId: string, rawDomain: string): Promise<HeldDomain> {
    const hostname = this.fullHostname(rawDomain, 'Domain lookup')
    const rows: StoredTarget[] = await this.dataSource.query(
      `SELECT "target_type" AS "targetType", "box_id" AS "boxId", "app_id" AS "appId", "environment_id" AS "environmentId", "port"
       FROM "domain" WHERE "hostname" = $1 AND "organization_id" = $2`,
      [hostname, organizationId],
    )
    if (!rows[0]) throw new DomainNotOwnedError(hostname)
    return { hostname, url: this.urlFor(hostname), target: this.targetOf(rows[0]) }
  }

  /** Every name the organization holds, bound or not, with its allowance. */
  async listHeld(organizationId: string): Promise<HeldDomains> {
    const [organization]: { limit: number }[] = await this.dataSource.query(
      `SELECT "domain_count_limit" AS "limit" FROM "organization" WHERE "id" = $1`,
      [organizationId],
    )
    if (!organization) {
      throw new NotFoundException(`Organization ${organizationId} not found`)
    }
    const rows: (StoredTarget & { hostname: string })[] = await this.dataSource.query(
      `SELECT "hostname", "target_type" AS "targetType", "box_id" AS "boxId", "app_id" AS "appId", "environment_id" AS "environmentId", "port" FROM "domain"
         WHERE "organization_id" = $1 ORDER BY "hostname"`,
      [organizationId],
    )
    const limit = Number(organization.limit)
    return {
      domains: rows.map((row) => ({
        hostname: row.hostname,
        url: this.urlFor(row.hostname),
        target: this.targetOf(row),
      })),
      limit,
      used: rows.length,
      remaining: Math.max(0, limit - rows.length),
      minLength: this.configService.getOrThrow('domain.platformSubdomainMinLength'),
      domainSuffix: this.appDomain()?.appHost ?? null,
    }
  }

  private fullHostname(raw: string, operation: string): string {
    const hostname = raw.trim().toLowerCase().replace(/\.$/, '')
    if (
      !hostname.includes('.') ||
      hostname.length > 253 ||
      hostname.split('.').some((label) => label.length > DNS_LABEL_MAX_LENGTH || !SUBDOMAIN_PATTERN.test(label))
    ) {
      throw new BadRequestError(`${operation} requires a full hostname, such as demo.apps.example`)
    }
    return hostname
  }

  /** Default App URLs are part of environment identity; aliases remain freely rebindable. */
  private async assertManagedDomain(
    manager: EntityManager,
    organizationId: string,
    hostname: string,
    appId?: string,
    envId?: string,
  ): Promise<void> {
    const [binding] = await manager.query(
      'SELECT target_type, app_id, environment_id FROM "domain" WHERE hostname = $1 AND organization_id = $2 FOR UPDATE',
      [hostname, organizationId],
    )
    if (binding?.target_type !== 'app' || !binding.environment_id) return
    const [environment] = await manager.query('SELECT public_url FROM cloud_app.envs WHERE id = $1 AND app_id = $2', [
      binding.environment_id,
      binding.app_id,
    ])
    if (
      environment?.public_url &&
      new URL(environment.public_url).hostname === hostname &&
      (appId !== binding.app_id || envId !== binding.environment_id)
    ) {
      throw new BadRequestException({
        code: 'app_domain_managed',
        message: 'The default App domain is managed by its environment and cannot be moved or unbound',
      })
    }
  }

  private targetOf(row: StoredTarget): DomainTarget | null {
    if (row.targetType === 'app') {
      return row.appId === null
        ? null
        : { type: 'app', app: row.appId, ...(row.environmentId ? { environment: row.environmentId } : {}) }
    }
    return row.boxId === null ? null : { type: 'box', box: row.boxId, port: Number(row.port) }
  }

  /** The URL a stored hostname serves at: the app domain's port, if any, rejoins it here. */
  private urlFor(hostname: string): string {
    const platform = this.appDomain()
    const authority =
      platform && hostname.endsWith(`.${platform.appHost}`)
        ? `${hostname.slice(0, -platform.appHost.length)}${platform.appDomain}`
        : hostname
    return `${this.configService.getOrThrow('proxy.protocol')}://${authority}`
  }

  /**
   * The platform domain's wildcard record points at the stage's default proxy
   * only. A region served by a proxy of its own cannot be reached that way.
   */
  private async assertReachableFromPlatformProxy(box: Box): Promise<void> {
    const region = await this.regionService.findOne(box.region, true)
    if (!region?.proxyUrl) {
      return
    }
    const regionProxyHost = new URL(region.proxyUrl).host.toLowerCase()
    if (regionProxyHost !== this.configService.getOrThrow('proxy.domain').toLowerCase()) {
      throw new RegionNotSupportedError(box.region)
    }
  }

  /**
   * Lock the organization row for this transaction and read its limit after
   * the lock, so two claims in flight count each other. Same shape as the image
   * catalog's admission (`image-registrar.service.ts`).
   */
  private async lockOrganizationLimit(manager: EntityManager, organizationId: string): Promise<number> {
    await manager.query("SET LOCAL lock_timeout = '5s'")
    const [organization]: { limit: number }[] = await manager.query(
      `SELECT "domain_count_limit" AS "limit" FROM "organization" WHERE "id" = $1 FOR UPDATE`,
      [organizationId],
    )
    if (!organization) {
      throw new NotFoundException(`Organization ${organizationId} not found`)
    }
    return Number(organization.limit)
  }
}
