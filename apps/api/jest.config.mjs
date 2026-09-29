/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { fileURLToPath } from 'node:url'

export default {
  displayName: 'boxlite',
  preset: '../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
    '^.+\\.mjs$': [
      'babel-jest',
      {
        babelrc: false,
        configFile: false,
        presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }]],
      },
    ],
  },
  // Transform ESM dependencies used by the API and real HTTP proxy tests.
  transformIgnorePatterns: ['/node_modules/(?!(?:uuid|nanoid|http-proxy-middleware|httpxy|is-plain-obj)/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/*.d.ts'],
  coverageReporters: ['text', ['lcov', { projectRoot: fileURLToPath(new URL('../..', import.meta.url)) }]],
  coverageDirectory: '../../target/coverage/api',
}
