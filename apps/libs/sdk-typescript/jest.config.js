/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // Mirror the workspace path aliases from apps/tsconfig.base.json — jest does
  // not read tsconfig paths, and this package is not a yarn workspace member.
  moduleNameMapper: {
    '^@boxlite-ai/api-client$': '<rootDir>/../api-client/src/index.ts',
    '^@boxlite-ai/runner-api-client$': '<rootDir>/../runner-api-client/src/index.ts',
    '^@boxlite-ai/toolbox-api-client$': '<rootDir>/../toolbox-api-client/src/index.ts',
    '^@boxlite-ai/analytics-api-client$': '<rootDir>/../analytics-api-client/src/index.ts',
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  passWithNoTests: true,
}
