/* Copyright 2026 BoxLite AI; SPDX-License-Identifier: AGPL-3.0 */
import { Injectable } from '@nestjs/common'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Request } from 'express'
import type { AuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationService } from '../organization/services/organization.service'

export type McpRequest = Request & { user: AuthContext }

export class McpRestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message)
  }

  result() {
    const structuredContent = {
      error: {
        source: this.status ? 'rest' : 'adapter',
        code: this.code,
        message: this.message,
        ...(this.status ? { status: this.status, details: this.details } : {}),
      },
    }
    return {
      isError: true,
      structuredContent,
      content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
    }
  }
}

@Injectable()
export class McpRest {
  private readonly context = new AsyncLocalStorage<{ request: McpRequest; signal: AbortSignal }>()

  constructor(private readonly organizations: OrganizationService) {}

  run<T>(request: McpRequest, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    return this.context.run({ request, signal }, action)
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const context = this.context.getStore()
    if (!context) throw new McpRestError('missing_context', 'An authenticated invocation is required')
    const { request } = context
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const timeout = setTimeout(cancel, 35_000)
    const signal = AbortSignal.any([context.signal, controller.signal])
    request.res?.once('close', cancel)
    try {
      const organization = await this.organizations.findDefaultForUser(request.user.userId)
      signal.throwIfAborted()
      const generated = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      // Only this API's accepted socket can choose the upstream. The generated
      // URL is a route template, never a network destination or credential source.
      const url = new URL(
        `http://127.0.0.1:${request.socket.localPort}/api/v1/${encodeURIComponent(organization.id)}${generated.pathname}${generated.search}`,
      )
      const generatedHeaders = new Headers(init?.headers)
      const headers = new Headers({ authorization: request.headers.authorization, 'content-type': 'application/json' })
      const idempotency = generatedHeaders.get('idempotency-key')
      if (idempotency) headers.set('idempotency-key', idempotency)
      const response = await fetch(url, { ...init, headers, redirect: 'error', signal })
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (reader) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > 128 * 1024)
            throw new McpRestError('response_too_large', 'REST response exceeds 128 KiB; narrow the request')
          chunks.push(value)
        }
      } finally {
        await reader?.cancel().catch(() => undefined)
        reader?.releaseLock()
      }
      const text = Buffer.concat(chunks).toString('utf8')
      let data: unknown
      try {
        data = text ? JSON.parse(text) : { status: response.status }
      } catch {
        throw new McpRestError('invalid_response', 'REST returned a non-JSON response')
      }
      if (!response.ok) {
        const message =
          typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string'
            ? data.message
            : `REST returned HTTP ${response.status}`
        throw new McpRestError('http_error', message, response.status, data)
      }
      return new Response(response.status === 204 ? null : text, {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      })
    } catch (error) {
      if (signal.aborted)
        throw new McpRestError(
          'request_cancelled',
          'REST request cancelled or exceeded its bound; the operation may have completed',
        )
      if (error instanceof McpRestError) throw error
      throw new McpRestError('request_failed', 'REST request failed; the operation may have completed')
    } finally {
      clearTimeout(timeout)
      request.res?.off('close', cancel)
    }
  }
}
