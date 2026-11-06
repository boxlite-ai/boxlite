/* Copyright 2026 BoxLite AI; SPDX-License-Identifier: AGPL-3.0 */
describe('MCP resource configuration', () => {
  const original = process.env.MCP_RESOURCE_URL
  afterEach(() => {
    if (original === undefined) delete process.env.MCP_RESOURCE_URL
    else process.env.MCP_RESOURCE_URL = original
  })

  function resource(value?: string) {
    if (value === undefined) delete process.env.MCP_RESOURCE_URL
    else process.env.MCP_RESOURCE_URL = value
    let configured: string | undefined
    jest.isolateModules(() => {
      configured = require('../config/configuration').configuration.mcp.resourceUrl
    })
    return configured
  }

  it('leaves discovery disabled without a canonical resource', () => {
    expect(resource()).toBeUndefined()
  })

  it.each([
    'https://api.example.test/api/mcp',
    'http://localhost:3001/api/mcp',
    'http://127.0.0.1:3001/api/mcp',
    'http://[::1]:3001/api/mcp',
  ])('accepts %s', (value) => {
    expect(resource(value)).toBe(value)
  })

  it.each([
    'not a URL',
    'http://api.example.test/api/mcp',
    'ftp://api.example.test/api/mcp',
    'https://user:secret@api.example.test/api/mcp',
    'https://api.example.test/api/mcp?',
    'https://api.example.test/api/mcp#',
    'https://api.example.test/other',
    'https://api.example.test/api/mcp/',
  ])('rejects a noncanonical resource %s', (value) => {
    expect(() => resource(value)).toThrow('MCP_RESOURCE_URL')
  })
})
