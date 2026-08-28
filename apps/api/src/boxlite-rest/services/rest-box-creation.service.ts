/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { BoxDto } from '../../box/dto/box.dto'
import { CreateBoxDto } from '../../box/dto/create-box.dto'
import { Organization } from '../../organization/entities/organization.entity'
import { RedisLockProvider, withRedisLockLease } from '../../box/common/redis-lock.provider'
import { BoxRepository } from '../../box/repositories/box.repository'
import { BoxService } from '../../box/services/box.service'
import { CommerceBoxLimitService } from './commerce-box-limit.service'

const ADMISSION_LEASE_TTL_SECONDS = 30
const ADMISSION_WAIT_TIMEOUT_MS = 10_000

@Injectable()
export class RestBoxCreationService {
  private readonly logger = new Logger(RestBoxCreationService.name)

  constructor(
    private readonly limitService: CommerceBoxLimitService,
    private readonly boxRepository: BoxRepository,
    private readonly boxService: BoxService,
    private readonly redisLockProvider: RedisLockProvider,
  ) {}

  async create(createBoxDto: CreateBoxDto, organization: Organization): Promise<BoxDto> {
    const limit = await this.limitService.resolveLimit(organization.id)
    if (limit.kind === 'unlimited') {
      return this.boxService.create(createBoxDto, organization)
    }

    const lease = await this.acquireAdmissionLease(organization.id)
    let createdBox: BoxDto | undefined
    let operationError: unknown

    try {
      return await withRedisLockLease(
        lease,
        async (signal) => {
          signal.throwIfAborted()

          let currentBoxCount: number
          try {
            currentBoxCount = await this.boxRepository.countQuotaBoxes(organization.id)
          } catch (error) {
            operationError = error
            throw error
          }

          if (currentBoxCount >= limit.value) {
            throw this.limitExceeded(currentBoxCount, limit.value)
          }

          signal.throwIfAborted()
          try {
            createdBox = await this.boxService.create(createBoxDto, organization)
            return createdBox
          } catch (error) {
            operationError = error
            throw error
          }
        },
        (error) => this.logger.warn(`Failed to release box creation admission lease: ${this.errorSummary(error)}`),
      )
    } catch (error) {
      // The BoxService return means its database write committed. Do not turn a
      // release/renewal failure into a retry that creates another box.
      if (createdBox) {
        this.logger.warn(
          `Box ${createdBox.id} was created before its admission lease failed: ${this.errorSummary(error)}`,
        )
        return createdBox
      }
      if (operationError !== undefined || error instanceof HttpException) {
        throw error
      }
      throw this.admissionUnavailable(error)
    }
  }

  private async acquireAdmissionLease(organizationId: string) {
    try {
      return await this.redisLockProvider.waitForLease(
        `box-create-admission:${organizationId}`,
        ADMISSION_LEASE_TTL_SECONDS,
        AbortSignal.timeout(ADMISSION_WAIT_TIMEOUT_MS),
      )
    } catch (error) {
      throw this.admissionUnavailable(error)
    }
  }

  private limitExceeded(current: number, limit: number): HttpException {
    return new HttpException(
      {
        message: `You have already created ${current} boxes, reaching or exceeding the current maximum allowed number of ${limit}. Please delete unused boxes and try again.`,
        code: 'resource_exhausted',
      },
      HttpStatus.FORBIDDEN,
    )
  }

  private admissionUnavailable(cause: unknown): ServiceUnavailableException {
    this.logger.warn(`Box creation admission is unavailable: ${this.errorSummary(cause)}`)
    return new ServiceUnavailableException({
      message: 'Box creation admission is temporarily unavailable. Please try again.',
      code: 'upstream_unavailable',
    })
  }

  private errorSummary(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error'
  }
}
