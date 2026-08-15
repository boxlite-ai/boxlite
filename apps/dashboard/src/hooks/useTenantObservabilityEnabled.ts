/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { FeatureFlags } from '@/enums/FeatureFlags'
import { useConfig } from '@/hooks/useConfig'
import { useFeatureFlagEnabled } from 'posthog-js/react'

export function useTenantObservabilityEnabled(): boolean | undefined {
  const config = useConfig()
  const flag = useFeatureFlagEnabled(FeatureFlags.TENANT_OBSERVABILITY)
  if (!config.posthog?.apiKey || !config.posthog.host) {
    return false
  }
  return flag
}
