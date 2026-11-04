/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { isIP } from 'node:net'

/** GCP resources already attached to the default proxy; never derived from customer input. */
export function customDomainConfig(env: NodeJS.ProcessEnv = process.env) {
  const project = env.CUSTOM_DOMAIN_GCP_PROJECT?.trim() || ''
  const certificateMap = env.CUSTOM_DOMAIN_GCP_CERTIFICATE_MAP?.trim() || ''
  const trafficHost = env.CUSTOM_DOMAIN_TRAFFIC_HOST?.trim().toLowerCase() || ''
  const edgeIps = (env.CUSTOM_DOMAIN_EDGE_IPS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const enabled = !!(project || certificateMap || trafficHost || edgeIps.length)
  if (
    enabled &&
    (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(certificateMap) ||
      trafficHost.length > 253 ||
      !trafficHost.includes('.') ||
      !trafficHost.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
      isIP(trafficHost) ||
      !edgeIps.length ||
      edgeIps.length > 4 ||
      edgeIps.some((ip) => !isIP(ip)))
  )
    throw new Error('Custom domains require a GCP project, certificate map, traffic hostname and fixed edge IPs')
  const reservedSuffixes = (env.CUSTOM_DOMAIN_RESERVED_SUFFIXES ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  return { enabled, project, certificateMap, trafficHost, edgeIps, reservedSuffixes }
}
