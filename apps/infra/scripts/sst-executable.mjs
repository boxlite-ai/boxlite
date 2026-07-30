// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'

const requireFromInfra = createRequire(import.meta.url)

export function resolveSstExecutable(environment = process.env) {
  const configuredPath = environment.SST_BIN_PATH
  if (configuredPath !== undefined) {
    if (!configuredPath || configuredPath !== configuredPath.trim() || !isAbsolute(configuredPath)) {
      throw new Error('SST_BIN_PATH must be an absolute path without surrounding whitespace')
    }
    return configuredPath
  }

  const packageName = `sst-${process.platform}-${process.arch}`
  const binaryName = process.platform === 'win32' ? 'sst.exe' : 'sst'
  try {
    return requireFromInfra.resolve(join(packageName, 'bin', binaryName))
  } catch (cause) {
    throw new Error(`could not resolve the native SST executable from ${packageName}`, { cause })
  }
}
