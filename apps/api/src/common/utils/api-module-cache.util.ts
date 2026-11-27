/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const ORGANIZATION_OVERRIDES: Record<string, boolean> = {}

export function isEnableApiModuleCache(enabled: boolean, orgId: string | null = null): boolean {
  return (orgId === null ? undefined : ORGANIZATION_OVERRIDES[orgId]) ?? enabled === true
}
