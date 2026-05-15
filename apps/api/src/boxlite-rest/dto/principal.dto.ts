/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Identity payload returned by `GET /v1/me`. Wire shape matches the
 * `Principal` schema in `openapi/box.openapi.yaml`.
 */
export class PrincipalDto {
  /** Stable opaque principal identifier; treat as opaque. */
  sub: string

  /** `user` for interactive logins; `service_account` for automation keys. */
  principal_type: 'user' | 'service_account'

  /** Optional email; absent for service accounts. */
  email?: string

  /** Optional human-readable label. */
  display_name?: string

  /** Tenant/workspace prefix the credential is bound to. */
  prefix: string

  /** Granted scope strings (`box:read`, `box:write`, etc.). */
  scopes: string[]

  /** Optional expiry; `null` for long-lived dashboard keys. */
  expires_at?: string | null
}
