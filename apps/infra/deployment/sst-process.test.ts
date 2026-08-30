// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { SstProcessTerminator } from './sst-process.js'

test('force-stops SST after its graceful cancellation period expires', async () => {
  const child = {}
  const signals: any[] = []
  const terminator = new SstProcessTerminator({
    signalProcess(actualChild, signal) {
      assert.equal(actualChild, child)
      signals.push(signal)
    },
    terminationGraceMs: 10,
  })

  terminator.attach(child)
  terminator.interrupt()
  assert.deepEqual(signals, ['SIGINT'])

  await delay(30)
  assert.deepEqual(signals, ['SIGINT', 'SIGKILL'])
})

test('clears the force-stop timer when SST settles during graceful cancellation', async () => {
  const child = {}
  const signals: any[] = []
  const terminator = new SstProcessTerminator({
    signalProcess(_child, signal) {
      signals.push(signal)
    },
    terminationGraceMs: 10,
  })

  terminator.attach(child)
  terminator.interrupt()
  terminator.settle(child)

  await delay(30)
  assert.deepEqual(signals, ['SIGINT'])
})
