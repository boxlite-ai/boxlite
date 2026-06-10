/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export enum BoxClass {
  SMALL = 'small',
  MEDIUM = 'medium',
  LARGE = 'large',
}

export const BoxClassData = {
  [BoxClass.SMALL]: {
    cpu: 4,
    memory: 8,
    disk: 30,
  },
  [BoxClass.MEDIUM]: {
    cpu: 8,
    memory: 16,
    disk: 60,
  },
  [BoxClass.LARGE]: {
    cpu: 12,
    memory: 24,
    disk: 90,
  },
}
