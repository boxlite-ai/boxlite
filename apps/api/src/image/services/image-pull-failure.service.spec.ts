/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ImagePullFailureService } from './image-pull-failure.service'

describe('ImagePullFailureService', () => {
  /**
   * Every caller is in the middle of recording that a box failed. A catalog
   * that cannot be read must cost the explanation, not the failure: the box
   * still has to land in ERROR with a reason.
   */
  it('records the runtime reason when the catalog cannot be read', async () => {
    const unreachable = {
      createQueryBuilder: () => {
        throw new Error('connection terminated')
      },
    }
    const service = new ImagePullFailureService(unreachable as never, unreachable as never)
    const reason = `failed to pull manifest [MANIFEST_UNKNOWN]: manifest unknown`

    await expect(
      service.reasonFor({ organizationId: 'org-1', image: `quay.io/acme/app@sha256:${'a'.repeat(64)}` }, reason),
    ).resolves.toBe(reason)
  })
})
