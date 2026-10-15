/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ServiceUnavailableException } from '@nestjs/common'
import { promises as dns } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { BadRequestError } from '../../exceptions/bad-request.exception'

/**
 * Where no public registry can be: inside a deployment, or not routable on the
 * internet at all. A resolver that answers with benchmarking or reserved space
 * is broken or redirecting; either way the pull would not reach the registry
 * the ref named.
 */
const NON_PUBLIC = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], // this host's network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, handed out inside clouds
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, home of the metadata endpoint
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking, which fake-IP DNS proxies answer with
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast included
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local, deprecated but still answered
  ['ff00::', 8], // multicast
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6')
}

/** The eight 16-bit groups of an IPv6 address, a trailing dotted quad included. */
function ipv6Groups(address: string): number[] {
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address)
  const text = quad
    ? `${address.slice(0, quad.index)}${((Number(quad[1]) << 8) | Number(quad[2])).toString(16)}:${((Number(quad[3]) << 8) | Number(quad[4])).toString(16)}`
    : address
  const groups = (part: string) => (part ? part.split(':').map((group) => parseInt(group, 16)) : [])
  const [head, tail] = text.split('::')
  if (tail === undefined) {
    return groups(head)
  }
  const left = groups(head)
  const right = groups(tail)
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right]
}

/** Whether no public registry can be at `address`, an IPv4 or IPv6 literal. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    return NON_PUBLIC.check(address, 'ipv4')
  }
  if (family !== 6) {
    return true
  }
  if (NON_PUBLIC.check(address, 'ipv6')) {
    return true
  }
  // An IPv4 address in IPv6 clothing is the same address: mapped, compatible,
  // the NAT64 prefixes a DNS64 resolver synthesizes from an A record
  // (`64:ff9b::a9fe:a9fe` is the metadata endpoint), and 6to4.
  const groups = ipv6Groups(address)
  const ipv4 = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
  const zero = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0)
  if (zero(0, 5) && (groups[5] === 0 || groups[5] === 0xffff)) {
    return isNonPublicAddress(ipv4(groups[6], groups[7]))
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && (zero(2, 6) || groups[2] === 1)) {
    return isNonPublicAddress(ipv4(groups[6], groups[7]))
  }
  if (groups[0] === 0x2002) {
    return isNonPublicAddress(ipv4(groups[1], groups[2]))
  }
  return false
}

/** The host part of `host[:port]`, with an IPv6 literal's brackets removed. */
function registryHostname(host: string): string {
  if (host.startsWith('[')) {
    return host.slice(1, host.indexOf(']'))
  }
  return isIP(host) ? host : host.replace(/:\d+$/, '')
}

/**
 * Refuse a registry name that resolves inside the deployment.
 *
 * The allowlist is by name, and a name can point anywhere: whoever controls DNS
 * for an allowed host could aim a runner's pull at the metadata endpoint or at a
 * neighbour's service. A host written as an address, or `localhost`, is not
 * resolved: the allowlist already decided it, and an operator who lists
 * `127.0.0.1:25000` for the local stack means it.
 *
 * This resolves from the API, and the runner resolves again when it connects,
 * so a resolver that answers differently each time is not caught; refusing a
 * name whose DNS consistently answers inside the deployment is what this buys.
 * A failed lookup refuses too: the API cannot vouch for a name it cannot resolve.
 */
export async function assertRegistryResolvesPublic(host: string): Promise<void> {
  const hostname = registryHostname(host)
  if (isIP(hostname) || hostname === 'localhost') {
    return
  }

  let answers: { address: string }[]
  try {
    answers = await dns.lookup(hostname, { all: true, verbatim: true })
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? String(error)
    throw new ServiceUnavailableException(`Image registry host '${host}' could not be resolved: ${reason}`)
  }
  const inside = answers.find(({ address }) => isNonPublicAddress(address))
  if (inside) {
    throw new BadRequestError(
      `Image registry host '${host}' resolves to ${inside.address}, inside the deployment, and cannot be used`,
    )
  }
}
