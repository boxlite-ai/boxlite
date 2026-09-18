import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

const fixture = 'http://127.0.0.1:4491'
test.beforeEach(async ({ request }) => {
  await request.post(fixture + '/__test__/identity', { data: { subject: 'browser-' + randomUUID(), verified: true } })
})

test('U01/I01: real OIDC code/PKCE round trip precedes the first coded organization request', async ({
  page,
  request,
}) => {
  const { referralCode } = await (await request.get(fixture + '/__test__/ready')).json()
  await page.goto('/register?referredCode=' + referralCode)
  await expect(page.getByLabel('Invitation code')).toHaveValue(referralCode)
  await expect(page.getByLabel('Invitation code')).toHaveAttribute('readonly', '')
  const response = page.waitForResponse(
    (response) => response.url().includes('/api/organizations?referredCode=') && response.status() === 200,
  )
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await response
  await expect
    .poll(async () => (await (await request.get(fixture + '/__test__/result')).json()).registration?.status)
    .toBe('accepted')
  const result = await (await request.get(fixture + '/__test__/result')).json()
  expect(result.observed[0]).toBe('GET /api/organizations?referredCode=' + referralCode)
  expect(await page.evaluate(() => sessionStorage.getItem('boxlite.registration'))).toBeNull()
})

test('U02/I05: direct registration has no invitation input or attribution', async ({ page, request }) => {
  await page.goto('/register')
  await expect(page.getByLabel('Invitation code')).toHaveCount(0)
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/organizations' && response.status() === 200,
  )
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await response
  const result = await (await request.get(fixture + '/__test__/result')).json()
  expect(result.registration.status).toBe('none')
  expect(result.observed[0]).toBe('GET /api/organizations')
})

for (const query of ['?referredCode=', '?referredCode=bad', '?referredCode=ABCD2345EF&referredCode=ABCD2345EF']) {
  test('U01: invalid invitation refuses authentication: ' + query, async ({ page, request }) => {
    await page.goto('/register' + query)
    await expect(page.getByRole('alert')).toContainText('invalid')
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0)
    const result = await (await request.get(fixture + '/__test__/result')).json()
    expect(result.registration).toBeNull()
    expect(result.observed).toEqual([])
  })
}

test('U04: a lost registration context stops before JIT', async ({ page, request }) => {
  await page.goto('/register?resume=1')
  await expect(page.getByRole('alert')).toContainText('missing')
  expect((await (await request.get(fixture + '/__test__/result')).json()).observed).toEqual([])
})

test('U04: expired stored context stops before authentication or JIT', async ({ page, request }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'boxlite.registration',
      JSON.stringify({
        contextId: 'expired',
        source: 'link',
        referredCode: 'ABCD2345EF',
        confirmed: true,
        createdAt: Date.now() - 86400000,
      }),
    ),
  )
  await page.goto('/register?resume=1')
  await expect(page.getByRole('alert')).toContainText('expired')
  expect((await (await request.get(fixture + '/__test__/result')).json()).observed).toEqual([])
})

test('I03: email verification preserves the link across a second OIDC round trip', async ({ page, request }) => {
  const subject = 'auth0|browser-' + randomUUID()
  await request.post(fixture + '/__test__/identity', { data: { subject, verified: false } })
  const { referralCode } = await (await request.get(fixture + '/__test__/ready')).json()
  await page.goto('/register?referredCode=' + referralCode)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Verify your email')
  const before = await page.evaluate(() => JSON.parse(sessionStorage.getItem('boxlite.registration')!))
  expect((await (await request.get(fixture + '/__test__/result')).json()).registration).toBeNull()
  await request.post(fixture + '/__test__/identity', { data: { subject, verified: true } })
  const response = page.waitForResponse(
    (response) => response.url().includes('/api/organizations?referredCode=') && response.status() === 200,
  )
  await page.getByRole('button', { name: 'I verified my email' }).click()
  await response
  const result = await (await request.get(fixture + '/__test__/result')).json()
  expect(before.referredCode).toBe(referralCode)
  expect(result.registration.status).toBe('accepted')
  expect(result.observed[0]).toBe('GET /api/organizations?referredCode=' + referralCode)
})

test('I04: finalized identity requires an explicit ordinary-login choice', async ({ page, request }) => {
  await page.goto('/register')
  const ordinary = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/organizations' && r.status() === 200)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await ordinary
  const original = (await (await request.get(fixture + '/__test__/result')).json()).registration
  await request.post(fixture + '/__test__/identity', { data: { subject: original.userId, verified: true } })
  const { referralCode } = await (await request.get(fixture + '/__test__/ready')).json()
  await page.goto('/register?referredCode=' + referralCode)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('finalized registration')
  let result = await (await request.get(fixture + '/__test__/result')).json()
  expect(result.observed.filter((url: string) => url === 'GET /api/organizations')).toEqual([])
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('boxlite.registration')!).referredCode)).toBe(
    referralCode,
  )
  const resumed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/organizations' && !new URL(r.url()).search && r.status() === 200,
  )
  await page.getByRole('button', { name: 'Continue with ordinary login', exact: true }).click()
  await resumed
  result = await (await request.get(fixture + '/__test__/result')).json()
  expect(result.registration).toEqual(original)
  expect(await page.evaluate(() => sessionStorage.getItem('boxlite.registration'))).toBeNull()
})

test('F03/F04: narrow-screen sharing supports keyboard activation and selectable clipboard fallback', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Clipboard denied for this test')
        },
      },
    }),
  )
  await page.goto('/register')
  const signedIn = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/organizations' && response.status() === 200,
  )
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await signedIn
  await page.goto('/dashboard/billing')
  const share = page.getByRole('region', { name: 'Invite friends' })
  const copy = share.getByRole('button', { name: 'Copy invitation link', exact: true })
  await expect(copy).toBeVisible()
  await copy.focus()
  await page.keyboard.press('Enter')
  const fallback = share.getByLabel('Invitation text to copy')
  await expect(fallback).toHaveValue(/^http:\/\/127\.0\.0\.1:4390\/register\?referredCode=[A-Z2-9]{10}$/)
  await fallback.focus()
  expect(
    await fallback.evaluate((element: HTMLTextAreaElement) => element.selectionEnd - element.selectionStart),
  ).toBeGreaterThan(10)
  const bounds = await share.boundingBox()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
  await share.screenshot({ path: testInfo.outputPath('sharing-narrow.png') })
})
