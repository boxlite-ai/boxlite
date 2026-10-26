/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

const sendMail = jest.fn(async () => undefined)
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail }) }))
// Production bundles templates beside main.js; tests render the same source assets.
jest.mock('ejs', () => {
  const { renderFile } = jest.requireActual('ejs')
  const { basename, resolve } = jest.requireActual('path')
  return {
    renderFile: (template: string, data: unknown) =>
      renderFile(resolve(__dirname, '../../assets/templates', basename(template)), data),
  }
})

import { EmailService } from './email.service'
import { OrganizationInvitationCreatedEvent } from '../../organization/events/organization-invitation-created.event'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const branding = JSON.parse(readFileSync(resolve(__dirname, '../../../../infra/auth0/branding/tenant.json'), 'utf8'))

async function invitationHtml(dashboardUrl: string): Promise<string> {
  const service = new EmailService({
    host: 'smtp.example.com',
    port: 587,
    from: 'noreply@example.com',
    dashboardUrl,
  } as never)

  await service.handleOrganizationInvitationCreated(
    new OrganizationInvitationCreatedEvent(
      'Acme',
      'owner@example.com',
      'invitee@example.com',
      'inv-1',
      new Date('2026-10-05T12:34:56.000Z'),
    ),
  )

  const [message] = sendMail.mock.calls[0] as unknown as [{ html: string }]
  return message.html
}

describe('EmailService invitation email', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each(['https://console.example.com', 'https://console.example.com/'])(
    'links to the invitations page under the dashboard router from %s',
    async (dashboardUrl) => {
      const html = await invitationHtml(dashboardUrl)
      expect(html).toContain('href="https://console.example.com/dashboard/user/invitations?id=inv-1"')
      expect(html).toMatch(/12:34:56.*UTC/)
    },
  )

  it.each([
    ['https://dev.example.com', 'https://dev.example.com'],
    ['https://app.example.com/', 'https://app.example.com'],
  ])('renders the shared wordmark without distortion for %s', async (dashboardUrl, origin) => {
    const html = await invitationHtml(dashboardUrl)
    const logo = html.match(/<img\b[^>]*alt="BoxLite logo"[^>]*>/)?.[0]
    expect(logo).toContain(`src="${origin}${branding.picture_url}"`)
    expect(logo).toContain('height="32"')
    expect(logo).toContain('width:auto')
    expect(logo).toContain('height:32px')
  })

  it('links the invitation logo to an existing dashboard asset', async () => {
    const html = await invitationHtml('https://console.example.com')
    const logo = html.match(/<img\b[^>]*alt="BoxLite logo"[^>]*>/)?.[0]
    const src = logo?.match(/src="([^"]+)"/)?.[1]
    expect(src).toBeDefined()
    const assetPath = new URL(src!).pathname
    expect(existsSync(resolve(__dirname, '../../../../dashboard/public', `.${assetPath}`))).toBe(true)
  })
})
