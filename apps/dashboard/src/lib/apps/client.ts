/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteError } from '@/api/errors'
import axios, { AxiosError } from 'axios'
import { appsApiUrl } from './feature'

// One client for the console API. The session is the control plane's HttpOnly
// console cookie, so requests carry credentials and no bearer token. Errors come
// back as {error: {code, message, next}}; they become BoxliteErrors so the usual
// toasts show the control plane's own message.

export const appsClient = axios.create({ baseURL: appsApiUrl(), withCredentials: true, timeout: 60_000 })

appsClient.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (error instanceof AxiosError) {
      const status = error.response?.status
      const body = error.response?.data as { error?: { code?: string; message?: string; next?: string } } | undefined
      if (status === 401 && body?.error?.code === 'unauthenticated') {
        const back = window.location.pathname + window.location.search
        window.location.assign(`${appsApiUrl().replace(/\/api$/, '')}/login?next=${encodeURIComponent(back)}`)
      }
      const e = body?.error
      if (e?.message) {
        throw BoxliteError.fromString(e.next ? `${e.message}. Next: ${e.next}` : e.message, {
          cause: error,
          code: e.code,
        })
      }
    }
    throw error
  },
)

/** A download through the console session (deployment source). */
export function downloadUrl(path: string): string {
  return `${appsApiUrl()}${path}`
}

/** The HTTP status behind a failed console API call, also once it became a BoxliteError. */
export function httpStatusOf(error: unknown): number | undefined {
  const cause = error instanceof Error && error.cause instanceof AxiosError ? error.cause : error
  return cause instanceof AxiosError ? cause.response?.status : undefined
}
