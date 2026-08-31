/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import axios from 'axios'
import { TypedConfigService } from '../config/typed-config.service'
import { BoxCreationAdmissionUnavailableError } from '../box/errors/box-creation-limit.error'

const COMMERCE_REQUEST_TIMEOUT_MS = 2_000

type PublicPlan = {
  id: string
  concurrencyLimit: number | null
}

type OrganizationPlan = {
  planId: string
  entitlements?: 'active' | 'suspended'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

@Injectable()
export class CommerceBoxLimitService {
  constructor(private readonly configService: TypedConfigService) {}

  async resolveMaxCreatedBoxes(organizationId: string): Promise<number | undefined> {
    const rawBaseUrl = this.configService.get('billingApiUrl')?.trim()
    if (!rawBaseUrl) {
      return undefined
    }

    const token = this.configService.get('usageExport.token')?.trim()
    if (!token) {
      throw new BoxCreationAdmissionUnavailableError('Commerce authentication is not configured')
    }

    const baseUrl = this.normalizeBaseUrl(rawBaseUrl)
    const requestConfig = {
      timeout: COMMERCE_REQUEST_TIMEOUT_MS,
      headers: { authorization: `Bearer ${token}` },
    }

    let responses: [{ data: unknown }, { data: unknown }]
    try {
      responses = await Promise.all([
        axios.get<unknown>(`${baseUrl}/plan`, requestConfig),
        axios.get<unknown>(`${baseUrl}/organization/${encodeURIComponent(organizationId)}/plan`, requestConfig),
      ])
    } catch {
      throw new BoxCreationAdmissionUnavailableError('Commerce plan service is unavailable')
    }

    const [catalogResponse, organizationPlanResponse] = responses
    const catalog = this.parseCatalog(catalogResponse.data)
    const organizationPlan = this.parseOrganizationPlan(organizationPlanResponse.data)
    const selectedPlan =
      !organizationPlan || organizationPlan.entitlements === 'suspended'
        ? catalog[0]
        : catalog.find((plan) => plan.id === organizationPlan.planId)

    if (!selectedPlan) {
      throw new BoxCreationAdmissionUnavailableError('Organization subscription plan is not in the public catalog')
    }

    return selectedPlan.concurrencyLimit ?? undefined
  }

  private normalizeBaseUrl(rawBaseUrl: string): string {
    let parsed: URL
    try {
      parsed = new URL(rawBaseUrl)
    } catch {
      throw new BoxCreationAdmissionUnavailableError('Commerce API URL is invalid')
    }

    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new BoxCreationAdmissionUnavailableError('Commerce API URL is invalid')
    }

    return rawBaseUrl.replace(/\/+$/, '')
  }

  private parseCatalog(value: unknown): PublicPlan[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new BoxCreationAdmissionUnavailableError('Commerce returned an empty or invalid plan catalog')
    }

    return value.map((candidate) => {
      if (!isRecord(candidate) || typeof candidate.id !== 'string' || candidate.id.length === 0) {
        throw new BoxCreationAdmissionUnavailableError('Commerce returned an invalid plan catalog')
      }

      const concurrencyLimit = candidate.concurrencyLimit
      if (
        concurrencyLimit !== null &&
        (typeof concurrencyLimit !== 'number' || !Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 0)
      ) {
        throw new BoxCreationAdmissionUnavailableError('Commerce returned an invalid box concurrency limit')
      }

      return { id: candidate.id, concurrencyLimit: concurrencyLimit as number | null }
    })
  }

  private parseOrganizationPlan(value: unknown): OrganizationPlan | undefined {
    if (!isRecord(value)) {
      throw new BoxCreationAdmissionUnavailableError('Commerce returned an invalid organization plan')
    }

    if (!Object.prototype.hasOwnProperty.call(value, 'plan')) {
      if (Object.keys(value).length === 0) {
        return undefined
      }
      throw new BoxCreationAdmissionUnavailableError('Commerce returned an invalid organization plan')
    }

    const plan = value.plan
    if (!isRecord(plan) || typeof plan.planId !== 'string' || plan.planId.length === 0) {
      throw new BoxCreationAdmissionUnavailableError('Commerce returned an invalid organization plan')
    }
    if (plan.entitlements !== undefined && !['active', 'suspended'].includes(plan.entitlements as string)) {
      throw new BoxCreationAdmissionUnavailableError('Commerce returned invalid organization entitlements')
    }

    return {
      planId: plan.planId,
      entitlements: plan.entitlements as OrganizationPlan['entitlements'],
    }
  }
}
