/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import axios from 'axios'

type OrganizationPlanResponse = { data: unknown }

const requestScope = new AsyncLocalStorage<Map<string, Promise<OrganizationPlanResponse>>>()

export function withCommerceOrganizationPlanScope<T>(operation: () => Promise<T>): Promise<T> {
  return requestScope.run(new Map(), operation)
}

export function fetchCommerceOrganizationPlan(
  baseUrl: string,
  organizationId: string,
  token: string,
): Promise<OrganizationPlanResponse> {
  const requests = requestScope.getStore()
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const key = JSON.stringify([normalizedBaseUrl, organizationId, token])
  const existing = requests?.get(key)
  if (existing) return existing

  const request = axios.get<unknown>(`${normalizedBaseUrl}/organization/${encodeURIComponent(organizationId)}/plan`, {
    timeout: 2_000,
    maxRedirects: 0,
    headers: { authorization: `Bearer ${token}` },
  })
  requests?.set(key, request)
  return request
}
