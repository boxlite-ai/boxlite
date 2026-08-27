/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { requiresFreshBox } from './warm-pool-eligibility.util'

const NO_ORG_EGRESS_LIMIT = { boxLimitedNetworkEgress: false }

describe('requiresFreshBox', () => {
  it('lets a plain request claim a warm-pool box', () => {
    expect(requiresFreshBox({}, NO_ORG_EGRESS_LIMIT)).toBe(false)
  })

  // These four are fixed when the container is built. A warm box is already
  // booted, and the pool key (warm_pool_find_idx) does not cover any of them,
  // so claiming one would return 201 with a box that ignored the request —
  // the same silent drop this change closes at the mapper.
  it.each([
    ['runAsUser', { runAsUser: '1000:1000' }],
    ['workingDir', { workingDir: '/app' }],
    ['entrypoint', { entrypoint: ['python'] }],
    ['cmd', { cmd: ['-c', 'print(1)'] }],
  ])('forces a fresh box when %s is requested', (_label, dto) => {
    expect(requiresFreshBox(dto, NO_ORG_EGRESS_LIMIT)).toBe(true)
  })

  // Pre-existing behaviour, pinned here because the rule now lives in one place.
  it.each([
    ['networkBlockAll', { networkBlockAll: true }],
    ['networkAllowList', { networkAllowList: 'api.openai.com' }],
  ])('forces a fresh box when %s is requested', (_label, dto) => {
    expect(requiresFreshBox(dto, NO_ORG_EGRESS_LIMIT)).toBe(true)
  })

  it('forces a fresh box when the organization limits egress', () => {
    expect(requiresFreshBox({}, { boxLimitedNetworkEgress: true })).toBe(true)
  })

  // `false` is a value the caller supplied, not an absence — it still pins the
  // box to a network policy the pool was not provisioned for.
  it('treats an explicit networkBlockAll: false as a policy override', () => {
    expect(requiresFreshBox({ networkBlockAll: false }, NO_ORG_EGRESS_LIMIT)).toBe(true)
  })
})
