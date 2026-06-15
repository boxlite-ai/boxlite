/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// TODO(image-rewrite): resource defaults previously came from the removed image subsystem;
// these mirror the BoxService create fallback until image resolution is rebuilt.
export const BOX_CREATE_DEFAULTS = {
  cpu: 1,
  memory: 2,
  disk: 10,
  gpu: 0,
} as const
