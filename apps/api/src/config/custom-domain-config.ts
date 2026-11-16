/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { isIP } from 'node:net'

/** GCP resources already attached to the default proxy; never derived from customer input. */
export function customDomainConfig(env: NodeJS.ProcessEnv = process.env) {
  const project = env.CUSTOM_DOMAIN_GCP_PROJECT?.trim() || ''
  const certificateMap = env.CUSTOM_DOMAIN_GCP_CERTIFICATE_MAP?.trim() || ''
  const proxyDomain = env.PROXY_DOMAIN?.trim().toLowerCase() || ''
  const proxyHost = /^([^:/?#@]+)(?::([0-9]+))?$/.exec(proxyDomain)
  const trafficHost = proxyHost?.[1] || ''
  const enabled = !!(project || certificateMap)
  if (
    enabled &&
    (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(certificateMap) ||
      (proxyHost?.[2] !== undefined && (Number(proxyHost[2]) < 1 || Number(proxyHost[2]) > 65535)) ||
      trafficHost.length > 253 ||
      !trafficHost.includes('.') ||
      !trafficHost.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
      isIP(trafficHost))
  )
    throw new Error(
      'Custom domains require a deployment-provided GCP project and certificate map, and a public PROXY_DOMAIN',
    )
  return { enabled, project, certificateMap, trafficHost }
}
