/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useConfig } from '@/hooks/useConfig'
import { PostHogProvider } from 'posthog-js/react'
import { FC, ReactNode } from 'react'

interface PostHogProviderWrapperProps {
  children: ReactNode
}

export const PostHogProviderWrapper: FC<PostHogProviderWrapperProps> = ({ children }) => {
  const config = useConfig()

  if (!config.posthog) {
    return children
  }

  if (!config.posthog?.apiKey || !config.posthog?.host) {
    console.error('Invalid PostHog configuration')
    return children
  }

  return (
    <PostHogProvider
      apiKey={config.posthog.apiKey}
      options={{
        api_host: config.posthog.host,
        persistence: 'memory',
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        capture_exceptions: false,
        capture_performance: false,
        disable_external_dependency_loading: true,
        disable_surveys: true,
        disable_product_tours: true,
        disable_web_experiments: true,
        save_referrer: false,
        store_google: false,
        // Flag evaluation uses this client. Console events use a separate HTTP sender.
        before_send: () => null,
      }}
    >
      {children}
    </PostHogProvider>
  )
}
