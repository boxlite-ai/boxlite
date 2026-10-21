/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/// <reference types="vite/client" />

declare module '*.png' {
  const content: string
  export default content
}

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  /** The Micro-cloud console API, e.g. /console/api; set only in the Apps console build. */
  readonly VITE_APPS_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
