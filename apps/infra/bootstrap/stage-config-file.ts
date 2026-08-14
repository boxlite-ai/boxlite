// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * The short-lived file `sst secret load` reads the stage configuration from.
 *
 * `secret load` takes a path and has no stdin form, so the whole configuration — every domain, issuer
 * and token in the operator's .env — has to exist on disk for the length of one command. That is the
 * only reason this file exists, and everything here is about keeping that window small and closed:
 *
 *   - a directory of its own, from mkdtemp, so the 0700 it creates keeps other users out even before
 *     the file inside it exists;
 *   - 0600 on the file as well, so a umask that would have widened it cannot;
 *   - removal in `finally`, so a failed load leaves nothing behind — which is the case that matters,
 *     since that is when someone is most likely to walk away from the terminal.
 *
 * Extracted from bootstrap so those three properties can be tested without running sst.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { serializeStageConfig } from './environment.js'

export function withStageConfigFile<T>(config: any, use: (configPath: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-stage-config-'))
  try {
    const configPath = join(directory, 'stage-config.env')
    writeFileSync(configPath, serializeStageConfig(config), { mode: 0o600 })
    return use(configPath)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
