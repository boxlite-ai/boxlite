/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ServiceUnavailableException } from '@nestjs/common'
import { promises as dns } from 'node:dns'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { assertRegistryResolvesPublic, isNonPublicAddress } from './registry-address.util'

describe('isNonPublicAddress', () => {
  // The class the check exists for: the allowlist is by name, and a name can be
  // pointed at the metadata endpoint or at a neighbour.
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '203.0.113.1',
    '0.1.2.3',
    '224.0.0.1',
    '240.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    // IPv6 space that is documentation or local-use translation, never a registry.
    '2001:db8::1',
    '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff',
    '64:ff9b:1::808:808',
    '64:ff9b:1:ffff:ffff:ffff:ffff:ffff',
    // The same IPv4 address in each of the shapes IPv6 carries it.
    '::ffff:169.254.169.254',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    '::169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::a9fe:a9fe',
    '2002:a9fe:a9fe::',
    // Not an address at all: a resolver answer this check cannot vouch for.
    'not-an-address',
  ])('refuses %s', (address) => {
    expect(isNonPublicAddress(address)).toBe(true)
  })

  // A check that refuses everything protects nothing; it just stops the product.
  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '172.32.0.1',
    '100.128.0.1',
    '99.255.255.255',
    '198.20.0.1',
    '192.0.1.1',
    '64:ff9b::808:808',
    '64:ff9b:2::0101:0101',
    '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:db9::1',
    '2606:4700:4700::1111',
    '2606:4700:4700:0:0:0:0:1111',
    '2002:0101:0101::',
  ])('keeps %s reachable', (address) => {
    expect(isNonPublicAddress(address)).toBe(false)
  })
})

describe('assertRegistryResolvesPublic', () => {
  let lookup: jest.SpyInstance

  /** Make the resolver answer `addresses` for every name. */
  function resolvesTo(...addresses: string[]): void {
    lookup.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))
  }

  beforeEach(() => {
    lookup = jest.spyOn(dns, 'lookup')
  })

  afterEach(() => {
    lookup.mockRestore()
  })

  it('admits a name that resolves to public addresses', async () => {
    resolvesTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946')
    await expect(assertRegistryResolvesPublic('registry.example.com:5000')).resolves.toBeUndefined()
    expect(lookup).toHaveBeenCalledWith('registry.example.com', { all: true, verbatim: true })
  })

  it.each(['169.254.169.254', '64:ff9b::a9fe:a9fe', '10.0.0.5'])(
    'refuses a name that resolves to %s, even beside a public answer',
    async (inside) => {
      resolvesTo('93.184.216.34', inside)
      await expect(assertRegistryResolvesPublic('quay.io')).rejects.toThrow(BadRequestError)
    },
  )

  it.each([
    ['an errno code', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })],
    ['no code', new Error('resolver gave up')],
  ])('refuses a name it cannot resolve, with %s', async (_, failure) => {
    lookup.mockRejectedValue(failure)
    await expect(assertRegistryResolvesPublic('quay.io')).rejects.toThrow(ServiceUnavailableException)
  })

  // The allowlist already decided these, and an operator who lists the local
  // stack's address means it; asking DNS would refuse what was allowed by hand.
  it.each(['127.0.0.1:25000', '[::1]:5000', '[fd00::1]', '169.254.169.254', 'localhost:5000'])(
    'takes %s as written, without resolving it',
    async (host) => {
      await expect(assertRegistryResolvesPublic(host)).resolves.toBeUndefined()
      expect(lookup).not.toHaveBeenCalled()
    },
  )
})
