/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { CustomDomainDnsService } from './custom-domain-dns.service'
import { EventEmitter } from 'node:events'
import { connect } from 'node:tls'

jest.mock('node:tls', () => ({ connect: jest.fn() }))

const resolver = {
  setServers: jest.fn(),
  cancel: jest.fn(),
  resolveTxt: jest.fn(),
  resolveCname: jest.fn(),
  resolve4: jest.fn(),
  resolve6: jest.fn(),
}
jest.mock('node:dns/promises', () => ({ Resolver: jest.fn().mockImplementation(() => resolver) }))

describe('public DNS proof', () => {
  const dns = new CustomDomainDnsService({
    getOrThrow: () => ({ trafficHost: 'custom.platform.com', edgeIps: ['192.0.2.1'] }),
  } as never)
  beforeEach(() => {
    jest.clearAllMocks()
    resolver.resolveTxt.mockResolvedValue([['boxlite-verification=', 'proof']])
    resolver.resolveCname.mockResolvedValue(['custom.platform.com.'])
    resolver.resolve4.mockResolvedValue(['192.0.2.1'])
    resolver.resolve6.mockRejectedValue({ code: 'ENODATA' })
  })
  it('requires this configuration TXT and the fixed traffic endpoint', async () => {
    await expect(dns.verify('app.example.com', 'proof')).resolves.toBeUndefined()
    expect(resolver.resolveTxt).toHaveBeenCalledWith('_boxlite-verification.app.example.com')
    expect(resolver.setServers).toHaveBeenCalledWith(['8.8.8.8', '1.1.1.1'])
    expect(resolver.cancel).toHaveBeenCalled()
  })
  it('rejects another configuration challenge before checking traffic', async () => {
    await expect(dns.verify('app.example.com', 'other')).rejects.toMatchObject({
      code: 'ownership_txt_mismatch',
      invalidateDns: true,
    })
    expect(resolver.resolveCname).not.toHaveBeenCalled()
  })
  it('bounds CNAME cycles and rejects extra IPv6 traffic', async () => {
    resolver.resolveCname.mockResolvedValue(['app.example.com'])
    await expect(dns.verify('app.example.com', 'proof')).rejects.toMatchObject({ code: 'traffic_cname_mismatch' })
    resolver.resolveCname.mockResolvedValue(['custom.platform.com.'])
    resolver.resolve6.mockResolvedValue(['2001:db8::bad'])
    await expect(dns.verify('app.example.com', 'proof')).rejects.toMatchObject({ code: 'traffic_address_mismatch' })
  })
  it('distinguishes a missing proof from a resolver outage', async () => {
    resolver.resolveTxt.mockRejectedValue({ code: 'ENOTFOUND' })
    await expect(dns.verify('app.example.com', 'proof')).rejects.toMatchObject({ invalidateDns: true })
    resolver.resolveTxt.mockRejectedValue({ code: 'ETIMEOUT' })
    await expect(dns.verify('app.example.com', 'proof')).rejects.toMatchObject({
      code: 'dns_unavailable',
      invalidateDns: false,
    })
  })
})

describe('edge HTTPS proof', () => {
  const dns = new CustomDomainDnsService({
    getOrThrow: () => ['192.0.2.1', '192.0.2.2'],
  } as never)
  afterEach(() => {
    jest.useRealTimers()
    jest.resetAllMocks()
  })

  function socket(expiry: string, outcome: 'secureConnect' | 'error' | 'timeout' = 'secureConnect') {
    const value = Object.assign(new EventEmitter(), {
      getPeerCertificate: () => ({ valid_to: expiry }),
      destroy: jest.fn((error?: Error) => {
        if (error) queueMicrotask(() => value.emit('error', error))
      }),
    })
    if (outcome !== 'timeout') queueMicrotask(() => value.emit(outcome))
    return value
  }

  it('uses only fixed edge IPs with customer SNI and returns the earliest served certificate expiry', async () => {
    jest
      .mocked(connect)
      .mockImplementationOnce(() => socket('Jan 2 00:00:00 2030 GMT') as never)
      .mockImplementationOnce(() => socket('Jan 1 00:00:00 2030 GMT') as never)
    await expect(dns.verifyTls('app.example.com')).resolves.toBe('2030-01-01T00:00:00.000Z')
    expect(jest.mocked(connect).mock.calls.map(([options]) => options)).toEqual([
      { host: '192.0.2.1', port: 443, servername: 'app.example.com', rejectUnauthorized: true },
      { host: '192.0.2.2', port: 443, servername: 'app.example.com', rejectUnauthorized: true },
    ])
  })

  it('does not publish HTTPS readiness when any entry rejects certificate validation', async () => {
    jest
      .mocked(connect)
      .mockImplementationOnce(() => socket('Jan 2 00:00:00 2030 GMT') as never)
      .mockImplementationOnce(() => socket('', 'error') as never)
    await expect(dns.verifyTls('app.example.com')).rejects.toMatchObject({ code: 'https_not_ready' })
  })

  it('destroys a stalled connection at the bounded probe deadline', async () => {
    jest.useFakeTimers()
    const stalled = socket('', 'timeout')
    jest.mocked(connect).mockReturnValue(stalled as never)
    const result = expect(dns.verifyTls('app.example.com')).rejects.toMatchObject({ code: 'https_not_ready' })
    await jest.advanceTimersByTimeAsync(5000)
    await result
    expect(stalled.destroy).toHaveBeenCalled()
  })
})
