/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
export interface BoxLitePrincipal {
  sub: string
  principal_type: 'user' | 'service_account'
  path_prefix: string
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export class BoxLiteRequestError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly uncertain: boolean,
  ) {
    super('BoxLite request failed')
  }
}

/** Credential stays on its configured origin. Errors never contain upstream bodies or secrets. */
export class BoxLiteHttp {
  readonly #key: string
  readonly root: string
  readonly principal: BoxLitePrincipal
  private constructor(endpoint: string, key: string, principal: BoxLitePrincipal) {
    this.root = endpoint
    this.#key = key
    this.principal = Object.freeze({ ...principal })
    Object.freeze(this)
  }
  static async connect(endpoint: string, key: string): Promise<BoxLiteHttp> {
    const url = new URL(endpoint)
    if (
      !key ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) ||
      !['/', '/v1', '/v1/'].includes(url.pathname)
    )
      throw new Error('BoxLite requires an HTTPS API origin (HTTP loopback is allowed)')
    const root = url.origin + '/v1',
      unbound = new BoxLiteHttp(root, key, { sub: '', principal_type: 'service_account', path_prefix: '' })
    const principal = unbound.decodePrincipal(await unbound.request('GET', '/me', undefined, undefined, false))
    return new BoxLiteHttp(root, key, principal)
  }
  private decodePrincipal(value: unknown): BoxLitePrincipal {
    if (
      !object(value) ||
      typeof value.sub !== 'string' ||
      value.sub.length === 0 ||
      !['user', 'service_account'].includes(value.principal_type as string) ||
      typeof value.path_prefix !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.path_prefix)
    )
      throw new Error('Invalid BoxLite principal')
    return {
      sub: value.sub,
      principal_type: value.principal_type as BoxLitePrincipal['principal_type'],
      path_prefix: value.path_prefix,
    }
  }
  async verify(): Promise<void> {
    const actual = this.decodePrincipal(await this.request('GET', '/me', undefined, undefined, false))
    if (JSON.stringify(actual) !== JSON.stringify(this.principal)) throw new Error('Original BoxLite principal changed')
  }
  async request(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    route: string,
    payload?: unknown,
    signal?: AbortSignal,
    scoped = true,
  ): Promise<unknown> {
    if (!route.startsWith('/') || route.startsWith('//') || route.includes('\\') || route.includes('#'))
      throw new Error('Invalid BoxLite route')
    const body =
      payload instanceof Uint8Array
        ? new Uint8Array(payload)
        : payload === undefined
          ? undefined
          : JSON.stringify(payload)
    let status: number | undefined
    try {
      const response = await fetch(
        this.root + (scoped ? '/' + encodeURIComponent(this.principal.path_prefix) : '') + route,
        {
          method,
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
          headers: {
            Authorization: 'Bearer ' + this.#key,
            'Content-Type': payload instanceof Uint8Array ? 'application/x-tar' : 'application/json',
          },
          body,
        },
      )
      status = response.status
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('BoxLite HTTP denial')
      }
      if (method === 'PUT' && response.status !== 204) {
        await response.body?.cancel()
        throw new Error('JIT upload was not acknowledged')
      }
      if (response.status === 204 || method === 'DELETE' || route.endsWith('/stop')) {
        await response.body?.cancel()
        return undefined
      }
      if (!response.body) throw new Error('Missing BoxLite response')
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 4194304) {
            await reader.cancel()
            throw new Error('BoxLite response limit')
          }
          chunks.push(chunk.value)
        }
      } finally {
        reader.releaseLock()
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new BoxLiteRequestError(
        status,
        method !== 'GET' &&
          (status === undefined || status === 408 || status >= 500 || (status >= 200 && status < 300)),
      )
    }
  }
  toJSON(): never {
    throw new Error('BoxLite credentials are memory-only')
  }
}
