import { BoxliteConfigController } from './boxlite-config.controller'

describe('memory snapshot capability', () => {
  it('never advertises real memory capture or restore', () => {
    const capabilities = new BoxliteConfigController().getConfig().capabilities
    expect(capabilities.memory_snapshots_enabled).toBe(false)
    expect(capabilities.snapshots_enabled).toBe(true)
  })
})
