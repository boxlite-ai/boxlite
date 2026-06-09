/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { EvaluationContext, Logger } from '@openfeature/server-sdk'
import { OpenFeaturePostHogProvider } from './openfeature-posthog.provider'

/**
 * Guards the production fail-closed gate: bootstrap flags are a local-dev
 * convenience and must NEVER resolve `true` in production when PostHog is
 * unconfigured — otherwise a prod deploy without POSTHOG_API_KEY would expose
 * flag-gated routes (fail open). See app.module.ts injection-site gate.
 */
describe('OpenFeaturePostHogProvider — production bootstrap gate', () => {
  const FLAG = 'dashboard_create-sandbox'
  const originalNodeEnv = process.env.NODE_ENV
  const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  const context: EvaluationContext = {}

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
  })

  it('honors bootstrap flags outside production when PostHog is unconfigured', async () => {
    process.env.NODE_ENV = 'development'
    const provider = new OpenFeaturePostHogProvider({ bootstrapFlags: { [FLAG]: true } })

    const result = await provider.resolveBooleanEvaluation(FLAG, false, context, logger)

    expect(result.value).toBe(true)
  })

  it('ignores bootstrap flags in production — fails closed to the call-site default', async () => {
    process.env.NODE_ENV = 'production'
    const provider = new OpenFeaturePostHogProvider({ bootstrapFlags: { [FLAG]: true } })

    const result = await provider.resolveBooleanEvaluation(FLAG, false, context, logger)

    expect(result.value).toBe(false)
  })
})
