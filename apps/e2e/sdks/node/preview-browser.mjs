// Browser authentication uses a fresh context; no user's stored session is loaded.
import assert from 'node:assert/strict'
import { chromium } from '../../../../sdks/node/node_modules/playwright-core/index.mjs'

let input = ''
for await (const chunk of process.stdin) input += chunk
const { uri, token, marker } = JSON.parse(input)
assert.equal(new URL(uri).protocol, 'https:', 'browser acceptance requires HTTPS')
const browser = await chromium.launch({
  executablePath: process.env.BOXLITE_E2E_BROWSER_EXECUTABLE,
  headless: true,
})
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: process.env.BOXLITE_E2E_BROWSER_LOCAL_CA === '1',
    // The proxy treats HeadlessChrome as a non-browser and skips its warning.
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
  })
  const page = await context.newPage()
  const url = new URL('/browser', uri)
  url.searchParams.set('boxlite-access-token', token)
  assert.equal((await page.goto(url.href)).status(), 200)
  const warning = page.locator('form[action="/accept-boxlite-preview-warning"]')
  if (await warning.isVisible()) {
    const [response] = await Promise.all([
      page.waitForResponse((reply) => reply.url() === url.href && reply.request().isNavigationRequest()),
      warning.getByRole('button', { name: 'I Understand, Continue', exact: true }).click(),
    ])
    assert.equal(response.status(), 200, 'warning acceptance did not return the preview page')
    assert(page.url() === url.href, 'warning acceptance changed the preview URL')
    const accepted = (await context.cookies(uri)).find((cookie) => cookie.name === 'boxlite-preview-page-accepted')
    assert.equal(accepted?.value, 'true', 'browser did not store warning acceptance')
  }
  await page.waitForFunction((expected) => window.fixtureAsset === expected, marker)
  const cookies = (await context.cookies(uri)).filter((cookie) => cookie.name === '__Host-boxlite-tunnel-session')
  assert.equal(cookies.length, 1, 'browser did not store platform session')
  const session = cookies[0]
  assert(session.secure && session.httpOnly)
  assert.equal(session.sameSite, 'Lax')
  assert.equal(session.path, '/')
  assert.equal(session.domain, new URL(uri).hostname, 'session must be host-only')
  assert(!(await page.evaluate(() => document.cookie)).includes('__Host-boxlite-'))
  const echo = await page.evaluate(async () => {
    const response = await fetch('/inspect?app=kept', { headers: { Authorization: 'Bearer app-credential' } })
    if (response.status !== 200) throw new Error('cookie-authenticated fetch failed')
    return response.json()
  })
  assert.equal(echo.marker, marker)
  assert.equal(echo.path, '/inspect?app=kept')
  const fields = Object.fromEntries(Object.entries(echo.headers).map(([key, value]) => [key.toLowerCase(), value]))
  assert.equal(fields.authorization, 'Bearer app-credential')
  assert(!JSON.stringify(echo).includes(token), 'guest received tunnel token')
  assert(!String(fields.cookie).includes('__Host-boxlite-'), 'guest received platform cookie')
  assert(!String(fields.referer).includes('boxlite-access-token'), 'guest received token Referer')
  const echoed = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`wss://${location.host}/ws`)
        const timer = setTimeout(() => {
          socket.close()
          reject(new Error('browser WebSocket timed out'))
        }, 10_000)
        socket.onopen = () => socket.send('browser-ws')
        socket.onmessage = (event) => {
          clearTimeout(timer)
          resolve(event.data)
          socket.close()
        }
        socket.onerror = () => {
          clearTimeout(timer)
          reject(new Error('browser WebSocket failed'))
        }
      }),
  )
  assert.equal(echoed, `${marker}:browser-ws`)
  await page.evaluate(() => history.replaceState(null, '', '/browser'))
  assert.equal((await page.reload()).status(), 200)
  await page.waitForFunction((expected) => window.fixtureAsset === expected, marker)
  console.log('PREVIEW_BROWSER=ok')
} finally {
  await browser.close()
}
