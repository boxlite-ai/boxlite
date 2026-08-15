// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function readClickHouseSchema() {
  const sourcePath = new URL('../clickhouse/otel-schema-v0.144.0.sql', import.meta.url)
  const schemaPath = existsSync(sourcePath)
    ? sourcePath
    : resolve(process.cwd(), 'clickhouse/otel-schema-v0.144.0.sql')
  return readFileSync(schemaPath, 'utf8')
}
