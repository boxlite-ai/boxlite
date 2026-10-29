/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { DNS_LABEL_MAX_LENGTH } from '../../config/configuration'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { RegionService } from '../../region/services/region.service'
import { Box } from '../entities/box.entity'
import { Domain, DomainTarget } from '../entities/domain.entity'
import {
  DomainCountLimitReachedError,
  PlatformDomainNotConfiguredError,
  RegionNotSupportedError,
  SubdomainTakenError,
  SubdomainTooShortError,
} from '../errors/domain.error'

/**
 * The collections mounted under `v1/:prefix/`. A name equal to one of them
 * makes `/v1/domains/<name>/target` also match `v1/:prefix/<name>/:id` —
 * `DELETE /v1/domains/boxes/target` would read as deleting box `target` — so
 * no such name can be claimed. The REST controller spec derives this list
 * from the registered routes and fails when a new collection is missing.
 */
export const REST_COLLECTION_NAMES: readonly string[] = ['boxes', 'domains', 'images', 'volumes']

/**
 * Names under the app domain that would read as the platform's own, whose
 * shape collides with something else that resolves there, or that would make
 * the REST route for the name ambiguous. `^\d+-` is refused because
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

type StoredTarget = Pick<Domain, 'targetType' | 'boxId' | 'appId' | 'port'>

export type HeldDomains = {
  domains: HeldDomain[]
  limit: number
  used: number
  remaining: number
  /** The shortest platform subdomain a new claim may use. */
  minLength: number
}

/**
 * Organization-owned hostnames and their typed targets; binding supports Box ports.
 *
 * A name and a tunnel are separate resources. Binding records which box port
 * a name routes to, under the organization row lock that also holds the count
 * of names against `domainCountLimit`; it neither declares the port public nor
 * needs it to be, and several names may route to one port. Unbinding is by
 * full hostname and keeps it held. Box destruction and tunnel revocation preserve
 * bindings; only explicit unbind or rebind changes the stored target. Resolution
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
   * configured minimum is a claim-time rule, checked by `bind` for new names
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

  /**
   * The stored hostname a caller's domain names. A bare label is a platform
   * name under the app domain; a dotted value is a full hostname, accepted
   * only under the app domain until custom domains exist (POL-1122). Case and
   * a trailing root dot are not significant.
   */
  hostnameFor(rawDomain: string, appHost: string): string {
    const domain = rawDomain.trim().toLowerCase().replace(/\.$/, '')
    if (!domain.includes('.')) {
      return `${this.parseSubdomain(domain)}.${appHost}`
    }
    const suffix = `.${appHost}`
    if (!domain.endsWith(suffix)) {
      throw new BadRequestError(`Domain "${rawDomain}" is not under ${appHost}; only platform names can be bound`)
    }
    return `${this.parseSubdomain(domain.slice(0, -suffix.length))}${suffix}`
  }

  /**
   * Bind `domain` to the box port and return the bound name. The port's public
   * declaration is not touched: the name answers once the port is public.
   * Repeating the same binding is a no-op, a name bound to another of the
   * organization's ports moves here, and other names on this port stay.
   */
  async bind(box: Box, port: number, rawDomain: string): Promise<HeldDomain> {
    const platform = this.appDomain()
    if (!platform) {
      throw new PlatformDomainNotConfiguredError()
    }
    const hostname = this.hostnameFor(rawDomain, platform.appHost)
    const subdomain = hostname.slice(0, hostname.indexOf('.'))
    await this.assertReachableFromPlatformProxy(box)

    await this.dataSource.transaction(async (manager) => {
      const limit = await this.lockOrganizationLimit(manager, box.organizationId)

      const held = await manager.findOne(Domain, { where: { hostname } })
      if (held && held.organizationId !== box.organizationId) {
        throw new SubdomainTakenError(hostname)
      }
      if (!held) {
        const minLength = this.configService.getOrThrow('domain.platformSubdomainMinLength')
        if (subdomain.length < minLength) {
          throw new SubdomainTooShortError(subdomain, minLength)
        }
        const used = await manager.count(Domain, { where: { organizationId: box.organizationId } })
        if (used >= limit) {
          throw new DomainCountLimitReachedError(limit, used)
        }
      }

      // The hostname's unique constraint decides a race between organizations
      // for a new name: the loser's upsert matches no row and binds nothing.
      // Within the organization the row lock above orders binds, so moving a
      // name off another port is a plain update.
      const bound: { id: string }[] = await manager.query(
        `INSERT INTO "domain" ("hostname", "kind", "organization_id", "box_id", "port")
         VALUES ($1, 'platform', $2, $3, $4)
         ON CONFLICT ("hostname") DO UPDATE
         SET "box_id" = EXCLUDED."box_id", "port" = EXCLUDED."port", "target_type" = 'box', "app_id" = NULL, "updated_at" = now()
         WHERE "domain"."organization_id" = EXCLUDED."organization_id"
         RETURNING "id"`,
        [hostname, box.organizationId, box.id, port],
      )
      if (bound.length === 0) {
        throw new SubdomainTakenError(hostname)
      }
    })
    return { hostname, url: this.urlFor(hostname), target: { type: 'box', box: box.id, port } }
  }

  /**
   * Release an exact hostname from its target, keeping the name
   * for the organization. A name the organization does not hold is a 404; one
   * already released is left as it is. The port's own declaration is untouched.
   */
  async unbind(organizationId: string, rawDomain: string): Promise<void> {
    const hostname = rawDomain.trim().toLowerCase().replace(/\.$/, '')
    if (
      !hostname.includes('.') ||
      hostname.length > 253 ||
      hostname.split('.').some((label) => label.length > DNS_LABEL_MAX_LENGTH || !SUBDOMAIN_PATTERN.test(label))
    ) {
      throw new BadRequestError('Unbind requires a full hostname, such as demo.apps.example')
    }
    // TypeORM answers an UPDATE with [rows, rowCount]; the count says whether
    // the organization holds the name, bound or not.
    const [, released]: [unknown[], number] = await this.dataSource.query(
      `UPDATE "domain" SET "box_id" = NULL, "app_id" = NULL, "port" = NULL, "updated_at" = now()
       WHERE "hostname" = $1 AND "organization_id" = $2`,
      [hostname, organizationId],
    )
    if (released === 0) {
      throw new NotFoundException(`This organization holds no domain ${hostname}`)
    }
  }

  /**
   * The stored typed target, or null for an unknown or unbound name.
   * Lookup is uncached and independent of the target's publication or access
   * policy. Callers admitting traffic must authorize the returned target.
   */
  async resolve(rawHostname: string): Promise<DomainTarget | null> {
    const hostname = rawHostname.trim().toLowerCase()
    const rows: StoredTarget[] = await this.dataSource.query(
      `SELECT "target_type" AS "targetType", "box_id" AS "boxId", "app_id" AS "appId", "port"
       FROM "domain" WHERE "hostname" = $1`,
      [hostname],
    )
    if (rows.length === 0) {
      return null
    }
    return this.targetOf(rows[0])
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
      `SELECT "hostname", "target_type" AS "targetType", "box_id" AS "boxId", "app_id" AS "appId", "port" FROM "domain"
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
    }
  }

  private targetOf(row: StoredTarget): DomainTarget | null {
    if (row.targetType === 'app') {
      return row.appId === null ? null : { type: 'app', app: row.appId }
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
