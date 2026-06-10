/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, NotFoundException, HttpException, BadRequestException, Logger } from '@nestjs/common'
import { Box } from '../entities/box.entity'
import { Runner } from '../entities/runner.entity'
import axios from 'axios'
import { BoxState } from '../enums/box-state.enum'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { BoxService } from './box.service'
import { RunnerService } from './runner.service'
import { BoxRepository } from '../repositories/box.repository'

@Injectable()
export class ToolboxService {
  private readonly logger = new Logger(ToolboxService.name)

  constructor(
    private readonly boxRepository: BoxRepository,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly boxService: BoxService,
    private readonly runnerService: RunnerService,
  ) {}

  async forwardRequestToRunner(boxId: string, method: string, path: string, data?: any): Promise<any> {
    const runner = await this.getRunner(boxId)

    if (!runner.proxyUrl) {
      throw new NotFoundException(`Runner for box ${boxId} has no proxy URL`)
    }

    const maxRetries = 5
    let attempt = 1

    while (attempt <= maxRetries) {
      try {
        const headers: any = {
          Authorization: `Bearer ${runner.apiKey}`,
        }

        // Only set Content-Type for requests with body data
        if (data && typeof data === 'object' && Object.keys(data).length > 0) {
          headers['Content-Type'] = 'application/json'
        }

        const requestConfig: any = {
          method,
          url: `${runner.proxyUrl}/boxes/${boxId}${path}`,
          headers,
          maxBodyLength: 209715200, // 200MB in bytes
          maxContentLength: 209715200, // 200MB in bytes
          timeout: 360000, // 360 seconds
        }

        // Only add data if it's not an empty string or undefined
        if (data !== undefined && data !== '') {
          requestConfig.data = data
        }

        const response = await axios(requestConfig)
        return response.data
      } catch (error) {
        if (error.message.includes('ECONNREFUSED')) {
          if (attempt === maxRetries) {
            throw new HttpException('Failed to connect to runner after multiple attempts', 500)
          }
          // Wait for attempt * 1000ms (1s, 2s, 3s)
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
          attempt++
          continue
        }
        // If it's an axios error with a response, throw a NestJS HttpException
        if (error.response) {
          throw new HttpException(error.response.data, error.response.status)
        }

        // For other types of errors, throw a generic 500 error
        throw new HttpException(`Error forwarding request to runner: ${error.message}`, 500)
      }
    }
  }

  public async getRunner(boxId: string): Promise<Runner> {
    let box: Box | null = null
    try {
      box = await this.boxRepository.findOne({
        where: { id: boxId },
      })

      if (!box) {
        throw new NotFoundException('Box not found')
      }

      const runner = await this.runnerService.findOneOrFail(box.runnerId)

      if (box.state !== BoxState.STARTED) {
        throw new BadRequestException('Box is not running')
      }

      return runner
    } finally {
      const lockKey = `box-last-activity-${boxId}`
      const acquired = await this.redisLockProvider.lock(lockKey, 10)

      // redis for cooldown period - 10 seconds
      // prevents database flooding when multiple requests are made at the same time
      if (acquired) {
        await this.boxService.updateLastActivityAt(boxId, new Date())
      }
    }
  }
}
