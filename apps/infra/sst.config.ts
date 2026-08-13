// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026

/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  async app(input) {
    const { configureApp } = await import('./stack/app.js')
    return configureApp(input)
  },

  async run() {
    const { deployStack } = await import('./stack/index.js')
    return deployStack()
  },
})
