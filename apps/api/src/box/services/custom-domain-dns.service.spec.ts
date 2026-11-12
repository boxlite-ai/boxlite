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
    getOrThrow: () => ({ trafficHost: 'custom.platform.com' }),
  } as never)
  beforeEach(() => {
    jest.clearAllMocks()
    resolver.resolveTxt.mockResolvedValue([['boxlite-verification=', 'proof']])
    resolver.resolveCname.mockResolvedValue(['custom.platform.com.'])
    resolver.resolve4.mockResolvedValue(['192.0.2.1'])
    resolver.resolve6.mockRejectedValue({ code: 'ENODATA' })
  })
  it('reports all three record results from one confirmation, including independent failures', async () => {
    const record = { name: '_acme.app.example.com.', type: 'CNAME' as const, value: 'auth.google.test.' }
    resolver.resolveCname.mockImplementation(async (name) =>
      name === record.name ? [record.value] : ['custom.platform.com.'],
    )
    expect(await dns.checkAll('app.example.com', 'proof', record)).toEqual([
      { record: 'ownership', status: 'passed' },
      { record: 'traffic', status: 'passed' },
      { record: 'certificate', status: 'passed' },
    ])
    resolver.resolveTxt.mockResolvedValue([['wrong-proof']])
    resolver.resolveCname.mockResolvedValue(['wrong.example.com'])
    expect(await dns.checkAll('app.example.com', 'proof', record)).toEqual([
      { record: 'ownership', status: 'failed', errorCode: 'ownership_txt_mismatch' },
      { record: 'traffic', status: 'failed', errorCode: 'traffic_cname_mismatch' },
      { record: 'certificate', status: 'failed', errorCode: 'certificate_dns_mismatch' },
    ])
  })

  it('reports a DNS outage as unavailable rather than a configuration mismatch', async () => {
    resolver.resolveTxt.mockRejectedValue({ code: 'ETIMEOUT' })
    const checks = await dns.checkAll('app.example.com', 'proof', {
      name: '_acme.app.example.com.',
      type: 'CNAME',
      value: 'custom.platform.com.',
    })
    expect(checks[0]).toEqual({ record: 'ownership', status: 'unavailable', errorCode: 'dns_unavailable' })
    expect(checks.slice(1).every((check) => check.status === 'passed')).toBe(true)
  })

  it('requires this configuration TXT and the configured traffic CNAME', async () => {
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
  it('bounds CNAME cycles', async () => {
    resolver.resolveCname.mockResolvedValue(['app.example.com'])
    await expect(dns.verify('app.example.com', 'proof')).rejects.toMatchObject({ code: 'traffic_cname_mismatch' })
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

describe('certificate authorization DNS proof', () => {
  const dns = new CustomDomainDnsService({} as never)
  const record = {
    name: '_acme-challenge_project.app.example.com.',
    type: 'CNAME' as const,
    value: 'token.authorize.certificatemanager.goog.',
  }
  beforeEach(() => {
    jest.clearAllMocks()
    resolver.resolveCname.mockReset()
  })

  it('checks the exact provider record using public DNS and accepts DNS case/trailing-dot equivalence', async () => {
    resolver.resolveCname.mockResolvedValue(['TOKEN.AUTHORIZE.CERTIFICATEMANAGER.GOOG'])
    await expect(dns.verifyCertificate(record)).resolves.toBeUndefined()
    expect(resolver.resolveCname).toHaveBeenCalledWith(record.name)
    expect(resolver.setServers).toHaveBeenCalledWith(['8.8.8.8', '1.1.1.1'])
    expect(resolver.cancel).toHaveBeenCalled()
  })

  it.each([[], ['proxy.platform.com.'], [record.value, 'other.example.com.']])(
    'rejects missing, traffic and ambiguous CNAME targets: %j',
    async (...names) => {
      resolver.resolveCname.mockResolvedValue(names)
      await expect(dns.verifyCertificate(record)).rejects.toMatchObject({ code: 'certificate_dns_mismatch' })
      expect(resolver.cancel).toHaveBeenCalled()
    },
  )

  it.each(['ENODATA', 'ENOTFOUND', 'ETIMEOUT'])(
    'distinguishes %s from a mismatched certificate record',
    async (code) => {
      resolver.resolveCname.mockRejectedValue({ code })
      await expect(dns.verifyCertificate(record)).rejects.toMatchObject({
        code: code === 'ETIMEOUT' ? 'dns_unavailable' : 'certificate_dns_mismatch',
      })
      expect(resolver.cancel).toHaveBeenCalled()
    },
  )
})

describe('edge HTTPS proof', () => {
  beforeEach(() => {
    resolver.resolve4.mockResolvedValue(['192.0.2.1', '192.0.2.2'])
    resolver.resolve6.mockRejectedValue({ code: 'ENODATA' })
  })
  const dns = new CustomDomainDnsService({
    getOrThrow: () => 'custom.platform.com',
  } as never)
  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
    jest.mocked(connect).mockReset()
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

  it('uses the platform hostname addresses with customer SNI and returns the earliest served certificate expiry', async () => {
    jest
      .mocked(connect)
      .mockImplementationOnce(() => socket('Jan 2 00:00:00 2030 GMT') as never)
      .mockImplementationOnce(() => socket('Jan 1 00:00:00 2030 GMT') as never)
    await expect(dns.verifyTls('app.example.com')).resolves.toBe('2030-01-01T00:00:00.000Z')
    expect(resolver.resolve4).toHaveBeenCalledWith('custom.platform.com')
    expect(resolver.resolve6).toHaveBeenCalledWith('custom.platform.com')
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
