/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { TypedConfigService } from '../config/typed-config.service'

export const BackofficeWorkloadRouteScope = {
  READINESS: 'GET /api/internal/backoffice/v1/readiness',
} as const

export type BackofficeWorkloadRouteScope =
  (typeof BackofficeWorkloadRouteScope)[keyof typeof BackofficeWorkloadRouteScope]

export interface BackofficeWorkloadPrincipal {
  role: 'backoffice-workload'
  credential: 'read'
  routeScopes: BackofficeWorkloadRouteScope[]
}

const BACKOFFICE_WORKLOAD_ROUTE_SCOPE = 'backoffice-workload-route-scope'
const BEARER_AUTHORIZATION = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i

export const RequireBackofficeWorkloadRoute = (scope: BackofficeWorkloadRouteScope) =>
  SetMetadata(BACKOFFICE_WORKLOAD_ROUTE_SCOPE, scope)

@Injectable()
export class BackofficeWorkloadAuthenticator {
  private readonly enabled: boolean
  private readonly readTokenDigests: Buffer[]

  constructor(config: TypedConfigService) {
    this.enabled = config.get('backofficeInternal.enabled')
    this.readTokenDigests = [
      config.get('backofficeInternal.readTokenDigests.current'),
      config.get('backofficeInternal.readTokenDigests.next'),
    ]
      .filter((digest): digest is string => digest !== undefined)
      .map((digest) => Buffer.from(digest, 'hex'))
  }

  isEnabled(): boolean {
    return this.enabled
  }

  authenticate(authorization: unknown): BackofficeWorkloadPrincipal {
    const match = typeof authorization === 'string' ? BEARER_AUTHORIZATION.exec(authorization) : null
    if (!match) {
      throw new UnauthorizedException('Valid Backoffice workload credentials are required')
    }

    const presentedDigest = createHash('sha256').update(match[1]).digest()
    let matched = 0
    for (const configuredDigest of this.readTokenDigests) {
      matched |= Number(timingSafeEqual(presentedDigest, configuredDigest))
    }
    if (matched === 0) {
      throw new UnauthorizedException('Valid Backoffice workload credentials are required')
    }

    return {
      role: 'backoffice-workload',
      credential: 'read',
      routeScopes: [BackofficeWorkloadRouteScope.READINESS],
    }
  }
}

type BackofficeRequest = Request & { user?: BackofficeWorkloadPrincipal }

@Injectable()
export class BackofficeWorkloadAuthGuard implements CanActivate {
  constructor(
    private readonly authenticator: BackofficeWorkloadAuthenticator,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.authenticator.isEnabled()) {
      throw new NotFoundException()
    }

    const requiredScope = this.reflector.get<BackofficeWorkloadRouteScope>(
      BACKOFFICE_WORKLOAD_ROUTE_SCOPE,
      context.getHandler(),
    )
    if (!requiredScope) {
      throw new ForbiddenException('Backoffice workload route scope is required')
    }

    const request = context.switchToHttp().getRequest<BackofficeRequest>()
    const requestedScope = `${request.method} ${request.originalUrl?.split('?', 1)[0]}`
    if (requestedScope !== requiredScope) {
      throw new ForbiddenException('Backoffice workload route scope does not match the request')
    }

    const principal = this.authenticator.authenticate(request.headers.authorization)
    if (!principal.routeScopes.includes(requiredScope)) {
      throw new ForbiddenException('Backoffice workload credential is not allowed for this route')
    }

    request.user = principal
    return true
  }
}
