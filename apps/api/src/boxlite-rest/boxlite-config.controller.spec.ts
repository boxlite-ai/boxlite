/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteConfigController } from './boxlite-config.controller'

describe('BoxliteConfigController', () => {
  it('advertises Linux capability policy support', () => {
    const config = new BoxliteConfigController().getConfig()

    expect(config.capabilities.linux_capabilities_enabled).toBe(true)
  })
})
