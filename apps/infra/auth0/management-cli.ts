// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { execFile } from 'node:child_process'

import type { Auth0BrandingGateway, BrandingTarget, JsonObject } from './universal-login.js'

const DEFAULT_AUTH0_TIMEOUT_MS = 60_000
const NOT_FOUND_PATTERN = /(?:status(?: code)?\s*[:=]?\s*404\b|HTTP(?:\/\d(?:\.\d)?)?\s+404\b|\b404 Not Found\b)/i

interface Auth0CliError extends Error {
  stderr?: string
}

export type Auth0CliExecute = (args: string[], signal?: AbortSignal) => Promise<unknown>

function executeAuth0(args: string[], signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'auth0',
      args,
      {
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
        signal,
        timeout: DEFAULT_AUTH0_TIMEOUT_MS,
        killSignal: 'SIGTERM',
      },
      (cause, stdout, stderr) => {
        if (cause) {
          const error = new Error(`Auth0 CLI ${args.slice(0, 3).join(' ')} failed: ${stderr.trim() || cause.message}`, {
            cause,
          }) as Auth0CliError
          error.stderr = stderr
          reject(error)
          return
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : {})
        } catch (cause) {
          reject(new Error(`Auth0 CLI ${args.slice(0, 3).join(' ')} returned invalid JSON`, { cause }))
        }
      },
    )
  })
}

function isNotFound(cause: unknown) {
  const error = cause as Auth0CliError
  return typeof error?.stderr === 'string' && NOT_FOUND_PATTERN.test(error.stderr)
}

function asObject(value: unknown, resource: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Auth0 returned a non-object response for ${resource}`)
  }
  return value as JsonObject
}

export class Auth0ManagementCli implements Auth0BrandingGateway {
  private readonly execute: Auth0CliExecute

  constructor({ execute = executeAuth0 }: { execute?: Auth0CliExecute } = {}) {
    this.execute = execute
  }

  async getDefaultTheme(target: BrandingTarget, signal?: AbortSignal) {
    try {
      return asObject(await this.request(target, ['api', 'get', 'branding/themes/default'], signal), 'default theme')
    } catch (cause) {
      if (isNotFound(cause)) return null
      throw cause
    }
  }

  // tenants/settings always exists, so an absent response is a real fault.
  async getTenantSettings(target: BrandingTarget, signal?: AbortSignal) {
    return asObject(await this.request(target, ['api', 'get', 'tenants/settings'], signal), 'tenant settings')
  }

  async updateTenantSettings(target: BrandingTarget, settings: JsonObject, signal?: AbortSignal) {
    await this.request(target, ['api', 'patch', 'tenants/settings', '--data', JSON.stringify(settings)], signal)
  }

  async createTheme(target: BrandingTarget, theme: JsonObject, signal?: AbortSignal) {
    await this.request(target, ['api', 'post', 'branding/themes', '--data', JSON.stringify(theme)], signal)
  }

  async updateTheme(target: BrandingTarget, themeId: string, theme: JsonObject, signal?: AbortSignal) {
    await this.request(target, ['api', 'patch', `branding/themes/${themeId}`, '--data', JSON.stringify(theme)], signal)
  }

  async getPromptText(target: BrandingTarget, prompt: string, language: string, signal?: AbortSignal) {
    const resource = `prompts/${prompt}/custom-text/${language}`
    try {
      return asObject(await this.request(target, ['api', 'get', resource], signal), resource)
    } catch (cause) {
      if (isNotFound(cause)) return {}
      throw cause
    }
  }

  async putPromptText(
    target: BrandingTarget,
    prompt: string,
    language: string,
    text: JsonObject,
    signal?: AbortSignal,
  ) {
    await this.request(
      target,
      ['api', 'put', `prompts/${prompt}/custom-text/${language}`, '--data', JSON.stringify(text)],
      signal,
    )
  }

  private request(target: BrandingTarget, args: string[], signal?: AbortSignal) {
    return this.execute([...args, '--tenant', target.auth0TenantDomain, '--no-input', '--no-color'], signal)
  }
}
