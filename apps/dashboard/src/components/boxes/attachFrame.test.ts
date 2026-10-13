/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it } from 'vitest'
import { decodeAttachFrame } from './attachFrame'

const frame = (...bytes: number[]) => new Uint8Array(bytes).buffer

describe('decodeAttachFrame', () => {
  it('strips the channel byte from stdout and stderr', () => {
    expect(decodeAttachFrame(frame(1, 104, 105))).toEqual({ kind: 'output', bytes: new Uint8Array([104, 105]) })
    expect(decodeAttachFrame(frame(2, 33))).toEqual({ kind: 'output', bytes: new Uint8Array([33]) })
  })

  it('ignores an unknown channel and an empty payload', () => {
    expect(decodeAttachFrame(frame(9, 104))).toEqual({ kind: 'ignored' })
    expect(decodeAttachFrame(frame(1))).toEqual({ kind: 'ignored' })
  })

  it('reads exit and error control frames', () => {
    expect(decodeAttachFrame('{"type":"exit","exit_code":130}')).toEqual({ kind: 'exit', exitCode: 130 })
    expect(decodeAttachFrame('{"type":"error","message":"read-only"}')).toEqual({ kind: 'error', message: 'read-only' })
    expect(decodeAttachFrame('not json')).toEqual({ kind: 'ignored' })
  })
})
