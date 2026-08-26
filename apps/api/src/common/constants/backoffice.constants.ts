/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export const BOXLITE_BACKOFFICE_USER_ID = 'backoffice-service'

export const BackofficeAuditHeaders = {
  ACTOR_SUBJECT: 'X-Backoffice-Actor-Subject',
  ACTOR_EMAIL: 'X-Backoffice-Actor-Email',
  SESSION_ID: 'X-Backoffice-Session-ID',
  CORRELATION_ID: 'X-Correlation-ID',
} as const

export function safeAuditFilter(value: unknown, maxLength = 128): string | undefined {
  return typeof value === 'string' && value.length <= maxLength && /^[\x20-\x7E]+$/.test(value) ? value : undefined
}
