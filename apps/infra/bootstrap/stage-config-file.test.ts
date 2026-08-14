// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import { withStageConfigFile } from './stage-config-file.js'

const CONFIG = { STACK_DOMAIN: 'dev.boxlite.ai', OIDC_AUDIENCE: 'https://dev.boxlite.ai/api' }

test('hands sst a file holding exactly the serialized configuration', () => {
  // What `sst secret load` will parse. Read inside the callback because the file is gone after it.
  const contents = withStageConfigFile(CONFIG, (path: string) => readFileSync(path, 'utf8'))
  assert.equal(contents, "OIDC_AUDIENCE='https://dev.boxlite.ai/api'\nSTACK_DOMAIN='dev.boxlite.ai'\n")
})

test('keeps the configuration unreadable to other users while it exists', () => {
  // The whole stage configuration sits on disk for the length of one command. Both the file and the
  // directory holding it are checked: a permissive umask would widen the file, and a shared parent
  // would expose it regardless of the file's own mode.
  const modes = withStageConfigFile(CONFIG, (path: string) => ({
    file: statSync(path).mode & 0o777,
    directory: statSync(dirname(path)).mode & 0o777,
  }))
  assert.equal(modes.file, 0o600)
  assert.equal(modes.directory, 0o700)
})

test('removes the file once the load has finished', () => {
  const path = withStageConfigFile(CONFIG, (configPath: string) => configPath)
  assert.equal(existsSync(path), false)
  assert.equal(existsSync(dirname(path)), false, 'the directory goes too, not just the file')
})

test('removes the file when the load fails', () => {
  // The case that matters: `secret load` throwing is exactly when someone walks away from the
  // terminal, and a `finally` is the only thing that stops the configuration staying in /tmp.
  let path = ''
  assert.throws(
    () =>
      withStageConfigFile(CONFIG, (configPath: string) => {
        path = configPath
        throw new Error('synthetic secret load failure')
      }),
    /synthetic secret load failure/,
  )
  assert.notEqual(path, '')
  assert.equal(existsSync(path), false)
  assert.equal(existsSync(dirname(path)), false)
})

test('refuses a configuration it cannot represent before writing anything', () => {
  // serializeStageConfig throws on a value the single-quoted form cannot carry. Nothing may reach
  // disk in that case, and the callback must never run.
  let ran = false
  assert.throws(
    () => withStageConfigFile({ GHCR_TOKEN: "it's quoted" }, () => (ran = true)),
    /GHCR_TOKEN contains a single quote or newline/,
  )
  assert.equal(ran, false)
})
