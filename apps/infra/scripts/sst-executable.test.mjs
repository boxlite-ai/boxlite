// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import test from 'node:test'

import { resolveSstExecutable } from './sst-executable.mjs'

test('resolves the installed native SST executable', () => {
  const executable = resolveSstExecutable({})

  assert.equal(isAbsolute(executable), true)
  assert.match(executable, new RegExp(`sst-${process.platform}-${process.arch}`))
})

test('accepts only an explicit absolute SST executable override', () => {
  assert.equal(resolveSstExecutable({ SST_BIN_PATH: '/synthetic/bin/sst' }), '/synthetic/bin/sst')
  for (const configuredPath of ['', 'sst', ' /synthetic/bin/sst']) {
    assert.throws(() => resolveSstExecutable({ SST_BIN_PATH: configuredPath }), /SST_BIN_PATH must be an absolute path/)
  }
})
