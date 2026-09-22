/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { BindBoxEndpointDto, BoxEndpointDto } from '../dto/box-endpoint.dto'

@Injectable()
export class BoxEndpointService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: TypedConfigService,
  ) {}

  async list(organizationId: string): Promise<BoxEndpointDto[]> {
    return this.dataSource.query(
      `SELECT "name", "boxId", "port", "region", "url", "enabled"
       FROM "box_endpoint" WHERE "organizationId" = $1 ORDER BY "name"`,
      [organizationId],
    )
  }

  async bind(organizationId: string, name: string, input: BindBoxEndpointDto): Promise<BoxEndpointDto> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '2s'`)
      // Lock the current owner and region until the binding commits. An earlier
      // cached permission check cannot protect against a concurrent box transfer.
      const [box] = await manager.query(
        `SELECT "id", "region" FROM "box"
         WHERE "organizationId" = $1 AND ("id" = $2 OR "name" = $2)
           AND "state" <> 'destroyed' AND "desiredState" <> 'destroyed'
         ORDER BY ("id" = $2) DESC LIMIT 1 FOR SHARE`,
        [organizationId, input.boxIdOrName],
      )
      if (!box) throw new NotFoundException('Box not found')
      const [region] = await manager.query(`SELECT "proxyUrl" FROM "region" WHERE "id" = $1`, [box.region])
      const url = this.endpointUrl(name, region?.proxyUrl)
      // The unique key arbitrates simultaneous claims. Never recycle an origin:
      // revoked bindings and deleted boxes retain their organization's name.
      const [endpoint] = await manager.query(
        `INSERT INTO "box_endpoint" ("name", "organizationId", "boxId", "region", "port", "url")
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ("name") DO UPDATE SET
           "boxId" = EXCLUDED."boxId", "port" = EXCLUDED."port", "enabled" = true, "updatedAt" = now()
         WHERE "box_endpoint"."organizationId" = EXCLUDED."organizationId"
           AND "box_endpoint"."region" = EXCLUDED."region"
         RETURNING "name", "boxId", "port", "region", "url", "enabled"`,
        [name, organizationId, box.id, box.region, input.port, url],
      )
      if (!endpoint) throw new ConflictException('Endpoint name unavailable in this organization or region')
      return endpoint
    })
  }

  async revoke(organizationId: string, name: string): Promise<void> {
    const [, count] = await this.dataSource.query(
      `UPDATE "box_endpoint" SET "enabled" = false, "updatedAt" = now()
       WHERE "name" = $1 AND "organizationId" = $2 RETURNING "name"`,
      [name, organizationId],
    )
    if (!count) throw new NotFoundException('Endpoint not found')
  }

  async resolve(name: string, regionId?: string): Promise<BoxEndpointDto> {
    const [endpoint] = await this.dataSource.query(
      `SELECT e."name", e."boxId", e."port", e."region", e."url", e."enabled"
       FROM "box_endpoint" e JOIN "box" b ON b."id" = e."boxId"
         AND b."organizationId" = e."organizationId" AND b."region" = e."region"
       WHERE e."name" = $1 AND e."enabled" = true
         AND b."state" <> 'destroyed' AND b."desiredState" <> 'destroyed'
         AND ($2::varchar IS NULL OR e."region" = $2)`,
      [name, regionId ?? null],
    )
    if (!endpoint) throw new NotFoundException('Endpoint not found')
    return endpoint
  }

  private endpointUrl(name: string, regionProxyUrl?: string): string {
    const base =
      regionProxyUrl || `${this.config.getOrThrow('proxy.protocol')}://${this.config.getOrThrow('proxy.domain')}`
    let url: URL
    try {
      url = new URL(base)
    } catch {
      throw new BadRequestException('Invalid proxy URL configuration')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new BadRequestException('Proxy URL must be an HTTP(S) origin')
    }
    url.hostname = `app-${name}.${url.hostname}`
    return url.origin
  }
}
