/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { DNS_LABEL_MAX_LENGTH } from '../../config/configuration'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { RegionService } from '../../region/services/region.service'
import { BoxEvents } from '../constants/box-events.constants'
import { Box } from '../entities/box.entity'
import { TunnelDomain, TunnelDomainKind } from '../entities/tunnel-domain.entity'
import { BoxDestroyedEvent } from '../events/box-destroyed.event'
import {
  DomainCountLimitReachedError,
  PlatformDomainNotConfiguredError,
  RegionNotSupportedError,
  SubdomainTakenError,
  SubdomainTooShortError,
} from '../errors/tunnel-domain.error'
import { TunnelService } from './tunnel.service'

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

/** A name the organization holds and the box port it routes to, if any. */
export type HeldDomain = {
  /** What the caller binds by: the label for a platform name. */
  name: string
  hostname: string
  url: string
  /** The bound box, or null while the name is held but unbound. */
  boxId: string | null
  port: number | null
}

export type HeldDomains = {
  domains: HeldDomain[]
  limit: number
  used: number
  remaining: number
  /** The shortest platform subdomain a new claim may use. */
  minLength: number
}

/**
 * Platform subdomains for public tunnels: `demo.<appDomain>` routes to one
 * box port, and the name belongs to the organization that claimed it.
 *
 * A name and a tunnel are separate resources. Binding records which box port
 * a name routes to, under the organization row lock that also holds the count
 * of names against `domainCountLimit`; it neither declares the port public nor
 * needs it to be, and several names may route to one port. Unbinding is by
 * name and keeps it held; destroying the box releases its bindings the same
 * way; revoking the tunnel does not touch them. Resolution for the proxy runs
 * the port's own public access check, so an unbound target, an undeclared or
 * revoked port, or an inbound-disabled box is a 404, never a stale forward.
 */
@Injectable()
export class TunnelDomainService {
  private readonly logger = new Logger(TunnelDomainService.name)

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly regionService: RegionService,
    private readonly tunnelService: TunnelService,
    private readonly configService: TypedConfigService,
  ) {}

  /**
   * The parent of every platform subdomain, or undefined where this deployment
   * has none. `appHost` is the hostname names are stored and resolved under;
   * `appDomain` may add the port a local proxy listens on, for the URL only.
   */
  appDomain(): { appDomain: string; appHost: string } | undefined {
    const appDomain = this.configService.get('tunnelDomain.appDomain')
    const appHost = this.configService.get('tunnelDomain.appHost')
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
    const subdomain = this.nameOf(hostname, 'platform')
    await this.assertReachableFromPlatformProxy(box)

    await this.dataSource.transaction(async (manager) => {
      const limit = await this.lockOrganizationLimit(manager, box.organizationId)

      const held = await manager.findOne(TunnelDomain, { where: { hostname } })
      if (held && held.organizationId !== box.organizationId) {
        throw new SubdomainTakenError(hostname)
      }
      if (!held) {
        const minLength = this.configService.getOrThrow('tunnelDomain.platformSubdomainMinLength')
        if (subdomain.length < minLength) {
          throw new SubdomainTooShortError(subdomain, minLength)
        }
        const used = await manager.count(TunnelDomain, { where: { organizationId: box.organizationId } })
        if (used >= limit) {
          throw new DomainCountLimitReachedError(limit, used)
        }
      }

      // The hostname's unique constraint decides a race between organizations
      // for a new name: the loser's upsert matches no row and binds nothing.
      // Within the organization the row lock above orders binds, so moving a
      // name off another port is a plain update.
      const bound: { id: string }[] = await manager.query(
        `INSERT INTO "tunnel_domain" ("hostname", "kind", "organization_id", "box_id", "port")
         VALUES ($1, 'platform', $2, $3, $4)
         ON CONFLICT ("hostname") DO UPDATE
         SET "box_id" = EXCLUDED."box_id", "port" = EXCLUDED."port", "updated_at" = now()
         WHERE "tunnel_domain"."organization_id" = EXCLUDED."organization_id"
         RETURNING "id"`,
        [hostname, box.organizationId, box.id, port],
      )
      if (bound.length === 0) {
        throw new SubdomainTakenError(hostname)
      }
    })
    return { name: subdomain, hostname, url: this.urlFor(hostname), boxId: box.id, port }
  }

  /**
   * Release a platform name from whatever port it routes to, keeping the name
   * for the organization. A name the organization does not hold is a 404; one
   * already released is left as it is. The port's own declaration is untouched.
   */
  async unbind(organizationId: string, rawDomain: string): Promise<void> {
    const platform = this.appDomain()
    if (!platform) {
      throw new PlatformDomainNotConfiguredError()
    }
    const hostname = this.hostnameFor(rawDomain, platform.appHost)
    // TypeORM answers an UPDATE with [rows, rowCount]; the count says whether
    // the organization holds the name, bound or not.
    const [, released]: [unknown[], number] = await this.dataSource.query(
      `UPDATE "tunnel_domain" SET "box_id" = NULL, "port" = NULL, "updated_at" = now()
       WHERE "hostname" = $1 AND "organization_id" = $2`,
      [hostname, organizationId],
    )
    if (released === 0) {
      throw new NotFoundException(`This organization holds no tunnel domain ${hostname}`)
    }
  }

  /**
   * The box port a hostname may be forwarded to right now, or null. Applies
   * the public-declaration, inbound and box-state rules of a public tunnel,
   * with that check's 3-second cache; the hostname lookup itself is not cached.
   */
  async resolve(rawHostname: string): Promise<{ boxId: string; port: number } | null> {
    const hostname = rawHostname.trim().toLowerCase()
    const rows: { boxId: string; port: number }[] = await this.dataSource.query(
      `SELECT "box_id" AS "boxId", "port" FROM "tunnel_domain" WHERE "hostname" = $1 AND "box_id" IS NOT NULL`,
      [hostname],
    )
    if (rows.length === 0) {
      return null
    }
    const target = { boxId: rows[0].boxId, port: Number(rows[0].port) }
    return (await this.tunnelService.isPublicAccessAllowed(target.boxId, target.port)) ? target : null
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
    const rows: { hostname: string; kind: TunnelDomainKind; boxId: string | null; port: number | null }[] =
      await this.dataSource.query(
        `SELECT "hostname", "kind", "box_id" AS "boxId", "port" FROM "tunnel_domain"
         WHERE "organization_id" = $1 ORDER BY "hostname"`,
        [organizationId],
      )
    const limit = Number(organization.limit)
    return {
      domains: rows.map((row) => ({
        name: this.nameOf(row.hostname, row.kind),
        hostname: row.hostname,
        url: this.urlFor(row.hostname),
        boxId: row.boxId,
        // A box deleted outright clears box_id only; its port is not a target.
        port: row.boxId === null ? null : Number(row.port),
      })),
      limit,
      used: rows.length,
      remaining: Math.max(0, limit - rows.length),
      minLength: this.configService.getOrThrow('tunnelDomain.platformSubdomainMinLength'),
    }
  }

  /**
   * A destroyed box is soft-deleted: its row stays, so the names bound to it
   * are released here and kept for the organization. The access check already
   * refuses the box by state; this frees the names for rebinding. A box row
   * deleted outright clears them through the foreign key instead.
   */
  @OnEvent(BoxEvents.DESTROYED)
  async releaseBoxBindings(event: BoxDestroyedEvent): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE "tunnel_domain" SET "box_id" = NULL, "port" = NULL, "updated_at" = now() WHERE "box_id" = $1`,
        [event.box.id],
      )
    } catch (error) {
      this.logger.error(`Failed to release the platform domains of destroyed box ${event.box.id}`, error)
    }
  }

  /** What a caller binds a stored hostname by: the label of a platform name, a custom hostname whole. */
  private nameOf(hostname: string, kind: TunnelDomainKind): string {
    return kind === 'platform' ? hostname.slice(0, hostname.indexOf('.')) : hostname
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
