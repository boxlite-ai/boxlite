/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'

// Contract: openapi/box.openapi.yaml `pageSize` parameter.
export const DEFAULT_LIST_PAGE_SIZE = 100
export const MAX_LIST_PAGE_SIZE = 1000

// Parse and clamp the `pageSize` query param to the documented bounds. A
// missing or unparseable value falls back to the default; out-of-range values
// clamp rather than error, matching how callers treat the documented default.
export function resolveListPageSize(pageSize?: string): number {
  if (pageSize === undefined || pageSize === '') {
    return DEFAULT_LIST_PAGE_SIZE
  }
  const parsed = Number(pageSize)
  if (!Number.isInteger(parsed)) {
    return DEFAULT_LIST_PAGE_SIZE
  }
  return Math.min(Math.max(parsed, 1), MAX_LIST_PAGE_SIZE)
}

// Page tokens are opaque to clients (openapi `pageToken`). We encode the 1-based
// page number as base64url JSON so the value is stable and self-describing on
// the server without leaking an interpretable format to clients.
export function encodePageToken(page: number): string {
  return Buffer.from(JSON.stringify({ page }), 'utf8').toString('base64url')
}

// Decode a `pageToken` into a 1-based page number. Absent token => page 1. A
// malformed token is a client error (400), not a silent reset to page 1, so a
// paging bug surfaces instead of quietly re-serving the first page forever.
export function decodePageToken(pageToken?: string): number {
  if (pageToken === undefined || pageToken === '') {
    return 1
  }
  try {
    const decoded = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8')) as { page?: unknown }
    if (typeof decoded.page === 'number' && Number.isInteger(decoded.page) && decoded.page >= 1) {
      return decoded.page
    }
  } catch {
    // fall through to the shared error below
  }
  throw new BadRequestException('Invalid pageToken')
}
