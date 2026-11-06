/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Jest's CommonJS loader cannot evaluate this ESM dependency's import.meta and
// JSON imports. Use Node's native loader to exercise the published package.
module.exports = process.getBuiltinModule('node:module').createRequire(__filename)(
  '@visulima/disposable-email-domains/edge',
)
