import { describe, expect, it } from 'vitest'
import { SUPPORTED_BOX_IMAGES } from './supportedBoxImages'

describe('supported box images', () => {
  it('exposes the three versioned runtime image refs, base first', () => {
    expect(SUPPORTED_BOX_IMAGES.map((image) => image.ref)).toEqual([
      'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0',
      'ghcr.io/boxlite-ai/boxlite-agent-python:v0.1.0',
      'ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0',
    ])
    expect(SUPPORTED_BOX_IMAGES[0]).toMatchObject({ id: 'base', isDefault: true })
  })
})
