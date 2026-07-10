/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BillingApiClient } from '@/billing-api/billingApiClient'
import { DashboardConfig } from '@/types/DashboardConfig'
import {
  Configuration as AnalyticsConfiguration,
  TelemetryApi as AnalyticsTelemetryApi,
  UsageApi as AnalyticsUsageApi,
} from '@boxlite-ai/analytics-api-client'
import {
  ApiKeysApi,
  AuditApi,
  Configuration,
  OrganizationsApi,
  RegionsApi,
  RunnersApi,
  BoxApi,
  UsersApi,
  VolumesApi,
  WebhooksApi,
} from '@boxlite-ai/api-client'
import axios, { AxiosError } from 'axios'
import { BoxliteError } from './errors'

// A burst of in-flight requests can all 401 at once when the access token goes
// invalid; this in-page guard ensures at most one re-login redirect per page
// load. It is reset if onUnauthorized throws (a failed handler must not wedge
// recovery) and is naturally cleared when signinRedirect reloads the page.
let isHandlingUnauthorized = false

// Survives the full-page reload signinRedirect triggers, so a first stale-token
// 401 (recover silently) is distinguishable from one that persists *after* a
// re-auth already happened this session (revoked user / wrong audience / backend
// auth bug). Without a cross-reload marker a fresh-but-still-rejected token would
// bounce to login forever. sessionStorage scopes it to this tab.
const REAUTH_ATTEMPTED_KEY = 'boxlite.reauth-attempted'

function reauthAlreadyAttempted(): boolean {
  try {
    return window.sessionStorage.getItem(REAUTH_ATTEMPTED_KEY) !== null
  } catch {
    // sessionStorage can be unavailable (privacy mode, sandboxed iframe). Treat
    // as "not attempted" so we still try recovery once.
    return false
  }
}

function markReauthAttempted(): void {
  try {
    window.sessionStorage.setItem(REAUTH_ATTEMPTED_KEY, '1')
  } catch {
    // best-effort; see reauthAlreadyAttempted
  }
}

function clearReauthAttempted(): void {
  try {
    window.sessionStorage.removeItem(REAUTH_ATTEMPTED_KEY)
  } catch {
    // best-effort; see reauthAlreadyAttempted
  }
}

export class ApiClient {
  private config: Configuration
  private onUnauthorized?: () => Promise<void> | void
  private _boxApi: BoxApi
  private _userApi: UsersApi
  private _apiKeyApi: ApiKeysApi
  private _organizationsApi: OrganizationsApi
  private _billingApi: BillingApiClient
  private _volumeApi: VolumesApi
  private _auditApi: AuditApi
  private _regionsApi: RegionsApi
  private _runnersApi: RunnersApi
  private _webhooksApi: WebhooksApi
  private _analyticsUsageApi: AnalyticsUsageApi | null
  private _analyticsTelemetryApi: AnalyticsTelemetryApi | null

  constructor(config: DashboardConfig, accessToken: string, onUnauthorized?: () => Promise<void> | void) {
    this.onUnauthorized = onUnauthorized
    this.config = new Configuration({
      basePath: config.apiUrl,
      accessToken: accessToken,
    })

    const axiosInstance = axios.create()
    axiosInstance.interceptors.request.use((request) => {
      request.headers?.delete?.('User-Agent')
      if (request.headers) {
        delete (request.headers as Record<string, unknown>)['User-Agent']
      }
      return request
    })
    axiosInstance.interceptors.response.use(
      (response) => {
        // A request succeeded → the token is good again; clear the cross-reload
        // marker so a future stale token still gets its one silent recovery.
        clearReauthAttempted()
        return response
      },
      (error) => {
        // A 401 means the access token is no longer accepted — it expired, or
        // (the common case in the local Dex stack) it was signed by a key that
        // rotated when the Dex box was recreated. oidc-client-ts only tracks
        // local expiry, so it still believes the user is signed in and keeps
        // replaying the dead token on every reload. Drop the session and bounce
        // to a fresh login instead of a dead-end "Unauthorized" screen.
        if (error?.response?.status === 401 && this.onUnauthorized) {
          return this.handleUnauthorized(error)
        }

        let errorMessage: string

        if (error instanceof AxiosError && error.message.includes('timeout of')) {
          errorMessage = 'Operation timed out'
        } else {
          errorMessage = error.response?.data?.message || error.response?.data || error.message || String(error)
        }

        throw BoxliteError.fromString(String(errorMessage), { cause: error instanceof Error ? error : undefined })
      },
    )

    // Initialize APIs
    this._boxApi = new BoxApi(this.config, undefined, axiosInstance)
    this._userApi = new UsersApi(this.config, undefined, axiosInstance)
    this._apiKeyApi = new ApiKeysApi(this.config, undefined, axiosInstance)
    this._organizationsApi = new OrganizationsApi(this.config, undefined, axiosInstance)
    this._billingApi = new BillingApiClient(
      config.billingApiUrl || config.apiUrl,
      accessToken,
      config.apiUrl,
      this.onUnauthorized ? (error) => this.handleUnauthorized(error) : undefined,
    )
    this._volumeApi = new VolumesApi(this.config, undefined, axiosInstance)
    this._auditApi = new AuditApi(this.config, undefined, axiosInstance)
    this._regionsApi = new RegionsApi(this.config, undefined, axiosInstance)
    this._runnersApi = new RunnersApi(this.config, undefined, axiosInstance)
    this._webhooksApi = new WebhooksApi(this.config, undefined, axiosInstance)

    if (config.analyticsApiUrl) {
      const analyticsConfig = new AnalyticsConfiguration({
        basePath: config.analyticsApiUrl,
        accessToken: accessToken,
        baseOptions: {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      })
      this._analyticsUsageApi = new AnalyticsUsageApi(analyticsConfig, undefined, axiosInstance)
      this._analyticsTelemetryApi = new AnalyticsTelemetryApi(analyticsConfig, undefined, axiosInstance)
    } else {
      this._analyticsUsageApi = null
      this._analyticsTelemetryApi = null
    }
  }

  // Recovery is bounded to ONE re-login attempt per session: the first 401
  // drops the session and bounces to a fresh login (suppressing the error so
  // the user sees a loading state, not a dead-end screen); a 401 that persists
  // *after* that re-auth is surfaced as an error instead of bouncing forever.
  private async handleUnauthorized(error: unknown): Promise<never> {
    // De-dupe a concurrent 401 burst: only the first drives recovery, the rest
    // suspend on the in-flight redirect. Checked BEFORE the cross-reload marker
    // so a second concurrent 401 isn't misread as a failed post-reauth attempt.
    if (isHandlingUnauthorized) {
      return new Promise<never>(() => {})
    }

    if (reauthAlreadyAttempted()) {
      // We already sent the user through a fresh login this session and the new
      // token is still rejected (revoked user / wrong audience / backend bug).
      // Bouncing again would loop forever, so surface the failure.
      throw BoxliteError.fromString('Authentication failed after re-login. Please sign in again.', {
        cause: error instanceof Error ? error : undefined,
      })
    }

    isHandlingUnauthorized = true
    markReauthAttempted()
    try {
      // onUnauthorized clears the OIDC user; ApiProvider's effect then runs
      // signinRedirect, which navigates the page away. Awaited so a failed
      // start (e.g. a rejecting removeUser) surfaces an error instead of
      // hanging forever on the suspend below.
      await this.onUnauthorized?.()
    } catch (handlerError) {
      isHandlingUnauthorized = false
      clearReauthAttempted()
      throw BoxliteError.fromString('Failed to start re-authentication.', {
        cause: handlerError instanceof Error ? handlerError : undefined,
      })
    }

    // Suspend the caller (never-settling promise) so it shows the loading
    // state, not an error, while the redirect navigates the page away. Reached
    // only on a successfully-started re-auth.
    return new Promise<never>(() => {})
  }

  public setAccessToken(accessToken: string) {
    this.config.accessToken = accessToken
  }

  public get boxApi() {
    return this._boxApi
  }

  public get userApi() {
    return this._userApi
  }

  public get apiKeyApi() {
    return this._apiKeyApi
  }

  public get organizationsApi() {
    return this._organizationsApi
  }

  public get billingApi() {
    return this._billingApi
  }

  public get volumeApi() {
    return this._volumeApi
  }

  public get auditApi() {
    return this._auditApi
  }

  public get regionsApi() {
    return this._regionsApi
  }

  public get runnersApi() {
    return this._runnersApi
  }

  public get webhooksApi() {
    return this._webhooksApi
  }

  public get analyticsUsageApi() {
    return this._analyticsUsageApi
  }

  public get analyticsTelemetryApi() {
    return this._analyticsTelemetryApi
  }

  public async webhookRequest(method: string, url: string, data?: any) {
    // Use the existing axios instance that's already configured with interceptors
    const axiosInstance = axios.create({
      baseURL: this.config.basePath,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
      },
    })

    return axiosInstance.request({
      method,
      url,
      data,
    })
  }

  public get axiosInstance() {
    return axios.create({
      baseURL: this.config.basePath,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
      },
    })
  }
}
