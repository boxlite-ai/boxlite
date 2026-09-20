/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { supportedImages } from '../constants/curated-images.constant'
import { isCuratedSelector } from '../../image/utils/image-ref.util'
import { Box } from '../entities/box.entity'
import { boxImageIsOrgOwned, boxImageNeedsRevalidate } from './image-ownership.util'

const DIGEST_REF = `quay.io/acme/app@sha256:${'a'.repeat(64)}`

/** Whatever is curated now, rather than a literal that a ref bump would strand. */
const CURATED_REF = supportedImages()[0].ref

/**
 * A reference the curated set has moved past — the shape an operator leaves
 * behind by rotating one. Asserted rather than assumed: if a future ref bump
 * made this one curated again, every rotation case below would quietly stop
 * testing anything.
 */
const ROTATED_AWAY_REF = 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.0.1'

function box(image: string | undefined, imageIsOrgOwned: boolean | null): Pick<Box, 'image' | 'imageIsOrgOwned'> {
  return { image, imageIsOrgOwned }
}

describe('boxImageIsOrgOwned', () => {
  it.each([
    ['a recorded tenant image', 'quay.io/acme/app:v1', true, true],
    ['a recorded curated image', CURATED_REF, false, false],
  ])('%s is answered from the row, not the ref', (_label, image, recorded, expected) => {
    expect(boxImageIsOrgOwned(box(image as string, recorded as boolean))).toBe(expected)
  })

  /**
   * The defect this column exists for. An operator who rotates a curated
   * reference makes `isCuratedSelector` false for every box still running the
   * old one; recomputing would file the operator's image into that box's
   * organization, against that organization's catalog limit.
   *
   * `CURATED_REF` is in the curated set here, so a recorded `false` and a
   * recomputed answer agree — which is exactly why the rotated case has to be
   * spelled with a ref that is *not* in the set.
   */
  it('keeps a curated box curated after the curated set moves on without it', () => {
    expect(isCuratedSelector(ROTATED_AWAY_REF)).toBe(false)

    expect(boxImageIsOrgOwned(box(ROTATED_AWAY_REF, false))).toBe(false)
    expect(boxImageIsOrgOwned(box(ROTATED_AWAY_REF, null))).toBe(true)
  })

  describe('a row written before the column existed', () => {
    it.each([
      ['a curated ref', CURATED_REF, false],
      ['an unset image', undefined, false],
      ['a tenant ref', 'quay.io/acme/app:v1', true],
    ])('falls back to reading %s', (_label, image, expected) => {
      expect(boxImageIsOrgOwned(box(image as string | undefined, null))).toBe(expected)
    })
  })
})

describe('boxImageNeedsRevalidate', () => {
  it.each([
    ['a tenant tag', 'quay.io/acme/app:v1', true, true],
    ['a tenant bare repository', 'quay.io/acme/app', true, true],
    ['a tenant digest', DIGEST_REF, true, false],
    ['a curated ref', CURATED_REF, false, false],
  ])('%s ⇒ %s', (_label, image, recorded, expected) => {
    expect(boxImageNeedsRevalidate(box(image as string, recorded as boolean))).toBe(expected)
  })

  /**
   * A curated image the set has moved past must not start asking the registry:
   * that is a round trip on the path every create took before any of this
   * existed, and the answer would be a build nobody chose.
   */
  it('does not revalidate a curated box after the curated set moves on without it', () => {
    expect(boxImageNeedsRevalidate(box(ROTATED_AWAY_REF, false))).toBe(false)
  })
})
