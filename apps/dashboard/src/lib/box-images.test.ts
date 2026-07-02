import { describe, expect, it } from 'vitest'
import { getBoxImageOptions, getDefaultBoxImage, resolveCreateBoxImageRef } from './box-images'

describe('box image options', () => {
  it('uses the arm64-capable base v0.1.0 image for local box creation', () => {
    const images = getBoxImageOptions('local')
    const defaultImage = getDefaultBoxImage(images)

    expect(images.map((image) => image.ref)).toEqual(['ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0'])
    expect(defaultImage.name).toBe('Base')
    expect(resolveCreateBoxImageRef(defaultImage.ref)).toBe('ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0')
  })

  it('keeps curated image refs available outside local', () => {
    const images = getBoxImageOptions('production')
    const defaultImage = getDefaultBoxImage(images)

    expect(images.map((image) => image.name)).toEqual(['Base', 'Python', 'Node.js'])
    expect(resolveCreateBoxImageRef(defaultImage.ref)).toBe('ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3')
  })

  it('treats an empty image ref as omitted in the Box API request', () => {
    expect(resolveCreateBoxImageRef('')).toBeUndefined()
    expect(resolveCreateBoxImageRef('ghcr.io/boxlite-ai/boxlite-agent-node:20260605-p0-r3')).toBe(
      'ghcr.io/boxlite-ai/boxlite-agent-node:20260605-p0-r3',
    )
  })
})
