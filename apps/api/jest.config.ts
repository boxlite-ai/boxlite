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
  // uuid v14 ships ESM-only (`export` syntax). The nx preset ignores node_modules
  // from transformation, so any spec that transitively imports an entity using
  // `uuid` (e.g. via OrganizationService) crashes on the ESM. Let ts-jest down-level it.
  transformIgnorePatterns: ['/node_modules/(?!(?:uuid)/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/apps/boxlite',
}
