// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const SST_STAGE_PATTERN = /^[a-z0-9]{1,20}$/

// Version 4.6.11 at this source commit was audited for cli Load, stage
// Overload, inherited os.Environ, SST_LOG, and fixed Pulumi log behavior.
// Any SST upgrade must deliberately re-audit those native boundaries.
export const AUDITED_SST_NATIVE_VERSION = '4.6.11'
export const AUDITED_SST_SOURCE_COMMIT = 'c36553cf648fa0ec748197bae0ad5035000421a7'

export function resolveSstConfigDirectory(args, workingDirectory) {
  if (!Array.isArray(args)) throw new Error('SST arguments must be an array')
  if (typeof workingDirectory !== 'string' || !workingDirectory) {
    throw new Error('SST working directory must be a non-empty path')
  }

  let configPath
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') {
      break
    } else if (argument === '--config') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error('SST --config requires a path')
      if (configPath !== undefined) throw new Error('SST --config may be specified only once')
      configPath = value
      index += 1
      continue
    }
    if (argument.startsWith('--config=')) {
      const value = argument.slice('--config='.length)
      if (!value) throw new Error('SST --config requires a path')
      if (configPath !== undefined) throw new Error('SST --config may be specified only once')
      configPath = value
    }
  }
  if (configPath?.includes('\0')) throw new Error('SST --config path must not contain a NUL byte')
  return configPath === undefined ? resolve(workingDirectory) : dirname(resolve(workingDirectory, configPath))
}

export function assertNoSstStageEnvironmentFile({ args, stage, workingDirectory, inspect = lstatSync }) {
  if (typeof stage !== 'string' || !SST_STAGE_PATTERN.test(stage)) {
    throw new Error('cannot guard the native SST stage environment for an invalid stage')
  }
  const configDirectory = resolveSstConfigDirectory(args, workingDirectory)
  const path = resolve(configDirectory, `.env.${stage}`)
  try {
    inspect(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return path
    throw new Error(`could not verify that native SST stage environment file ${path} is absent`)
  }
  throw new Error(
    `native SST stage environment file ${path} is forbidden; move the setting into bootstrap-owned deployment config`,
  )
}

export function assertSstBaseEnvironmentIsClassified({
  args,
  workingDirectory,
  classifiedNames,
  read = readFileSync,
}) {
  if (!(classifiedNames instanceof Set) || [...classifiedNames].some((name) => typeof name !== 'string')) {
    throw new Error('classified SST environment names must be a Set of strings')
  }
  const configDirectory = resolveSstConfigDirectory(args, workingDirectory)
  const paths = [...new Set([resolve(workingDirectory, '.env'), resolve(configDirectory, '.env')])]
  for (const path of paths) {
    let source
    try {
      source = read(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw new Error(`could not inspect bootstrap environment key names in ${path}`)
    }
    if (typeof source !== 'string' || source.includes('\0')) {
      throw new Error(`bootstrap environment ${path} has unsupported syntax`)
    }

    const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (/^\s*(?:#.*)?$/.test(line)) continue
      const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|:(?:\s+|$))/.exec(line)
      if (!assignment) {
        throw new Error(`bootstrap environment ${path} has unsupported syntax at line ${index + 1}`)
      }
      const name = assignment[1]
      if (!classifiedNames.has(name)) {
        throw new Error(`bootstrap environment ${path} contains unclassified key ${name}`)
      }
    }
  }
  return paths
}
