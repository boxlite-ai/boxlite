/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it } from 'vitest'
import { catalogNameOf, conflictBoxIds, imageRouteKey, imageStartRef, registryHostOf, TAG_PATTERN } from './image-ref'

// A box stores the reference it was created with; the catalog lists images
// by the name the API normalises it to. Matching the two is how a page finds
// the boxes behind an image, so this must agree with the API.
describe('catalogNameOf', () => {
  it.each([
    ['python', 'docker.io/library/python'],
    ['python:3.12-slim', 'docker.io/library/python'],
    ['acme/app:1', 'docker.io/acme/app'],
    ['docker.io/python', 'docker.io/library/python'],
    ['ghcr.io/acme/agent:v1.4.2', 'ghcr.io/acme/agent'],
    ['ghcr.io/acme/agent@sha256:abc', 'ghcr.io/acme/agent'],
    ['localhost:5000/tool:dev', 'localhost:5000/tool'],
  ])('names %s as %s', (ref, name) => {
    expect(catalogNameOf(ref)).toBe(name)
  })

  it('reads the host off a reference', () => {
    expect(registryHostOf('quay.io/acme/tools:2')).toBe('quay.io')
    expect(registryHostOf('python')).toBe('docker.io')
  })
})

describe('imageRouteKey', () => {
  it('routes an organization image by its catalog id', () => {
    expect(imageRouteKey({ id: 'abc-123', name: 'quay.io/acme/app' })).toBe('abc-123')
  })

  // A built-in image has no id; its short name, which carries no slash, stands in.
  it('routes a built-in image by its name', () => {
    expect(imageRouteKey({ id: null, name: 'python' })).toBe('python')
  })
})

describe('imageStartRef', () => {
  it('starts a built-in image under its short name, which the create API takes', () => {
    expect(imageStartRef({ name: 'python', aliases: [], curated: true })).toBe('python')
  })

  it('starts an organization image at its first pinned tag', () => {
    expect(imageStartRef({ name: 'ghcr.io/acme/agent', aliases: ['v1', 'stable'], curated: false })).toBe(
      'ghcr.io/acme/agent:v1',
    )
  })

  it('starts an image with no tag by its bare name', () => {
    expect(imageStartRef({ name: 'ghcr.io/acme/agent', aliases: [], curated: false })).toBe('ghcr.io/acme/agent')
  })
})

describe('conflictBoxIds', () => {
  it('reads the box ids a removal refusal lists', () => {
    expect(
      conflictBoxIds("Image 'quay.io/acme/app' cannot be removed while 2 box(es) can still boot from it: b-1, b-2"),
    ).toEqual(['b-1', 'b-2'])
  })
})

describe('TAG_PATTERN', () => {
  it.each(['v1', 'stable', '3.14-slim-bookworm', '_x'])('accepts %s', (tag) => {
    expect(TAG_PATTERN.test(tag)).toBe(true)
  })

  it.each(['', '.hidden', '-dash', 'has space', 'a'.repeat(129)])('refuses %j', (tag) => {
    expect(TAG_PATTERN.test(tag)).toBe(false)
  })
})
