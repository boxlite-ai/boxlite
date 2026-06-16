import { describe, expect, it } from 'vitest'
import { SUPPORTED_BOX_IMAGES } from './supportedBoxImages'

describe('supported box images', () => {
  it('exposes the three versioned runtime image refs, base first', () => {
    expect(SUPPORTED_BOX_IMAGES.map((image) => image.ref)).toEqual([
      'ghcr.io/boxlite-ai/boxlite-agent-base-v2:v0.9.5',
      'ghcr.io/boxlite-ai/boxlite-agent-python-v2:v0.9.5',
      'ghcr.io/boxlite-ai/boxlite-agent-node-v2:v0.9.5',
    ])
    expect(SUPPORTED_BOX_IMAGES[0]).toMatchObject({ id: 'base', isDefault: true })
  })
})
