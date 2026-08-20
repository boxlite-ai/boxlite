// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import {
  brandingThemeArgs,
  defaultThemeArgs,
  isAuth0ApiNotFound,
  prepareAuth0Branding,
  validatePublishedAssetBody,
  validatePublishedAssetMetadata,
} from './auth0.js'

const DEFAULT_ASSET_TIMEOUT_MS = 15_000
const DEFAULT_MAX_ASSET_BYTES = 5 * 1024 * 1024

interface Auth0BrandingDependencies {
  fetchAsset?: (url: string, init: RequestInit) => Promise<Response>
  read: (args: string[]) => any
  write: (args: string[]) => void
  assetTimeoutMs?: number
  maxAssetBytes?: number
}

interface Auth0BrandingInput {
  theme: any
  template: string
  customText: any
  auth0Origin: string
}

async function responseBodyLength(response: Response, url: string, maxAssetBytes: number) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxAssetBytes) {
    await response.body?.cancel()
    throw new Error(`the Universal Login asset ${url} exceeds the ${maxAssetBytes}-byte download limit`)
  }
  if (!response.body) return 0

  const reader = response.body.getReader()
  let bodyLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bodyLength += value.byteLength
      if (bodyLength > maxAssetBytes) {
        await reader.cancel()
        throw new Error(`the Universal Login asset ${url} exceeds the ${maxAssetBytes}-byte download limit`)
      }
    }
  } finally {
    reader.releaseLock()
  }
  return bodyLength
}

/** Applies one fully validated branding plan, with every remote probe completed before the first write. */
export class Auth0BrandingDeployer {
  private readonly fetchAsset: (url: string, init: RequestInit) => Promise<Response>
  private readonly read: (args: string[]) => any
  private readonly write: (args: string[]) => void
  private readonly assetTimeoutMs: number
  private readonly maxAssetBytes: number

  constructor({
    fetchAsset = fetch,
    read,
    write,
    assetTimeoutMs = DEFAULT_ASSET_TIMEOUT_MS,
    maxAssetBytes = DEFAULT_MAX_ASSET_BYTES,
  }: Auth0BrandingDependencies) {
    this.fetchAsset = fetchAsset
    this.read = read
    this.write = write
    this.assetTimeoutMs = assetTimeoutMs
    this.maxAssetBytes = maxAssetBytes
  }

  async apply({ theme, template, customText, auth0Origin }: Auth0BrandingInput) {
    const plan = prepareAuth0Branding({ theme, template, customText })
    for (const url of plan.assetUrls) await this.requirePublishedAsset(url, auth0Origin)

    let themeId: string | undefined
    let themeCreated = false
    try {
      themeId = this.read(defaultThemeArgs()).themeId
      if (typeof themeId !== 'string' || !themeId.trim()) {
        throw new Error('Auth0 returned a default theme without a themeId')
      }
    } catch (cause) {
      if (!isAuth0ApiNotFound(cause)) throw cause
      themeCreated = true
    }

    const writes = [
      brandingThemeArgs({ themeId, theme: plan.theme }),
      plan.templateArgs,
      ...plan.customTextArgs,
    ]
    for (const args of writes) this.write(args)
    return { themeCreated, customTextCount: plan.customTextArgs.length }
  }

  private async requirePublishedAsset(url: string, auth0Origin: string) {
    let response
    try {
      response = await this.fetchAsset(url, {
        method: 'GET',
        redirect: 'error',
        headers: { Origin: auth0Origin },
        signal: AbortSignal.timeout(this.assetTimeoutMs),
      })
    } catch (cause) {
      throw new Error(`could not reach the Universal Login asset ${url}`, { cause })
    }

    try {
      validatePublishedAssetMetadata({
        url,
        status: response.status,
        allowOrigin: response.headers.get('access-control-allow-origin'),
        auth0Origin,
      })
    } catch (cause) {
      await response.body?.cancel()
      throw cause
    }
    const bodyLength = await responseBodyLength(response, url, this.maxAssetBytes)
    validatePublishedAssetBody({ url, bodyLength })
  }
}
