/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { requiresFreshBox } from './warm-pool-eligibility.util'

const NO_ORG_EGRESS_LIMIT = { boxLimitedNetworkEgress: false }
const CURATED = { isOrgOwned: false }

describe('requiresFreshBox', () => {
  it('lets a plain request claim a warm-pool box', () => {
    expect(requiresFreshBox({}, NO_ORG_EGRESS_LIMIT, CURATED)).toBe(false)
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
    expect(requiresFreshBox(dto, NO_ORG_EGRESS_LIMIT, CURATED)).toBe(true)
  })

  // Pre-existing behaviour, pinned here because the rule now lives in one place.
  it.each([
    ['networkBlockAll', { networkBlockAll: true }],
    ['networkAllowList', { networkAllowList: 'api.openai.com' }],
  ])('forces a fresh box when %s is requested', (_label, dto) => {
    expect(requiresFreshBox(dto, NO_ORG_EGRESS_LIMIT, CURATED)).toBe(true)
  })

  it('forces a fresh box when the organization limits egress', () => {
    expect(requiresFreshBox({}, { boxLimitedNetworkEgress: true }, CURATED)).toBe(true)
  })

  // Secrets become placeholder env vars + an MITM CA when the box is built; a
  // warm box was built without them, so claiming one would silently drop them.
  it('forces a fresh box when secrets are requested', () => {
    expect(requiresFreshBox({ secrets: [{ name: 'openai', value: 'sk-test' }] }, NO_ORG_EGRESS_LIMIT, CURATED)).toBe(
      true,
    )
  })

  /**
   * The pool holds boxes with no organization, claimable by any of them, so an
   * organization's own image must never be served from it — however plain the
   * rest of the request is. This is also what keeps an org image out of the
   * `warm-pool:skip:<image>` Redis key, whose name is otherwise tenant input.
   */
  it('forces a fresh box for an image the organization owns', () => {
    expect(requiresFreshBox({}, NO_ORG_EGRESS_LIMIT, { isOrgOwned: true })).toBe(true)
  })

  // `false` is a value the caller supplied, not an absence — it still pins the
  // box to a network policy the pool was not provisioned for.
  it('treats an explicit networkBlockAll: false as a policy override', () => {
    expect(requiresFreshBox({ networkBlockAll: false }, NO_ORG_EGRESS_LIMIT, CURATED)).toBe(true)
  })
})
