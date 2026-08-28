/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { BoxDto } from '../../box/dto/box.dto'
import { CreateBoxDto } from '../../box/dto/create-box.dto'
import { BoxInventoryLimitExceededError } from '../../box/errors/box-inventory-limit-exceeded.error'
import { Organization } from '../../organization/entities/organization.entity'
import { BoxRepository } from '../../box/repositories/box.repository'
import { BoxService } from '../../box/services/box.service'
import { BoxAdmissionReservationService, withBoxAdmissionReservation } from './box-admission-reservation.service'
import { CommerceBoxLimitService } from './commerce-box-limit.service'

@Injectable()
export class RestBoxCreationService {
  private readonly logger = new Logger(RestBoxCreationService.name)

  constructor(
    private readonly limitService: CommerceBoxLimitService,
    private readonly boxRepository: BoxRepository,
    private readonly boxService: BoxService,
    private readonly reservationService: BoxAdmissionReservationService,
  ) {}

  async create(createBoxDto: CreateBoxDto, organization: Organization): Promise<BoxDto> {
    const limit = await this.limitService.resolveLimit(organization.id)
    if (limit.kind === 'unlimited') {
      return this.boxService.create(createBoxDto, organization)
    }

    const reservation = await this.createReservation(organization.id)
    let createdBox: BoxDto | undefined
    let operationError: unknown

    try {
      return await withBoxAdmissionReservation(
        reservation,
        async (signal) => {
          signal.throwIfAborted()

          let currentBoxCount: number
          try {
            currentBoxCount = await this.boxRepository.countQuotaBoxes(organization.id)
          } catch (error) {
            if (!signal.aborted) {
              operationError = error
            }
            throw error
          }

          // pendingCount includes this request; only the other active
          // reservations consume capacity before this request is admitted.
          const effectiveBoxCount = currentBoxCount + reservation.pendingCount - 1
          if (effectiveBoxCount >= limit.value) {
            throw this.limitExceeded(effectiveBoxCount, limit.value)
          }

          signal.throwIfAborted()
          try {
            createdBox = await this.boxService.create(createBoxDto, organization, {
              inventoryLimit: limit.value,
              signal,
            })
            return createdBox
          } catch (error) {
            if (!signal.aborted) {
              operationError = error
            }
            throw error
          }
        },
        (error) => this.logger.warn(`Failed to release box creation reservation: ${this.errorSummary(error)}`),
      )
    } catch (error) {
      // A BoxService return means its database write committed. Do not turn a
      // reservation failure into a retry that creates another box.
      if (createdBox) {
        this.logger.warn(
          `Box ${createdBox.id} was created before its admission reservation failed: ${this.errorSummary(error)}`,
        )
        return createdBox
      }
      if (error instanceof BoxInventoryLimitExceededError) {
        throw this.limitExceeded(error.current, error.limit)
      }
      if (operationError !== undefined || error instanceof HttpException) {
        throw error
      }
      throw this.admissionUnavailable(error)
    }
  }

  private async createReservation(organizationId: string) {
    try {
      return await this.reservationService.reserve(organizationId)
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
