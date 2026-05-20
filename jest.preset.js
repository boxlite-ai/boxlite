/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 *
 * BoxLite note: upstream daytona installs Node packages at the repo root; in
 * BoxLite the workspace is rooted under apps/ (the only node_modules lives at
 * apps/node_modules). Resolve `@nx/jest` explicitly from there so this preset
 * works when jest is invoked from apps/<project>/ pointing at this file.
 */

const path = require('path')

const nxJestPath = require.resolve('@nx/jest/preset', {
  paths: [path.join(__dirname, 'apps', 'node_modules')],
})

const nxPreset = require(nxJestPath).default

module.exports = { ...nxPreset }
