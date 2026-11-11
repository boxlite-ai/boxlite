describe('API build identity', () => {
  const previous = process.env.VERSION
  afterEach(() => {
    if (previous === undefined) delete process.env.VERSION
    else process.env.VERSION = previous
  })

  it('uses the bundled identity for local runs and direct Docker builds', () => {
    delete process.env.VERSION
    const generated = require('../../../../src/boxlite/src/rest/api_version.json')
    jest.isolateModules(() => expect(require('./configuration').configuration.version).toBe(generated))
    expect(typeof generated).toBe('string')
  })

  it('preserves an explicit deployed identity', () => {
    process.env.VERSION = '0.13.0'
    jest.isolateModules(() => expect(require('./configuration').configuration.version).toBe('0.13.0'))
  })
})
