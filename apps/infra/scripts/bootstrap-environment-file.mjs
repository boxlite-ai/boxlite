// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { config as loadDotenv } from 'dotenv'

import { parseFlag } from './cli-flags.mjs'

const BOOTSTRAP_VALUE_FLAGS = new Set(['stage', 'repo', 'reviewers', 'env-file'])
const BOOTSTRAP_BOOLEAN_FLAGS = new Set(['force', 'provision-auth0'])

export function validateBootstrapArguments(args) {
  if (!Array.isArray(args)) throw new Error('bootstrap arguments must be an array')
  const seen = new Set()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (typeof argument !== 'string' || !argument.startsWith('--')) {
      throw new Error('unexpected positional argument; bootstrap accepts named flags only')
    }

    const separator = argument.indexOf('=')
    const name = argument.slice(2, separator === -1 ? undefined : separator)
    const isValueFlag = BOOTSTRAP_VALUE_FLAGS.has(name)
    const isBooleanFlag = BOOTSTRAP_BOOLEAN_FLAGS.has(name)
    if (!isValueFlag && !isBooleanFlag) throw new Error(`unknown bootstrap argument --${name}`)
    if (seen.has(name)) throw new Error(`--${name} may be specified only once`)
    seen.add(name)

    if (isBooleanFlag) {
      if (separator !== -1) throw new Error(`--${name} does not take a value`)
      continue
    }

    if (separator !== -1) {
      if (!argument.slice(separator + 1)) throw new Error(`--${name} requires a value`)
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith('-')) throw new Error(`--${name} requires a value`)
    index += 1
  }
  return args
}

export function resolveBootstrapEnvironmentPath({ args = [], cwd = process.cwd(), defaultPath } = {}) {
  if (!Array.isArray(args)) throw new Error('bootstrap arguments must be an array')
  if (typeof cwd !== 'string' || !cwd) throw new Error('bootstrap working directory is required')
  if (typeof defaultPath !== 'string' || !defaultPath) throw new Error('default bootstrap dotenv path is required')

  const occurrences = args.filter(
    (argument) => argument === '--env-file' || argument.startsWith('--env-file='),
  ).length
  if (occurrences > 1) throw new Error('--env-file may be specified only once')

  const override = parseFlag(args, 'env-file')
  const selectedPath = override === undefined ? defaultPath : override
  if (!selectedPath) throw new Error('--env-file requires a non-empty path')
  if (selectedPath.includes('\0')) throw new Error('--env-file path must not contain a NUL byte')
  return resolve(cwd, selectedPath)
}

export function loadBootstrapEnvironment({ path, environment = process.env } = {}) {
  if (typeof path !== 'string' || !path) throw new Error('bootstrap dotenv path is required')

  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new Error(`could not read bootstrap dotenv file ${path}`, { cause })
  }

  const configuredKeys = []
  const seen = new Set()
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (!match) throw new Error(`invalid bootstrap dotenv assignment on line ${index + 1}; expected KEY=value`)
    const key = match[1]
    if (seen.has(key)) throw new Error(`duplicate bootstrap dotenv assignment for ${key}`)
    seen.add(key)
    configuredKeys.push(key)
  }

  const loaded = loadDotenv({ path, processEnv: environment, quiet: true, override: false })
  if (loaded.error) throw new Error(`could not parse bootstrap dotenv file ${path}`, { cause: loaded.error })
  return { environment, configuredKeys: configuredKeys.sort() }
}
