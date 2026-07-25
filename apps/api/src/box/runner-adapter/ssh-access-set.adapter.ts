/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import axios, { AxiosError } from 'axios'
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { Runner } from '../entities/runner.entity'
import { TypedConfigService } from '../../config/typed-config.service'

// One box-scoped temporary SSH credential in the desired full-set snapshot,
// mirroring the Runner's `SshAccessEntryRequest` JSON shape
// (apps/runner/pkg/api/controllers/boxlite_ssh.go).
export interface SshAccessSetEntry {
  id: string
  grantId: string
  publicKey: string
  fingerprint: string
  unixUser: string
  expiresAt: Date
}

// Mirrors the Runner's `SshAccessSetResponse`.
export interface SshAccessSetStatus {
  appliedGeneration: number
  listenerReady: boolean
  hostPublicKey: string
  hostKeyFingerprint: string
}

// Calls the Runner's `PUT /v1/boxes/:boxId/ssh/access-set` control-plane
// endpoint and maps its typed failure-mode status codes (404/400/429/409/503,
// per apps/runner/pkg/api/controllers/boxlite_ssh.go) onto the exception
// classes the rest of the API already throws for equivalent conditions.
@Injectable()
export class SshAccessSetAdapter {
  private readonly logger = new Logger(SshAccessSetAdapter.name)

  constructor(private readonly configService: TypedConfigService) {}

  async applyAccessSet(
    runner: Runner,
    boxId: string,
    generation: number,
    accesses: SshAccessSetEntry[],
  ): Promise<SshAccessSetStatus> {
    if (!runner.apiUrl) {
      throw new NotFoundException(`Runner endpoint for box ${boxId} not found`)
    }

    const timeoutMs = this.configService.get('sshAccessSetTimeoutSeconds') * 1000

    try {
      const response = await axios.put(
        `${runner.apiUrl}/v1/boxes/${boxId}/ssh/access-set`,
        {
          generation,
          accesses: accesses.map((access) => ({
            id: access.id,
            grantId: access.grantId,
            publicKey: access.publicKey,
            fingerprint: access.fingerprint,
            unixUser: access.unixUser,
            expiresAt: access.expiresAt.toISOString(),
          })),
        },
        {
          headers: { Authorization: `Bearer ${runner.apiKey}` },
          timeout: timeoutMs,
        },
      )

      return {
        appliedGeneration: response.data.appliedGeneration,
        listenerReady: response.data.listenerReady,
        hostPublicKey: response.data.hostPublicKey,
        hostKeyFingerprint: response.data.hostKeyFingerprint,
      }
    } catch (error) {
      if (!axios.isAxiosError(error)) {
        throw error
      }
      throw this.toTypedException(error, boxId)
    }
  }

  private toTypedException(error: AxiosError, boxId: string): HttpException {
    const status = error.response?.status
    const message = this.messageFrom(error) ?? `Runner SSH access-set request failed for box ${boxId}`

    switch (status) {
      case HttpStatus.NOT_FOUND:
        return new NotFoundException(message)
      case HttpStatus.BAD_REQUEST:
        return new BadRequestException(message)
      case HttpStatus.TOO_MANY_REQUESTS:
        return new HttpException(message, HttpStatus.TOO_MANY_REQUESTS)
      case HttpStatus.CONFLICT:
        return new ConflictException(message)
      default:
        // Covers the Runner's 503 (guest listener down/unreachable), any
        // other unmapped status, and no-response network/timeout errors --
        // all retryable per the design's revoke-consistency contract, which
        // requires callers to see "not yet applied", never a false success.
        this.logger.warn(`Runner SSH access-set request failed for box ${boxId}: ${message}`)
        return new ServiceUnavailableException(message)
    }
  }

  private messageFrom(error: AxiosError): string | undefined {
    const data = error.response?.data
    if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as any).error === 'string') {
      return (data as any).error
    }
    return error.message
  }
}
