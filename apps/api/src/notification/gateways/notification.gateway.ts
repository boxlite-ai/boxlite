/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common'
import { WebSocketGateway, WebSocketServer, OnGatewayInit } from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { BoxEvents } from '../../box/constants/box-events.constants'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDto } from '../../box/dto/box.dto'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { JwtStrategy } from '../../auth/jwt.strategy'
import { ApiKeyStrategy } from '../../auth/api-key.strategy'
import { isAuthContext } from '../../common/interfaces/auth-context.interface'
import { VolumeEvents } from '../../box/constants/volume-events'
import { VolumeDto } from '../../box/dto/volume.dto'
import { VolumeState } from '../../box/enums/volume-state.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { RunnerDto } from '../../box/dto/runner.dto'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { RunnerEvents } from '../../box/constants/runner-events'
import { NotificationEmitter } from './notification-emitter.abstract'

@WebSocketGateway({
  path: '/api/socket.io/',
  transports: ['websocket'],
})
export class NotificationGateway extends NotificationEmitter implements OnGatewayInit, OnModuleInit {
  private readonly logger = new Logger(NotificationGateway.name)

  @WebSocketServer()
  server: Server

  constructor(
    private readonly jwtStrategy: JwtStrategy,
    private readonly apiKeyStrategy: ApiKeyStrategy,
    @InjectRedis() private readonly redis: Redis,
  ) {
    super()
  }

  onModuleInit() {
    const pubClient = this.redis.duplicate()
    const subClient = pubClient.duplicate()
    this.server.adapter(createAdapter(pubClient, subClient))
    this.logger.debug('Socket.io initialized with Redis adapter')
  }

  afterInit(server: Server) {
    this.logger.debug('WebSocket Gateway initialized')

    server.use(async (socket: Socket, next) => {
      const token = socket.handshake.auth.token
      if (!token) {
        return next(new UnauthorizedException())
      }

      // Try JWT authentication first
      try {
        const payload = await this.jwtStrategy.verifyToken(token)

        // Join the user room for user scoped notifications
        await socket.join(payload.sub)

        // Join the organization room for organization scoped notifications
        const organizationId = socket.handshake.query.organizationId as string | undefined
        if (organizationId) {
          await socket.join(organizationId)
        }

        return next()
      } catch {
        // JWT failed, try API key authentication
      }

      // Try API key authentication
      try {
        const authContext = await this.apiKeyStrategy.validate(token)

        if (isAuthContext(authContext)) {
          // Join the user room for user scoped notifications
          await socket.join(authContext.userId)

          // Join the organization room for organization scoped notifications
          if (authContext.organizationId) {
            await socket.join(authContext.organizationId)
          }

          return next()
        }

        return next(new UnauthorizedException())
      } catch {
        return next(new UnauthorizedException())
      }
    })
  }

  emitBoxCreated(box: BoxDto) {
    this.server.to(box.organizationId).emit(BoxEvents.CREATED, box)
  }

  emitBoxStateUpdated(box: BoxDto, oldState: BoxState, newState: BoxState) {
    this.server.to(box.organizationId).emit(BoxEvents.STATE_UPDATED, { box, oldState, newState })
  }

  emitBoxDesiredStateUpdated(box: BoxDto, oldDesiredState: BoxDesiredState, newDesiredState: BoxDesiredState) {
    this.server.to(box.organizationId).emit(BoxEvents.DESIRED_STATE_UPDATED, { box, oldDesiredState, newDesiredState })
  }

  emitVolumeCreated(volume: VolumeDto) {
    this.server.to(volume.organizationId).emit(VolumeEvents.CREATED, volume)
  }

  emitVolumeStateUpdated(volume: VolumeDto, oldState: VolumeState, newState: VolumeState) {
    this.server.to(volume.organizationId).emit(VolumeEvents.STATE_UPDATED, { volume, oldState, newState })
  }

  emitVolumeLastUsedAtUpdated(volume: VolumeDto) {
    this.server.to(volume.organizationId).emit(VolumeEvents.LAST_USED_AT_UPDATED, volume)
  }

  emitRunnerCreated(runner: RunnerDto, organizationId: string | null) {
    if (!organizationId) {
      return
    }
    this.server.to(organizationId).emit(RunnerEvents.CREATED, runner)
  }

  emitRunnerStateUpdated(
    runner: RunnerDto,
    organizationId: string | null,
    oldState: RunnerState,
    newState: RunnerState,
  ) {
    if (!organizationId) {
      return
    }
    this.server.to(organizationId).emit(RunnerEvents.STATE_UPDATED, { runner, oldState, newState })
  }

  emitRunnerUnschedulableUpdated(runner: RunnerDto, organizationId: string | null) {
    if (!organizationId) {
      return
    }
    this.server.to(organizationId).emit(RunnerEvents.UNSCHEDULABLE_UPDATED, runner)
  }
}
