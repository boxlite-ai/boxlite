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

  it.each(['0.13.0', '0.13.0-rc.1', '0.13.0+build.7', '0.13.0-rc.1+build.7'])(
    'preserves the explicit deployed identity %s',
    (version) => {
      process.env.VERSION = version
      jest.isolateModules(() => expect(require('./configuration').configuration.version).toBe(version))
    },
  )

  it.each(['', 'latest', '0.13', '01.13.0', '0.13.0-01', 'v0.13.0', ' 0.13.0', '0.13.0 ', '0.13.0+build.7 '])(
    'uses the bundled identity for invalid VERSION=%j',
    (version) => {
      process.env.VERSION = version
      const generated = require('../../../../src/boxlite/src/rest/api_version.json')
      jest.isolateModules(() => expect(require('./configuration').configuration.version).toBe(generated))
    },
  )
})
