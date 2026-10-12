/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

describe('getServiceType', () => {
  const originalAppMode = process.env.APP_MODE

  afterEach(() => {
    if (originalAppMode === undefined) {
      delete process.env.APP_MODE
    } else {
      process.env.APP_MODE = originalAppMode
    }
  })

  // app-mode reads APP_MODE once at load, so each case loads a fresh copy.
  async function serviceTypeFor(appMode: string | undefined): Promise<string> {
    if (appMode === undefined) {
      delete process.env.APP_MODE
    } else {
      process.env.APP_MODE = appMode
    }
    let serviceType = ''
    await jest.isolateModulesAsync(async () => {
      const { getServiceType } = await import('./app-mode')
      serviceType = getServiceType()
    })
    return serviceType
  }

  it.each([
    ['api', 'api'],
    ['worker', 'worker'],
    ['all', 'api'],
    [undefined, 'api'],
  ])('reports APP_MODE=%s as %s', async (appMode, expected) => {
    await expect(serviceTypeFor(appMode)).resolves.toBe(expected)
  })
})
