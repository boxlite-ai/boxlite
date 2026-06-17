/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export default {
  displayName: 'boxlite',
  preset: '../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  // uuid v14 and nanoid v5 ship ESM-only. The nx preset ignores node_modules
  // from transformation, so let ts-jest down-level them.
  transformIgnorePatterns: ['/node_modules/(?!(?:uuid|nanoid)/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/boxlite',
}
