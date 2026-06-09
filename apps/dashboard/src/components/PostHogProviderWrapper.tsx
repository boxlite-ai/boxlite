/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useConfig } from '@/hooks/useConfig'
import { usePrivacyConsentStore } from '@/hooks/usePrivacyConsent'
import { FeatureFlags } from '@/enums/FeatureFlags'
import { usePostHog } from 'posthog-js/react'
import { PostHogProvider } from 'posthog-js/react'
import { FC, ReactNode, useEffect } from 'react'

interface PostHogProviderWrapperProps {
  children: ReactNode
}

// Local-dev defaults for the feature flags that gate UI surfaces. When
// PostHog isn't configured (no API key in /api/config — typical local dev),
// we mount PostHogProvider in a no-network mode with these bootstrap values
// so flag-gated components (e.g. CreateSandboxSheet, which short-circuits to
// `return null` if `dashboard_create-sandbox` is falsy) still render.
//
// All true → matches the "team-internal full-access" rollout state. Flip an
// entry to false to simulate prod gating one off.
const LOCAL_DEV_FEATURE_FLAG_DEFAULTS: Record<string, boolean> = {
  [FeatureFlags.DASHBOARD_CREATE_SANDBOX]: true,
  [FeatureFlags.DASHBOARD_PLAYGROUND]: true,
  [FeatureFlags.DASHBOARD_WEBHOOKS]: true,
  [FeatureFlags.ORGANIZATION_INFRASTRUCTURE]: true,
  [FeatureFlags.ORGANIZATION_EXPERIMENTS]: true,
  [FeatureFlags.SANDBOX_SPENDING]: true,
}

function PostHogConsentSync() {
  const posthog = usePostHog()
  const analytics = usePrivacyConsentStore((state) => state.preferences.analytics)
  const hasConsented = usePrivacyConsentStore((state) => state.hasConsented)

  useEffect(() => {
    if (!posthog || !hasConsented) return

    if (analytics) {
      posthog.opt_in_capturing()
    } else {
      posthog.opt_out_capturing()
    }
  }, [posthog, analytics, hasConsented])

  return null
}

export const PostHogProviderWrapper: FC<PostHogProviderWrapperProps> = ({ children }) => {
  const config = useConfig()

  const posthogConfigured = !!(config.posthog?.apiKey && config.posthog?.host)

  if (config.posthog && !posthogConfigured) {
    // Server sent a posthog block but it's incomplete — likely operator typo.
    console.error('Invalid PostHog configuration')
  }

  if (!posthogConfigured) {
    // Production must never bootstrap flags to `true` (fail-open). If PostHog
    // isn't configured in a prod build, render without a provider so every
    // flag resolves falsy (fail-closed) — matching the pre-bootstrap behavior.
    // `import.meta.env.PROD` is Vite's production-build equivalent of
    // NODE_ENV==='production'; infra-local runs `vite` dev (PROD=false), so it
    // still gets the local-dev bootstrap below.
    if (import.meta.env.PROD) {
      return children
    }

    // Local-dev / unconfigured path. Mount PostHogProvider with a stub key +
    // bootstrap feature flags so `useFeatureFlagEnabled(...)` returns the
    // defaults above. All network behavior disabled: no /decide call (we
    // pre-load flags via bootstrap), no event capture, no autocapture.
    return (
      <PostHogProvider
        apiKey="phc_local_dev_no_op"
        options={{
          // api_host is required by posthog-js but never used because
          // capturing is opted out and flags are bootstrapped below.
          api_host: 'https://localhost.invalid',
          bootstrap: { featureFlags: LOCAL_DEV_FEATURE_FLAG_DEFAULTS },
          advanced_disable_feature_flags: true, // skip /decide network call
          autocapture: false,
          capture_pageview: false,
          capture_pageleave: false,
          opt_out_capturing_by_default: true,
          disable_session_recording: true,
          loaded: (posthog) => posthog.opt_out_capturing(),
        }}
      >
        {children}
      </PostHogProvider>
    )
  }

  return (
    <PostHogProvider
      apiKey={config.posthog!.apiKey}
      options={{
        api_host: config.posthog!.host,
        opt_out_capturing_by_default: true,
        cookieless_mode: 'on_reject',
        persistence: 'localStorage',
        person_profiles: 'always',
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: true,
      }}
    >
      <PostHogConsentSync />
      {children}
    </PostHogProvider>
  )
}
