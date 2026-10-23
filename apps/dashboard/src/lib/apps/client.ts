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

// X-BoxLite-Console proves a write comes from the console itself (the control plane refuses writes without it).
export const appsClient = axios.create({
  baseURL: appsApiUrl(),
  withCredentials: true,
  timeout: 60_000,
  headers: { 'X-BoxLite-Console': '1' },
})

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
        const next = forPeople(e.next)
        throw BoxliteError.fromString(next ? `${e.message}. ${next}` : e.message, {
          cause: error,
          code: e.code,
        })
      }
    }
    throw error
  },
)

/**
 * The control plane writes `next` for agents as well as people. A hint that is a command to run
 * (backticks, `boxlite-app …`) means nothing in the console, so people get only plain-language hints.
 */
function forPeople(next: string | undefined): string | undefined {
  if (!next || /`|boxlite-app\b/.test(next)) return undefined
  return next.charAt(0).toUpperCase() + next.slice(1)
}

/** The control plane's words for a failed call (message, then what to do next), for inline errors. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A download through the console session (deployment source). */
export function downloadUrl(path: string): string {
  return `${appsApiUrl()}${path}`
}

/** The HTTP status behind a failed console API call, also once it became a BoxliteError. */
export function httpStatusOf(error: unknown): number | undefined {
  const cause = error instanceof Error && error.cause instanceof AxiosError ? error.cause : error
  return cause instanceof AxiosError ? cause.response?.status : undefined
}

/** The control plane's error body behind a failed call (code, message, next and any details such as `position`). */
export function errorBody(error: unknown): Record<string, unknown> | undefined {
  const cause = error instanceof Error && error.cause instanceof AxiosError ? error.cause : error
  if (!(cause instanceof AxiosError)) return undefined
  return (cause.response?.data as { error?: Record<string, unknown> } | undefined)?.error
}
