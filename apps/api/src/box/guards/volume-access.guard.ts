/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  Optional,
} from '@nestjs/common'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'
import { VolumeService } from '../services/volume.service'
import { EntityNotFoundError } from 'typeorm'
import { Request } from 'express'
import { BoxRequestReplayService, ReplayResource } from '../../boxlite-rest/box-request-replay.service'
import {
  replayIdentity,
  replayPolicy,
  REPLAY_ONLY,
  REPLAY_RESOURCE,
  validateReplayKey,
} from '../../boxlite-rest/request-replay-policy'

type ReplayVolumeRequest = Request & {
  user?: OrganizationAuthContext
  [REPLAY_ONLY]?: boolean
  [REPLAY_RESOURCE]?: ReplayResource
}

@Injectable()
export class VolumeAccessGuard implements CanActivate {
  constructor(
    private readonly volumeService: VolumeService,
    @Optional() private readonly requestReplay?: BoxRequestReplayService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ReplayVolumeRequest>()

    const id = request.params.volumeId || request.params.id
    const volumeId = typeof id === 'string' ? id : undefined
    const volumeName = typeof request.params.name === 'string' ? request.params.name : undefined

    if (!volumeId && !volumeName) {
      throw new NotFoundException(`Volume not found`)
    }

    const authContext = request.user as OrganizationAuthContext

    try {
      const params = volumeId
        ? { id: volumeId }
        : { name: volumeName ?? '', organizationId: authContext.organizationId }
      const volumeOrganizationId = await this.volumeService.getOrganizationId(params)

      if (authContext.role !== SystemRole.ADMIN && volumeOrganizationId !== authContext.organizationId) {
        throw new ForbiddenException('Request organization ID does not match resource organization ID')
      }
      if (volumeId) request[REPLAY_RESOURCE] = { id: volumeId, organizationId: volumeOrganizationId }
    } catch (error) {
      if (error instanceof EntityNotFoundError && this.requestReplay && volumeId) {
        const route = String(request.route?.path ?? request.path)
        const key = validateReplayKey(request)
        if (key && replayPolicy(request.method, route) === 'supported') {
          const { operation, fingerprint } = replayIdentity(request)
          const completed = await this.requestReplay.peekCompleted(
            authContext.organizationId,
            authContext.userId,
            operation,
            key,
            fingerprint,
          )
          if (
            completed?.resource?.id === volumeId &&
            completed.resource.organizationId === authContext.organizationId
          ) {
            request[REPLAY_ONLY] = true
            request[REPLAY_RESOURCE] = completed.resource
            return true
          }
        }
      }
      if (request.method === 'DELETE' && request.query?.force === 'true' && error instanceof EntityNotFoundError) {
        return true
      }
      throw new NotFoundException(`Volume with ${volumeId ? 'ID' : 'name'} ${volumeId || volumeName} not found`)
    }

    return true
  }
}
