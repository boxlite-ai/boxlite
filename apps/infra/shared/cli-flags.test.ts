// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { hasFlag, parseFlag } from './cli-flags.js'

test('parseFlag reads both the separated and inline forms', () => {
  assert.equal(parseFlag(['--stage', 'dev'], 'stage'), 'dev')
  assert.equal(parseFlag(['--stage=dev'], 'stage'), 'dev')
})

test('parseFlag returns undefined when the flag is absent', () => {
  assert.equal(parseFlag(['--force'], 'stage'), undefined)
  assert.equal(parseFlag([], 'stage'), undefined)
})

test('parseFlag rejects a flag whose value is the next flag', () => {
  // `--stage --force` must not silently adopt '--force' as the stage name.
  assert.throws(() => parseFlag(['--stage', '--force'], 'stage'), /--stage requires a value/)
  assert.throws(() => parseFlag(['--stage'], 'stage'), /--stage requires a value/)
})

test('parseFlag treats an empty inline value as empty, not missing', () => {
  // Distinguishes "flag absent" (undefined) from "flag given empty" (''), so a
  // caller can tell them apart. login.ts treats both as "all providers".
  assert.equal(parseFlag(['--only='], 'only'), '')
})

test('parseFlag does not match a flag that merely starts with the name', () => {
  assert.equal(parseFlag(['--stagey=x'], 'stage'), undefined)
})

test('hasFlag detects a bare boolean flag only when exact', () => {
  assert.equal(hasFlag(['--force'], 'force'), true)
  assert.equal(hasFlag(['--forced'], 'force'), false)
  assert.equal(hasFlag([], 'force'), false)
})
