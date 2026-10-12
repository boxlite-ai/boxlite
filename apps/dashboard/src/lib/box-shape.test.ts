/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState, NetworkMode, type NetworkInfo } from '@boxlite-ai/api-client'
import { describe, expect, it } from 'vitest'
import { boxCubeState, boxShape } from './box-shape'

function network(inbound: NetworkMode): NetworkInfo {
  return { outbound: { mode: NetworkMode.ENABLED, allow_net: [] }, inbound: { mode: inbound, allow_net: [] } }
}
const closed = network(NetworkMode.DISABLED)
const reachable = network(NetworkMode.ENABLED)

describe('boxShape', () => {
  it("treats the API's disabled value (0) and an unset autoDelete as a kept box", () => {
    // 0 is AUTO_DELETE_DISABLED, the column default, and what "Never" sends.
    expect(boxShape({ network: closed, autoDelete: 0 })).toBe('persistent')
    expect(boxShape({ network: closed, autoDelete: undefined })).toBe('persistent')
  })

  it('calls a box disposable only when it will delete itself', () => {
    expect(boxShape({ network: closed, autoDelete: 30 })).toBe('disposable')
  })

  it('lets inbound access win over lifecycle', () => {
    expect(boxShape({ network: reachable, autoDelete: 30 })).toBe('reachable')
  })
})

describe('boxCubeState', () => {
  it('lets a terminal state override the shape', () => {
    expect(boxCubeState({ network: reachable, autoDelete: 0, state: BoxState.ERROR })).toBe('error')
    expect(boxCubeState({ network: closed, autoDelete: 30, state: BoxState.STOPPED })).toBe('stopped')
  })

  it('falls through to the shape while the box runs', () => {
    expect(boxCubeState({ network: reachable, autoDelete: 0, state: BoxState.STARTED })).toBe('reachable')
  })
})
