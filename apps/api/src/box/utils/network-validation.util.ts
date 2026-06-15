/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */
import { isIPv4 } from 'net'

export const MAX_NETWORK_ALLOW_LIST_ENTRIES = 10

const IPV4_LIKE_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/
const HOSTNAME_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

/**
 * Validates network allow list entries accepted by the Box API/core contract:
 * exact IPv4, IPv4 CIDR, exact hostname, and wildcard hostname.
 * @param networkAllowList - Comma-separated string of network addresses
 * @returns null if valid, error message string if invalid
 */
export function validateNetworkAllowList(networkAllowList: string): void {
  const networks = networkAllowList
    .split(',')
    .map((net: string) => net.trim())
    .filter(Boolean)

  if (networks.length > MAX_NETWORK_ALLOW_LIST_ENTRIES) {
    throw new Error(`Network allow list cannot contain more than ${MAX_NETWORK_ALLOW_LIST_ENTRIES} networks`)
  }

  for (const network of networks) {
    if (!isValidNetworkAllowEntry(network)) {
      throw new Error(
        `Invalid network allow list entry: "${network}". Must be an IPv4 address, IPv4 CIDR, hostname, or wildcard hostname`,
      )
    }
  }
}

export function isValidNetworkAllowEntry(entry: string): boolean {
  const network = entry.trim()
  if (!network) {
    return false
  }

  if (isIPv4(network)) {
    return true
  }

  if (network.includes('/')) {
    const [ipAddress, prefixLength, extra] = network.split('/')
    if (extra !== undefined || !isIPv4(ipAddress) || !/^\d+$/.test(prefixLength)) {
      return false
    }

    const prefix = Number(prefixLength)
    return prefix >= 0 && prefix <= 32
  }

  if (IPV4_LIKE_PATTERN.test(network)) {
    return false
  }

  if (network.startsWith('*.')) {
    return isValidHostname(network.slice(2))
  }

  return isValidHostname(network)
}

function isValidHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253 || hostname.includes('..')) {
    return false
  }

  return hostname.split('.').every((label) => HOSTNAME_LABEL_PATTERN.test(label))
}
