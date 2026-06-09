import { parseDockerImage } from './docker-image.util'

describe('parseDockerImage', () => {
  it('preserves digest image references when rebuilding the full name', () => {
    const digest = '1db4c9815a3353bf2e5730b62c24c364b53d53ca0a52722c5d79f32df935b6fd'

    const image = parseDockerImage(`ghcr.io/boxlite-ai/boxlite-agent-base@sha256:${digest}`)

    expect(image.registry).toBe('ghcr.io')
    expect(image.project).toBe('boxlite-ai')
    expect(image.repository).toBe('boxlite-agent-base')
    expect(image.tag).toBeUndefined()
    expect(image.digest).toBe(`sha256:${digest}`)
    expect(image.getFullName()).toBe(`ghcr.io/boxlite-ai/boxlite-agent-base@sha256:${digest}`)
  })
})
