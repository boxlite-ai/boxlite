describe('database connection acquisition budget', () => {
  const original = process.env.DB_POOL_CONNECTION_TIMEOUT_MS
  afterEach(() => {
    if (original === undefined) delete process.env.DB_POOL_CONNECTION_TIMEOUT_MS
    else process.env.DB_POOL_CONNECTION_TIMEOUT_MS = original
    jest.resetModules()
  })

  function timeout(value?: string): number {
    if (value === undefined) delete process.env.DB_POOL_CONNECTION_TIMEOUT_MS
    else process.env.DB_POOL_CONNECTION_TIMEOUT_MS = value
    jest.resetModules()
    return require('./configuration').configuration.database.pool.connectionTimeoutMillis
  }

  it('defaults to a finite five-second acquisition timeout', () => {
    expect(timeout()).toBe(5000)
  })

  it('honors a positive configured timeout', () => {
    expect(timeout('250')).toBe(250)
  })

  it.each(['0', '-1', '1.5', '100ms', 'Infinity', '2147483648'])('rejects invalid timeout %s', (value) => {
    expect(() => timeout(value)).toThrow('DB_POOL_CONNECTION_TIMEOUT_MS')
  })
})
