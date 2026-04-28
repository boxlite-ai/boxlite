/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export interface PaginatedList<T> {
  items: T[]
  total: number
  page: number
  totalPages: number
  nextToken?: string
}
