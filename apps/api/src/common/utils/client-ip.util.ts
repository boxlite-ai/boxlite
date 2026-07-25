/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { IncomingMessage } from 'http'
import { BlockList, isIP } from 'net'

const trustedIngressAddresses = new BlockList()
trustedIngressAddresses.addSubnet('10.0.0.0', 8, 'ipv4')
trustedIngressAddresses.addSubnet('172.16.0.0', 12, 'ipv4')
trustedIngressAddresses.addSubnet('192.168.0.0', 16, 'ipv4')
trustedIngressAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
trustedIngressAddresses.addSubnet('169.254.0.0', 16, 'ipv4')
trustedIngressAddresses.addAddress('::1', 'ipv6')
trustedIngressAddresses.addSubnet('fc00::', 7, 'ipv6')
trustedIngressAddresses.addSubnet('fe80::', 10, 'ipv6')

type ParsedIpAddress = {
  address: string
  family: 'ipv4' | 'ipv6'
}

/**
 * Resolve the client address behind the single private ingress hop used by
 * the API deployment. The ingress appends the transport client address to
 * X-Forwarded-For, so caller-supplied entries to its left are never trusted.
 */
export function getClientIp(request: Pick<IncomingMessage, 'headers' | 'socket'>): string {
  const peer = parseIpAddress(request.socket.remoteAddress)
  if (!peer || !trustedIngressAddresses.check(peer.address, peer.family)) {
    return peer?.address ?? 'unknown'
  }

  const forwarded = request.headers['x-forwarded-for']
  const forwardedValue = Array.isArray(forwarded) ? forwarded.join(',') : forwarded
  const ingressClient = forwardedValue?.split(',').at(-1)
  return parseIpAddress(ingressClient)?.address ?? peer.address
}

/**
 * Express invokes this from the application outwards. Only the direct,
 * private transport peer is accepted as an ingress proxy.
 */
export function trustPrivateIngress(address: string, hop: number): boolean {
  const peer = parseIpAddress(address)
  return hop === 0 && Boolean(peer && trustedIngressAddresses.check(peer.address, peer.family))
}

function parseIpAddress(value: string | undefined): ParsedIpAddress | null {
  if (!value) {
    return null
  }

  let address = value.trim()
  const bracketedIpv6 = address.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketedIpv6) {
    address = bracketedIpv6[1]
  } else {
    const ipv4WithPort = address.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/)
    if (ipv4WithPort) {
      address = ipv4WithPort[1]
    }
  }

  address = address.replace(/%.+$/, '')
  const mappedIpv4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mappedIpv4) {
    address = mappedIpv4[1]
  }

  const version = isIP(address)
  if (version === 4) {
    return { address, family: 'ipv4' }
  }
  if (version === 6) {
    return { address, family: 'ipv6' }
  }
  return null
}
