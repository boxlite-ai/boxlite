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

  /**
   * Routing-slot value the client substitutes into the `{prefix}`
   * URL segment on box-scoped requests.
   *
   * `null` when the credential has no scope assigned yet (mid-
   * provisioning service accounts, first OIDC login before org
   * assignment). The field is always present in the response
   * envelope per the OpenAPI contract (`nullable: true`); spec-
   * strict clients (Rust, Java, Go generated code) treat a missing
   * key vs. an explicit `null` as different shapes.
   */
  path_prefix: string | null

  /** Granted scope strings (`box:read`, `box:write`, etc.). */
  scopes: string[]

  /** Optional expiry; `null` for long-lived dashboard keys. */
  expires_at?: string | null
}
