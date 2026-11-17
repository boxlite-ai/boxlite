/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Logger,
  Post,
  ServiceUnavailableException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { InjectRepository } from '@nestjs/typeorm'
import { In, Repository } from 'typeorm'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { AuthContextType } from '../../common/interfaces/auth-context.interface'
import { recordBusinessEvent } from '../../common/utils/business-event.util'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { FeatureUsageBatchDto } from '../dto/feature-usage.dto'
import { Box } from '../entities/box.entity'

const EVIDENCE = {
  ssh: { name: 'ssh', evidence: 'authenticated_session', source: 'runner' },
  tunnel_connection: { name: 'tunnel', evidence: 'established_connection', source: 'proxy' },
  tunnel_request: { name: 'tunnel', evidence: 'successful_request', source: 'proxy' },
} as const

@ApiExcludeController()
@Controller('telemetry/feature-usage')
@UseGuards(CombinedAuthGuard)
export class FeatureUsageController {
  private readonly logger = new Logger(FeatureUsageController.name)
  constructor(@InjectRepository(Box) private readonly boxes: Repository<Box>) {}

  @Post()
  @HttpCode(202)
  async receive(
    @AuthContext() actor: AuthContextType,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    batch: FeatureUsageBatchDto,
  ): Promise<{ accepted: number }> {
    if (actor.role !== 'runner' && actor.role !== 'proxy') throw new ForbiddenException()
    let boxes: Pick<Box, 'id' | 'organizationId' | 'runnerId'>[]
    try {
      boxes = await this.boxes.find({
        where: { id: In([...new Set(batch.events.map((event) => event.boxId))]) },
        select: { id: true, organizationId: true, runnerId: true },
      })
    } catch {
      this.logger.warn('Cloud feature usage lookup failed', { errorType: 'database_error' })
      throw new ServiceUnavailableException('Feature usage collection unavailable')
    }
    const resources = new Map(boxes.map((box) => [box.id, box]))
    const now = Date.now()
    const seen = new Set<string>()
    let accepted = 0
    for (const event of batch.events) {
      const box = resources.get(event.boxId)
      const evidence = EVIDENCE[event.kind]
      const occurredAt = new Date(event.occurredAt)
      if (
        !box ||
        box.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION ||
        !Number.isFinite(occurredAt.getTime()) ||
        evidence.source !== actor.role ||
        (actor.role === 'runner' && box.runnerId !== actor.runnerId) ||
        occurredAt.getTime() < now - 7 * 24 * 60 * 60 * 1000 ||
        occurredAt.getTime() > now + 5 * 60 * 1000
      )
        continue
      const key = box.id + ':' + event.kind + ':' + event.id
      if (seen.has(key)) continue
      seen.add(key)
      recordBusinessEvent({
        name: 'cloud.feature.use',
        outcome: 'success',
        correlationId: box.id,
        organizationId: box.organizationId,
        eventId: event.id,
        occurredAt,
        feature: evidence,
      })
      accepted++
    }
    if (accepted < batch.events.length) {
      this.logger.warn('Cloud feature usage observations rejected', {
        producer: actor.role,
        rejected: batch.events.length - accepted,
      })
    }
    return { accepted }
  }
}
