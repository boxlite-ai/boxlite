/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, InternalServerErrorException, Logger, ServiceUnavailableException } from '@nestjs/common'
import axios from 'axios'
import { TypedConfigService } from '../../config/typed-config.service'
import { BoxCostLineDto } from '../dto/box-cost.dto'

const REQUEST_TIMEOUT_MS = 2_000
const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/
const USD = /^(0|[1-9]\d*)(\.\d{1,24})?$/
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const UNITS = new Map([
  ['cpu', 'vcpu_second'],
  ['gpu', 'gpu_second'],
  ['memory', 'gib_second'],
  ['disk', 'gib_second'],
])

export type PricedBoxUsage = { lines: BoxCostLineDto[]; totalUsd: string | null }

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value)
}

function isInstant(value: unknown): value is string {
  return matches(value, UTC_INSTANT) && Number.isFinite(Date.parse(value))
}

/** Reads priced usage from the billing service. Amounts stay decimal text: a number would round them. */
@Injectable()
export class BoxPricingClient {
  private readonly logger = new Logger(BoxPricingClient.name)

  constructor(private readonly configService: TypedConfigService) {}

  async price(organizationId: string, boxId: string, through: Date): Promise<PricedBoxUsage> {
    const baseUrl = this.configService.get('usageExport.url')
    const token = this.configService.get('usageExport.token')
    if (!this.configService.get('usageExport.enabled') || !baseUrl || !token) {
      throw new ServiceUnavailableException('Box cost is not available on this deployment')
    }

    let data: unknown
    try {
      const response = await axios.get<unknown>(
        `${baseUrl}/internal/organizations/${encodeURIComponent(organizationId)}/boxes/${boxId}/cost`,
        {
          params: { through: through.toISOString() },
          headers: { authorization: `Bearer ${token}` },
          timeout: REQUEST_TIMEOUT_MS,
          maxRedirects: 0,
        },
      )
      data = response.data
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined
      this.logger.error(`Pricing box ${boxId} failed: ${status ? `HTTP ${status}` : 'transport failure'}`)
      if (status === 400) throw new InternalServerErrorException('Box cost request was rejected')
      throw this.unavailable()
    }

    const priced = this.parse(data)
    if (!priced) {
      this.logger.error(`Pricing box ${boxId} failed: invalid response`)
      throw this.unavailable()
    }
    return priced
  }

  // One message for every upstream fault, so a rejected service credential never reads as the caller's.
  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException('Box cost is temporarily unavailable')
  }

  private parse(data: unknown): PricedBoxUsage | undefined {
    const { lines, totalUsd } = (data ?? {}) as Record<string, unknown>
    if (!Array.isArray(lines) || (totalUsd !== null && !matches(totalUsd, USD))) return undefined
    // Null means nothing was priced, so it must agree with the lines.
    if ((lines.length === 0) !== (totalUsd === null)) return undefined

    const parsed = lines.map((line) => this.parseLine(line))
    return parsed.includes(undefined) ? undefined : { lines: parsed, totalUsd: totalUsd as string | null }
  }

  private parseLine(line: unknown): BoxCostLineDto | undefined {
    const { item, quantity, unit, amountUsd, start, end } = (line ?? {}) as Record<string, unknown>
    const isValid =
      typeof item === 'string' &&
      UNITS.has(item) &&
      UNITS.get(item) === unit &&
      matches(quantity, DECIMAL) &&
      matches(amountUsd, USD) &&
      isInstant(start) &&
      isInstant(end)
    return isValid ? { item, quantity, unit: unit as string, amount_usd: amountUsd, start, end } : undefined
  }
}
