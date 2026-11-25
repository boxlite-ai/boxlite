// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

import { runBundledMigrationCommand } from './migrations/bundled-migrations'

runBundledMigrationCommand(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
