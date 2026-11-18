/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'

export type ProxyCredential = { username: string; password: string }
export type ProxyPatch = { url?: string; credential?: ProxyCredential | null }

const PROXY_NAME = /^[a-z0-9][a-z0-9-]{0,62}(?![\s\S])/
const PRINTABLE = /^[\x20-\x7e]{1,255}(?![\s\S])/
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, socks5: 1080 }

export function proxyName(value: unknown): string {
  if (typeof value !== 'string' || !PROXY_NAME.test(value)) throw new BadRequestException('Invalid proxy name')
  return value
}

function canonicalEndpoint(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    /[\\@?#%]/.test(value) ||
    [...value].some((character) => character <= ' ' || character === '\x7f')
  ) {
    throw new BadRequestException('Invalid proxy URL')
  }
  const endpoint = /^(https?|socks5):\/\/(\[[^\]]+\]|[^/:[\]]+)(?::([0-9]+))?\/?$/i.exec(value)
  if (!endpoint) throw new BadRequestException('Invalid proxy URL')
  const [, rawScheme, host, rawPort] = endpoint
  const scheme = rawScheme.toLowerCase()
  const port = rawPort === undefined ? DEFAULT_PORTS[scheme] : Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BadRequestException('Invalid proxy URL')
  // Parse each scheme's host with the same special-URL host rules and apply its own default port.
  const canonical = URL.parse(`http://${host}`)?.hostname.replace(/\.$/, '')
  if (!canonical) throw new BadRequestException('Invalid proxy URL')
  return `${scheme}://${canonical}${port === DEFAULT_PORTS[scheme] ? '' : `:${port}`}`
}

function bodyFields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new BadRequestException('Invalid proxy request fields')
  }
  return value as Record<string, unknown>
}

export function proxyPatch(value: unknown): ProxyPatch {
  const body = bodyFields(value, ['url', 'credential'])
  const url = Object.hasOwn(body, 'url') ? canonicalEndpoint(body.url) : undefined
  if (!Object.hasOwn(body, 'credential')) return { url }
  if (body.credential === null) return { url, credential: null }
  const { username, password } = bodyFields(body.credential, ['username', 'password'])
  if (typeof username !== 'string' || !PRINTABLE.test(username))
    throw new BadRequestException('Invalid credential.username')
  if (typeof password !== 'string' || !PRINTABLE.test(password))
    throw new BadRequestException('Invalid credential.password')
  return { url, credential: { username, password } }
}

export function proxyCreate(value: unknown): { name: string; url: string; credential?: ProxyCredential | null } {
  const { name, ...body } = bodyFields(value, ['name', 'url', 'credential'])
  const { url, credential } = proxyPatch(body)
  if (!url) throw new BadRequestException('Invalid proxy URL')
  return { name: proxyName(name), url, credential }
}

export function validateProxyCredential(url: string, credential: ProxyCredential | null): void {
  if (credential?.username.includes(':') && !url.startsWith('socks5://')) {
    throw new BadRequestException('Invalid credential.username')
  }
}
