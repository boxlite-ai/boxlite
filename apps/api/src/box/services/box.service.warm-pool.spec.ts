/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxService } from './box.service'
import { BoxClass } from '../enums/box-class.enum'
import { WarmPool } from '../entities/warm-pool.entity'

function warmPoolItem(): WarmPool {
  const item = new WarmPool()
  item.target = 'us'
  item.class = BoxClass.SMALL
  item.cpu = 1
  item.gpu = 0
  item.mem = 1
  item.disk = 3
  item.env = {}
  return item
}

describe('BoxService.createForWarmPool image', () => {
  // Isolate from env-configured curated refs so the pinned fallback is deterministic;
  // otherwise BOXLITE_SYSTEM_BASE_IMAGE in the host env would make this assertion flaky.
  const ENV_KEYS = ['BOXLITE_SYSTEM_BASE_IMAGE', 'BOXLITE_SYSTEM_PYTHON_IMAGE', 'BOXLITE_SYSTEM_NODE_IMAGE']
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('defaults warm-pool boxes to the base image ref so they can boot', async () => {
    const insert = jest.fn().mockResolvedValue(undefined)
    const getRandomAvailableRunner = jest.fn().mockResolvedValue({ id: 'runner-1' })

    const service = Object.create(BoxService.prototype) as BoxService
    ;(service as any).boxRepository = { insert }
    ;(service as any).runnerService = { getRandomAvailableRunner }

    const box = await service.createForWarmPool(warmPoolItem())

    expect(box.image).toBe(
      'ghcr.io/boxlite-ai/boxlite-agent-base@sha256:834dcb65465985fc2f648451d76c81d166bc7672391c9064a0a115ce6306c85f',
    )
    expect(insert).toHaveBeenCalledWith(box)
  })
})
