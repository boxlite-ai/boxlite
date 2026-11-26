/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
describe('hosted CI worker image', () => {
  it.each([
    [undefined, 'ghcr.io/boxlite-ai/boxlite-jitbox:latest'],
    ['registry.example/worker:v2', 'registry.example/worker:v2'],
  ])('resolves CI_WORKER_IMAGE=%s', (configured, expected) => {
    const env = jest.replaceProperty(process, 'env', { ...process.env })
    try {
      if (configured === undefined) delete process.env.CI_WORKER_IMAGE
      else process.env.CI_WORKER_IMAGE = configured
      jest.isolateModules(() => {
        expect(require('./configuration').configuration.ci.workerImage).toBe(expected)
      })
    } finally {
      env.restore()
    }
  })
})
