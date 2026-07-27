import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright-core'

const DEFAULT_VIEWPORT = { width: 1440, height: 1000 }
const DEFAULT_TIMEOUT_MS = 20_000

export class BillingE2ESession {
  static async launch(options = {}) {
    const environment = options.environment ?? process.env
    const dashboardUrl = stripTrailingSlash(
      options.dashboardUrl ?? environment.BOXLITE_E2E_BASE_URL ?? 'http://localhost:3000',
    )
    const artifactsDir = options.artifactsDir
    if (!artifactsDir) throw new Error('BillingE2ESession requires an artifactsDir')

    await fs.mkdir(artifactsDir, { recursive: true })
    const executablePath = await findChromeExecutable({
      environment,
      chromiumApi: options.chromiumApi ?? chromium,
    })

    let browser
    try {
      browser = await (options.chromiumApi ?? chromium).launch({
        headless: options.headless ?? environment.HEADLESS !== 'false',
        executablePath,
      })
    } catch (error) {
      throw new Error(`Could not launch Billing E2E browser at ${executablePath}: ${safeMessage(error)}`)
    }

    try {
      const context = await browser.newContext({
        viewport: options.viewport ?? DEFAULT_VIEWPORT,
      })
      const page = await context.newPage()
      return new BillingE2ESession({
        browser,
        context,
        page,
        dashboardUrl,
        artifactsDir,
        loginEmail: options.loginEmail ?? environment.BOXLITE_E2E_LOGIN_EMAIL ?? 'admin@boxlite.dev',
        loginPassword: options.loginPassword ?? environment.BOXLITE_E2E_LOGIN_PASSWORD ?? 'password',
        timeoutMs: Number(options.timeoutMs ?? environment.BILLING_E2E_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
        environment,
      })
    } catch (error) {
      await browser.close().catch(() => {})
      throw error
    }
  }

  constructor({
    browser,
    context,
    page,
    dashboardUrl,
    artifactsDir,
    loginEmail,
    loginPassword,
    timeoutMs,
    environment,
  }) {
    this.browser = browser
    this.context = context
    this.page = page
    this.dashboardUrl = dashboardUrl
    this.artifactsDir = artifactsDir
    this.loginEmail = loginEmail
    this.loginPassword = loginPassword
    this.timeoutMs = timeoutMs
    this.environment = environment
    this.organizationId = ''
    this.authorizationHeader = ''
    this.browserErrors = []
    this.expectedHttpErrors = []
    this.externalHttpWarnings = []
    this.isClosed = false

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Billing E2E timeout must be positive, got ${timeoutMs}`)
    }

    page.setDefaultTimeout(timeoutMs)
    this.#collectBrowserDiagnostics()
  }

  get accessToken() {
    if (!this.authorizationHeader.startsWith('Bearer ')) {
      throw new Error('Dashboard did not expose an authenticated local API request')
    }
    return this.authorizationHeader.slice('Bearer '.length)
  }

  async signInAndSelectOwner() {
    await this.signIn()
    return this.selectOwnerOrganization()
  }

  async signIn() {
    await this.page.goto(`${this.dashboardUrl}/dashboard/billing`, { waitUntil: 'domcontentloaded' })
    await this.#settleAuthState()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await isVisible(this.page.locator('#login'))) {
        await this.page.locator('#login').fill(this.loginEmail)
        await this.page.locator('#password').fill(this.loginPassword)
        await this.page.locator('#submit-login').click()
        await this.#settleAuthState({ allowDashboardOrigin: true })
        continue
      }

      const grantButton = this.page.getByRole('button', { name: 'Grant Access', exact: true })
      if (await isVisible(grantButton)) {
        await grantButton.click()
        await this.#settleAuthState({ allowDashboardOrigin: true })
        continue
      }
      break
    }

    if (await isVisible(this.page.locator('#login'))) throw new Error('Dex login is still visible')
    if (await isVisible(this.page.getByRole('button', { name: 'Grant Access', exact: true }))) {
      throw new Error('Dex approval is still visible')
    }
    if (!this.page.url().startsWith(new URL(this.dashboardUrl).origin)) {
      throw new Error(`Dex sign-in did not return to the dashboard; current URL is ${this.page.url()}`)
    }
  }

  async selectOwnerOrganization() {
    await this.waitFor(
      () => Promise.resolve(Boolean(this.authorizationHeader)),
      this.timeoutMs,
      'an authenticated dashboard request',
    )
    const organizations = await this.apiJson('GET', '/organizations', { organizationId: null })
    if (!Array.isArray(organizations)) throw new Error('GET /organizations did not return an array')

    const authenticatedUserId = decodeJwtSubject(this.accessToken)
    for (const organization of organizations) {
      if (!organization || typeof organization.id !== 'string') continue
      const members = await this.apiJson('GET', `/organizations/${organization.id}/users`, {
        organizationId: null,
      })
      if (
        Array.isArray(members) &&
        members.some((member) => member?.userId === authenticatedUserId && member?.role === 'owner')
      ) {
        this.organizationId = organization.id
        await this.page.evaluate(
          (organizationId) => localStorage.setItem('SelectedOrganizationId', organizationId),
          organization.id,
        )
        await this.page.reload({ waitUntil: 'domcontentloaded' })
        await this.page.getByRole('heading', { name: 'Billing', exact: true }).waitFor()
        return organization.id
      }
    }

    throw new Error('Authenticated local user does not own an organization')
  }

  async apiJson(method, apiPath, options = {}) {
    const expectedStatuses = Array.isArray(options.expectedStatus)
      ? options.expectedStatus
      : [options.expectedStatus ?? 200]
    const response = await this.apiResponse(method, apiPath, options)
    if (!expectedStatuses.includes(response.status())) {
      const responseText = await response.text().catch(() => '')
      throw new Error(
        `${method} ${apiPath} returned ${response.status()}: ${redactSecrets(responseText, this.#secretValues()).slice(0, 2_000)}`,
      )
    }
    try {
      return await response.json()
    } catch (error) {
      throw new Error(`${method} ${apiPath} did not return JSON: ${safeMessage(error)}`)
    }
  }

  async apiResponse(method, apiPath, options = {}) {
    if (!apiPath.startsWith('/')) throw new Error(`Billing API path must start with "/": ${apiPath}`)
    const organizationId = options.organizationId === undefined ? this.organizationId || null : options.organizationId
    const headers = {
      Authorization: this.authorizationHeader || `Bearer ${this.accessToken}`,
      ...(organizationId ? { 'X-BoxLite-Organization-ID': organizationId } : {}),
      ...(options.headers ?? {}),
    }
    const requestOptions = {
      method,
      failOnStatusCode: false,
      timeout: options.timeoutMs ?? Math.max(this.timeoutMs, 120_000),
      headers,
    }
    if (options.rawBody !== undefined) requestOptions.data = options.rawBody
    else if (options.body !== undefined) requestOptions.data = options.body

    try {
      return await this.context.request.fetch(`${this.dashboardUrl}/api${apiPath}`, requestOptions)
    } catch (error) {
      throw new Error(redactSecrets(safeMessage(error), this.#secretValues()))
    }
  }

  async captureDashboardRequest({ method, apiPath, action }) {
    const expectedPath = `/api${apiPath}`
    const requestPromise = this.page.waitForRequest((request) => {
      if (request.method() !== method) return false
      return new URL(request.url()).pathname === expectedPath
    })

    await action()
    const request = await requestPromise
    const rawBody = request.postData()
    if (rawBody == null) throw new Error(`${method} ${apiPath} did not include a request body`)

    let body
    try {
      body = JSON.parse(rawBody)
    } catch (error) {
      throw new Error(`${method} ${apiPath} request body was not JSON: ${safeMessage(error)}`)
    }

    const response = await request.response()
    if (!response) throw new Error(`${method} ${apiPath} did not receive a response`)
    let responseBody = null
    const responseText = await response.text()
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText)
      } catch {
        responseBody = responseText
      }
    }

    return {
      rawBody,
      body,
      contentType: request.headers()['content-type'] ?? 'application/json',
      idempotencyKey: request.headers()['idempotency-key'] ?? '',
      status: response.status(),
      responseBody,
    }
  }

  async waitFor(predicate, timeoutMs, description, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs
    let lastError
    while (Date.now() < deadline) {
      try {
        const result = await predicate()
        if (result) return result
      } catch (error) {
        lastError = error
      }
      await delay(intervalMs)
    }
    const suffix = lastError ? `: ${redactSecrets(safeMessage(lastError), this.#secretValues())}` : ''
    throw new Error(`Timed out waiting for ${description}${suffix}`)
  }

  async assertBodyText(expectedTexts) {
    return this.waitFor(
      async () => {
        const bodyText = await this.page.locator('body').innerText()
        const normalizedBodyText = bodyText.toLowerCase()
        const missing = expectedTexts.filter((text) => !normalizedBodyText.includes(text.toLowerCase()))
        if (missing.length > 0) return false
        return true
      },
      this.timeoutMs,
      `page text: ${expectedTexts.join(', ')}`,
    )
  }

  async screenshot(fileName) {
    if (!/^[a-z0-9][a-z0-9._-]*\.png$/i.test(fileName)) {
      throw new Error(`Unsafe Billing E2E screenshot name: ${fileName}`)
    }
    await this.page.waitForLoadState('domcontentloaded').catch(() => {})
    await this.page
      .evaluate(async () => {
        if (document.fonts?.ready) await document.fonts.ready
      })
      .catch(() => {})
    const screenshotPath = path.join(this.artifactsDir, fileName)
    await this.page.screenshot({
      path: screenshotPath,
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    })
    return screenshotPath
  }

  diagnostics() {
    return {
      browserErrors: this.browserErrors.map((entry) => redactSecrets(entry, this.#secretValues())),
      expectedHttpErrors: this.expectedHttpErrors.map((entry) => redactSecrets(entry, this.#secretValues())),
      externalHttpWarnings: this.externalHttpWarnings.map((entry) => redactSecrets(entry, this.#secretValues())),
    }
  }

  assertNoBrowserErrors() {
    if (this.browserErrors.length > 0) {
      throw new Error(`Billing browser errors:\n${this.diagnostics().browserErrors.join('\n')}`)
    }
  }

  async close() {
    if (this.isClosed) return
    this.isClosed = true
    await this.browser.close()
  }

  #secretValues() {
    return [this.loginPassword, this.authorizationHeader, this.authorizationHeader.slice('Bearer '.length)].filter(
      Boolean,
    )
  }

  #collectBrowserDiagnostics() {
    this.page.on('console', (message) => {
      if (message.type() === 'error' && !isBrowserNetworkConsoleMessage(message.text())) {
        this.browserErrors.push(`console: ${message.text()}`)
      }
    })
    this.page.on('pageerror', (error) => this.browserErrors.push(`page: ${safeMessage(error)}`))
    this.page.on('response', (response) => {
      if (response.status() < 400) return
      const httpError = describeHttpError(response)
      if (this.environment.BILLING_E2E_DEBUG_HTTP === '1') {
        console.error(`[billing-e2e] ${redactSecrets(httpError, this.#secretValues())}`)
      }
      if (isExpectedAdminAccessProbe(response)) this.expectedHttpErrors.push(httpError)
      else if (isLocalUrl(response.url())) this.browserErrors.push(`http: ${httpError}`)
      else this.externalHttpWarnings.push(httpError)
    })
    this.page.on('requestfailed', (request) => {
      const failureText = request.failure()?.errorText ?? 'unknown error'
      if (failureText === 'net::ERR_ABORTED') return
      const requestError = `REQUEST FAILED ${request.method()} ${request.resourceType()} ${request.url()}: ${failureText}`
      if (isLocalUrl(request.url())) this.browserErrors.push(`network: ${requestError}`)
      else this.externalHttpWarnings.push(requestError)
    })
    this.page.on('request', (request) => {
      const authorization = request.headers().authorization
      if (authorization?.startsWith('Bearer ') && isLocalUrl(request.url())) {
        this.authorizationHeader = authorization
      }
    })
  }

  async #settleAuthState({ allowDashboardOrigin = false } = {}) {
    const dashboardOrigin = new URL(this.dashboardUrl).origin
    let dashboardSeenAt = 0
    let lastBodyText = ''

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const currentUrl = this.page.url()
      lastBodyText = await this.page
        .locator('body')
        .innerText()
        .catch(() => '')
      if (/Log in to Your Account|Grant Access|Billing|Boxes/.test(lastBodyText)) return
      if (allowDashboardOrigin && currentUrl.startsWith(dashboardOrigin)) {
        dashboardSeenAt ||= Date.now()
        if (Date.now() - dashboardSeenAt > 3_000) return
      } else {
        dashboardSeenAt = 0
      }
      await delay(250)
    }

    throw new Error(
      `Timed out waiting for dashboard or Dex state at ${this.page.url()}; body=${redactSecrets(
        lastBodyText.slice(0, 240),
        this.#secretValues(),
      )}`,
    )
  }
}

export async function findChromeExecutable({ environment = process.env, chromiumApi = chromium } = {}) {
  const configuredPath = environment.CHROME_EXECUTABLE_PATH
  if (configuredPath) {
    const resolvedPath = path.resolve(configuredPath)
    if (await isExecutable(resolvedPath)) return resolvedPath
    throw new Error(
      `CHROME_EXECUTABLE_PATH does not point to an executable file: ${resolvedPath}. ` +
        'Install Chrome/Chromium or correct CHROME_EXECUTABLE_PATH.',
    )
  }

  const homeDirectory = os.homedir()
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(homeDirectory, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ]

  let playwrightPath = ''
  try {
    playwrightPath = chromiumApi.executablePath()
  } catch {
    // The actionable error below covers an unavailable Playwright browser.
  }
  if (playwrightPath) candidates.push(playwrightPath)

  for (const candidate of [...new Set(candidates)]) {
    if (await isExecutable(candidate)) return candidate
  }

  throw new Error(
    [
      'No Chrome or Chromium executable was found for Billing E2E.',
      'Set CHROME_EXECUTABLE_PATH to an installed browser,',
      'or run `yarn playwright-core install chromium` from apps/ so playwright-core can provide one.',
      `Checked: ${candidates.join(', ')}`,
    ].join(' '),
  )
}

export function redactSecrets(value, secretValues = []) {
  let redacted = typeof value === 'string' ? value : JSON.stringify(value)
  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(\bAuthorization\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(\b(?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(\bidempotency(?:-|_)?key\s*["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1[REDACTED]')
    .replace(/("(?:idempotencyKey|idempotency-key)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/(\bBOXLITE_E2E_OIDC_TOKEN\s*=\s*)[^\s]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:code|state|token|session|client_secret)=)[^&#\s]+/gi, '$1[REDACTED]')

  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret.length >= 4) redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted
}

function decodeJwtSubject(token) {
  try {
    const segments = token.split('.')
    if (segments.length !== 3) throw new Error('expected three JWT segments')
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('JWT subject is missing')
    return payload.sub
  } catch (error) {
    throw new Error(`Could not read authenticated user from dashboard token: ${safeMessage(error)}`)
  }
}

function describeHttpError(response) {
  return `HTTP ${response.status()} ${response.request().method()} ${response.request().resourceType()} ${response.url()}`
}

function isExpectedAdminAccessProbe(response) {
  const request = response.request()
  return (
    response.status() === 403 &&
    request.method() === 'GET' &&
    request.resourceType() === 'xhr' &&
    new URL(response.url()).pathname === '/api/admin/overview'
  )
}

function isBrowserNetworkConsoleMessage(message) {
  return message.startsWith('Failed to load resource:')
}

function isLocalUrl(value) {
  try {
    const hostname = new URL(value).hostname
    return (
      hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]'
    )
  } catch {
    return false
  }
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function isExecutable(candidate) {
  try {
    await fs.access(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function isVisible(locator) {
  try {
    return await locator.isVisible()
  } catch {
    return false
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
