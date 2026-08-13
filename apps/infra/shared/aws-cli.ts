// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

const STANDARD_AWS_CLI_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

export function resolveAwsCliPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredPath = environment.AWS_CLI_PATH?.trim()
  const candidates = configuredPath
    ? [configuredPath]
    : [
        ...(environment.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, 'aws')),
        ...STANDARD_AWS_CLI_DIRECTORIES.map((directory) => join(directory, 'aws')),
      ]

  for (const candidate of new Set(candidates)) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH and standard package-manager locations.
    }
  }

  const detail = configuredPath ? `AWS_CLI_PATH=${configuredPath}` : 'PATH and standard install locations'
  const error = new Error(`AWS CLI not found via ${detail}`) as NodeJS.ErrnoException
  error.code = 'ENOENT'
  throw error
}
