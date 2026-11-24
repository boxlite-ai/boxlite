import { proxyCreate, proxyName, proxyPatch, validateProxyCredential } from './proxy-registration.input'

describe('outbound proxy input', () => {
  it.each([
    ['http://EXAMPLE.COM:80/', 'http://example.com'],
    ['https://EXAMPLE.COM:80/', 'https://example.com:80'],
    ['socks5://[2001:0db8::1]:1080/', 'socks5://[2001:db8::1]'],
    ['socks5://BÜCHER.example:0080', 'socks5://xn--bcher-kva.example:80'],
  ])('canonicalizes %s', (url, canonical) => {
    expect(proxyCreate({ name: 'test', url }).url).toBe(canonical)
  })

  it.each([
    'http://proxy.example.com?',
    'http://proxy.example.com#',
    'http://@proxy.example.com',
    'http://proxy.example.com/path',
    'http://proxy.example.com:',
    'http://proxy.example.com:0',
    'http://proxy.example.com:65536',
    'http://proxy.example.com\\path',
    'socks4://proxy.example.com',
  ])('refuses %s', (url) => {
    expect(() => proxyCreate({ name: 'test', url })).toThrow('Invalid proxy URL')
  })

  it('checks ASCII bytes, final newline, and Basic username colons', () => {
    expect(() => proxyName('test\n')).toThrow('Invalid proxy name')
    const bounded = { username: 'u'.repeat(255), password: 'p'.repeat(255) }
    expect(proxyPatch({ credential: bounded }).credential).toEqual(bounded)
    for (const password of ['', 'p'.repeat(256), 'é', 'password\n']) {
      expect(() => proxyPatch({ credential: { username: 'u', password } })).toThrow('Invalid credential.password')
    }
    const credential = { username: 'user:service', password: 'password' }
    expect(() => validateProxyCredential('http://proxy.example.com', credential)).toThrow('Invalid credential.username')
    expect(() => validateProxyCredential('socks5://proxy.example.com', credential)).not.toThrow()
  })
})
